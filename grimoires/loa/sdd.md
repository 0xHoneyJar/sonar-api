---
hivemind:
  schema_version: "1.0"
  artifact_type: technical-rfc
  product_area: "sonar-api — SVM warehouse-loader lane"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "design the warehouse→collection_event supply lane + multi-collection live tail + incremental reconcile that the svm-warehouse-loader PRD requires"}
  learning_status: directionally-correct
  source: team-internal
trust_tier: operator-authored
read_state: read
confidence: 0.8
decay_class: working
last_confirmed: 2026-07-05
operator_signed: self_attested
---

# SDD — SVM Warehouse Loader (cycle: svm-warehouse-loader, r1 2026-07-05)

Traces: PRD r1 §6 FR-1..FR-6. Grounding: file:line refs verified against `origin/main` @ d108626.

## 1. Architecture

Two supply lanes converge on one content-addressed table (unchanged): warehouse loader fills the past, webhook fills the present, incremental reconcile verifies. New: `svm.sync_status` makes per-collection freshness first-class. The seam doctrine holds — `CollectionEventSource` stays the interface `[src/svm/collection-event-source.ts:51-56]`; the loader is a NEW implementation of the backfill role, not a rewrite of the seam.

```
Dune API (history) ─► WarehouseCollectionEventSource ─► CollectionEvent[] ─► upsertCollectionEvents ─► svm.collection_event
Helius webhook (live) ─► multi-collection router ────► (unchanged decode) ─────────────────┘              │
DAS snapshot (verify) ─► incremental reconcile ─► Enhanced walk (drifted mints only) ───────┘         svm.sync_status
```

## 2. Components

### 2.1 `src/svm/dune-client.ts` (new, ~120 loc)
Minimal Dune API client (no SDK dep — fetch only, mirrors repo's raw-fetch idiom `[src/svm/nft-collection-source.ts:95-108]`): `executeQuery(queryId, params)`, `pollResult(executionId)`, `fetchRows(executionId, {limit, offset})` with pagination. Auth header `X-Dune-API-Key: env DUNE_API_KEY`. Logs `executionCostCredits` per run (NFR-1). Retry/backoff mirroring `addressHistory`'s pattern `[src/svm/collection-event-source.ts:310-330]`.

### 2.2 Canonical extraction queries (created once, parameterized, committed as SQL in `src/svm/sql/`)
- `warehouse-members.sql`: members via `tokens_solana.nft where collection_mint = {{collection_mint}}`.
- `warehouse-events.sql`: `tokens_solana.transfers t join members m` with `{{from_time}}`/`{{to_time}}` bounds (partition pruning — measured 0.22cr bounded vs 18.6cr unbounded), returning `action, block_slot, block_time, tx_id, outer_instruction_index, inner_instruction_index, token_mint_address, from_owner, to_owner, outer_executing_account`.
Saved once as Dune saved-queries (ids in registry config), executed with params per run.

### 2.3 `src/svm/warehouse-loader.ts` (new, the FR-1 entrypoint)
CLI: `tsx src/svm/warehouse-loader.ts --collection <key> [--from <iso>] [--dry]`. Flow: registry resolve → cursor read (max block_time in `svm.collection_event` for key, via existing Hasura admin path `[src/svm/collection-event-writer.ts]`) → windowed extraction (30-day windows to bound result sizes) → map rows → kind mapping (2.4) → `upsertCollectionEvents` batches → sync_status write → reconcile gate (2.6) — **gate runs BEFORE the sync_status "verified" mark, and a failed gate marks `last_reconcile_result: failed`, never blocks the already-idempotent upserts** (events are facts; verification is a status).
Mapping: `instructionIndex` = per-(tx,mint) ordinal computed identically to the parser's per-mint occurrence rule `[src/svm/collection-event-source.ts:124-126]` — NOT the raw instruction index (PK convergence with webhook/Enhanced rows depends on this).

### 2.4 Kind mapping (FR-2, decision T-2)
Default ship: `action` → mint/transfer/burn 1:1. Marketplace kinds behind the EXISTING flag pattern (`SVM_EMIT_MARKETPLACE_KINDS` precedent `[collection-event-source.ts:113]`): option (a) program-ID classify from `outer_executing_account` against a curated marketplace program map (M2/Tensor/etc.) — T-2 measures (a) against the pythians fixture; if precision <99% on sale detection, fall back to (c) transfers-only + reclassify later via the #85 re-backfill pattern. Option (b) selective-Enhanced stays post-topup. **T-2 MEASURED (2026-07-05)**: program distribution committed at test/fixtures/svm-warehouse/pythians-program-distribution.json — ME-v2/MMM + Tensor/TComp custody legs cleanly separable from token-metadata plain transfers; Candy Guard mints = 3,683 = member count (cross-confirmation). DECISION: (c) for batch-1 (coarse, never wrong); (a)'s precision measurement vs Helius labels = runbook step 5.3, pre-flag-flip.

### 2.5 Multi-collection webhook (FR-3)
`collection-event-webhook.ts`: `cfg` singleton → `Map<collectionKey, {members, loadedAt, source}>` built from ALL registry entries (`COLLECTIONS` keys). Delivery routing: decoded event's mint looked up across per-collection member sets (first match; sets are disjoint by construction). `/health` emits per-collection `{members, loadedAt, source}` + existing meter block. Refresh: staggered per-collection (existing dedupe pattern `[collection-event-webhook.ts:76-85]` per key). `COLLECTION` env retained as optional single-tenant override (back-compat, deploy safety).

### 2.6 Incremental reconcile (FR-4)
`collection-event-indexer.ts`: new default path — DAS snapshot → derive current owner per mint from `svm.collection_event` (the `svm_collection_owner_derived` view logic `[migrations/svm/001_collection_owner_derived.sql]`) → walk ONLY mismatched mints via Enhanced. `--full` flag preserves today's behavior. While Helius is dark: `--verify-off` records `last_reconcile_result: 'skipped-no-das'` (NFR-2's declared-not-silent rule).

### 2.7 `svm.sync_status` (FR-5)
DDL migration `migrations/svm/002_sync_status.sql`: `(collection_key text primary key, last_event_at timestamptz, last_event_source text, last_reconcile_at timestamptz, last_reconcile_result text, updated_at timestamptz)`. Hasura-tracked + public-select like `svm_collection_event` (same `pg_track_table` motion, pending-exposure→live lifecycle per `scripts/svm-contract.json`). Writers: loader, webhook (on upsert batch), reconcile. This is #121 Q4/Q6's promised consumer-visible freshness signal.

### 2.8 Registry additions (FR-6)
8 entries in `COLLECTIONS` `[src/svm/collection-registry.ts:28-35]` from the verified candidates doc (mad_lads, claynosaurz, smb_gen2, degods, daa_higher_self, famous_fox, y00ts, galactic_geckos) + per-entry optional `duneQueryIds`.

## 3. Security
- `DUNE_API_KEY` env-only, never argv/logs (NFR-4); joins GH workflow secrets for any scheduled loader runs.
- Dune rows are UNTRUSTED input: schema-validate each row (zod-lite manual checks matching repo style) before mapping; reject rows with malformed addresses/timestamps rather than coercing.
- No new public write surface; Hasura writes stay admin-secret-gated as today.

## 4. Test Strategy (all fixture-based, NFR-3)
- `test/dune-client.test.ts` — pagination, retry, cost-log surface (mocked fetch).
- `test/warehouse-loader.test.ts` — row→CollectionEvent mapping incl. per-(tx,mint) ordinal convergence with `parseHeliusTx` fixtures (SAME tx through both paths → SAME PK), cursor windows, malformed-row rejection.
- `test/kind-mapping.test.ts` — T-2's fixture adjudication: program-ID map vs pythians Helius-classified sample (committed fixture slice, not 30k rows).
- `test/collection-event-webhook.test.ts` — extend existing 4 to multi-collection routing + single-tenant override.
- `test/sync-status.test.ts` — writer upsert semantics.
- Live-Helius checks: explicitly OUT of CI; post-topup runbook tasks (T-9).

## 5. Rollout
1. Merge → migration 002 applied + Hasura track (operator, same motion as 001).
2. Loader: pythians gap-heal first (`--from 2026-06-25`) → G1 parity check vs the 108-event Dune ground truth → then batch-1 collections one by one, cost logged.
3. Webhook deploy: pythians-only via override env first, then registry mode.
4. Post-topup (operator): Helius webhook re-verified live, incremental reconcile measured via helius-meter, #122 closed.
