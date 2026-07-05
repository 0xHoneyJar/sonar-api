---
hivemind:
  schema_version: "1.0"
  artifact_type: product-spec
  product_area: "sonar-api — SVM warehouse-loader lane (Solana batch onboarding)"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "ingest Solana NFT collections' full event history at warehouse cost (not per-call API cost) and serve multi-collection live tails, so the #121 ramp's Solana half onboards in days instead of months and the recurring Helius bill collapses to free-tier"}
  learning_status: directionally-correct
  source: team-internal
trust_tier: operator-authored
read_state: read
confidence: 0.8
decay_class: working
last_confirmed: 2026-07-05
operator_signed: self_attested
---

# PRD — SVM Warehouse Loader (cycle: svm-warehouse-loader)

> **Cycle**: `svm-warehouse-loader` · **Revision**: r1 (2026-07-05) · **Persona**: ARCH (OSTROM) + KRANZ standby
> **Supersedes**: nothing — new lane. Parked `indexing-managed-envio` PRD archived at `grimoires/loa/archive/2026-07-05-indexing-managed-envio-parked/`.
> **Origin**: operator directive 2026-07-05 ("ingest the 20 communities… draft the sprint plan for the Solana loader, go full /autonomous"), grounded in the #121 scale-ramp thread, #122 (Helius quota outage/KF-018), and live Dune parity probes run 2026-07-05.
> **Grounding legend**: `[CODE:file:line]` = code read this cycle · `[MEASURED]` = number produced by a live query/run this cycle · `[ASSUMPTION]` = flagged, unverified.

## 1. Executive Summary

The #121 ramp needs ~10 Solana collections now and tens more later. The existing SVM lane acquires history via Helius Enhanced per-address walks at ~120 credits/NFT `[MEASURED: pythians 3,682 mints ≈ 440k credits/walk]`, which caps ingestion at ~11 collections/month on a $49 plan and produced KF-018 (quota exhaustion → 9-day silent outage → 108 missed events `[MEASURED: Dune vs svm.collection_event diff]`). This cycle adds a **warehouse loader**: full history from Dune's decoded Solana tables (`[MEASURED: 18.6 credits full-history, 0.22 credits date-bounded for pythians]`), converging with the existing webhook live tail on the content-addressed PK. It also removes the two scale blockers in the live lane: single-collection webhook config and the full-rewalk reconcile design.

## 2. Problem Statement (evidence)

1. **Ingestion cost scales with paranoia, not activity.** The reconcile cron re-walks every mint's full Enhanced history every 6h `[CODE:src/svm/collection-event-indexer.ts:87-110 — snapshot → mintHistory loop]`; one 3.7k-NFT collection ≈ 53M credits/mo. No Helius plan supports >1 collection under this design.
2. **The webhook is single-tenant.** `COLLECTION` env selects ONE collection at runtime `[CODE:src/svm/collection-event-webhook.ts:27 (cfg = resolveCollection)]`; the #121 Solana batch needs ≥8 concurrent.
3. **History acquisition is the only expensive step, and a cheaper substrate is verified.** Dune `tokens_solana.transfers` carries owner-level from/to (`from_owner`/`to_owner` `[MEASURED: column probe]`), slot/tx_id/instruction indices, action ∈ {mint, transfer, burn}; member sets resolve via `tokens_solana.nft.collection_mint` `[MEASURED: 3,683 pythians members vs 3,682 DAS]`.
4. **Sale/list/delist do NOT come free from the warehouse.** `nft.trades` returned zero pythians rows `[MEASURED: probe 2026-07-05]`. Marketplace kinds need an explicit mapping decision (§6 FR-5).

## 3. Goals & Success Metrics

| Goal | Metric | Target |
|---|---|---|
| G1 Warehouse ingestion works and is trusted | pythians re-ingest via loader vs existing 30,006-event Helius-classified fixture | ≥99% ownership-reconcile parity (§4.5 gate); zero PK collisions with existing rows |
| G2 Solana batch 1 ingestable | 8 classic-mint collections from `grimoires/loa/context/2026-07-04-top10-base-solana-onboarding-candidates.md` registered + loadable | one command per collection; measured Dune cost logged per run |
| G3 Live tail multi-collection | webhook serves all registered collections concurrently | member-routing per collection_key; /health reports per-collection state |
| G4 Recurring cost collapses | reconcile design | incremental: DAS snapshot diff → Enhanced walk ONLY drifted mints; measured via helius-meter (PR #123) |
| G5 No blind spots (KF-018 class) | per-collection freshness | `svm_sync_status` row per collection: last_event_at, last_reconcile_at, source |

## 4. User Stories

- **US-1 (score-api)**: As the downstream scorer, I can read `svm_collection_event` for any batch-1 collection with full history and a queryable per-collection freshness row, so I never score off silently-stale data. *AC: freshness row updates on every loader/webhook write; documented in the gateway contract.*
- **US-2 (operator)**: As the operator, I onboard a new classic-mint Solana collection with a registry entry + one loader invocation, and the loader refuses to publish if reconciliation fails. *AC: `--collection <key>` end-to-end; §4.5 gate enforced; cost per run printed.*
- **US-3 (operator)**: As the operator, when Helius credits die again, the loader lane still ingests history and the freshness rows make the gap visible instead of silent. *AC: loader has zero Helius dependency for transfer/mint/burn; freshness row distinguishes webhook-sourced vs loader-sourced recency.*

## 5. Scope

**IN**: warehouse extraction (Dune API) → decode → `svm.collection_event` upsert; kind-mapping adjudication (FR-5); multi-collection webhook; incremental reconcile; `svm_sync_status` freshness table; registry entries for batch-1's 8 classic collections; backfill of pythians' 108-event gap via loader (proves G1 on real damage).
**OUT** (deferred, tracked in candidates doc): Metaplex Core collections (DUMPSTR, ENTROPY), compressed-member collections (Tensorians), creator-keyed (Tomorrowland), EVM anything, coherence-surface rendering.

## 6. Functional Requirements

- **FR-1 Loader**: `src/svm/warehouse-loader.ts` — given `collection_key`, resolve collection_mint from registry, execute parameterized Dune query (members via `tokens_solana.nft`, events via `tokens_solana.transfers`, date-bounded resumable via max ingested `block_time` cursor), page results via Dune API, map to `CollectionEvent`, upsert via existing `upsertCollectionEvents` `[CODE:src/svm/collection-event-writer.ts:47-50 PK]`. Dune API key via env `DUNE_API_KEY`; never logged.
- **FR-2 Kind mapping**: warehouse `action` → kinds: mint/transfer/burn direct. Marketplace kinds (sale/list/delist): **decision task T-2 adjudicates** (a) program-ID classification via `outer_executing_account` vs (b) selective Enhanced enrichment vs (c) defer-to-transfer (ship transfers now, reclassify later — precedent: #85's re-backfill pattern `[CODE:src/svm/collection-event-source.ts:108-113 MARKETPLACE_KINDS_ENABLED]`). Fixture = pythians 30,006 Helius-classified events.
- **FR-3 Multi-collection webhook**: replace single `cfg` with registry-driven map; per-collection member sets + freshness; `/health` gains per-collection block. Helius webhook registration stays operator/dashboard-side (documented), one webhook → router by collection membership.
- **FR-4 Incremental reconcile**: cron becomes DAS-snapshot diff (10cr/1k) → Enhanced walk only mints whose derived owner ≠ snapshot owner; full-walk retained behind `--full` flag.
- **FR-5 Freshness**: `svm.sync_status` table (collection_key PK, last_event_at, last_event_source, last_reconcile_at, last_reconcile_result) written by loader, webhook, reconcile; tracked into Hasura like `svm_collection_event` (pending-exposure → live per contract lifecycle `[CODE:scripts/svm-contract.json]`).
- **FR-6 Registry**: batch-1's 8 classic-mint collections added to `COLLECTIONS` `[CODE:src/svm/collection-registry.ts:28-35]` with addresses from the verified candidates doc.

## 7. Non-Functional Requirements

- **NFR-1 Cost visibility**: every loader run logs Dune credits consumed (execution metadata) + helius-meter summary; no silent spend.
- **NFR-2 Trust**: Dune is transport, never truth — no loader write bypasses the §4.5 reconcile gate. Reconcile substrate is DAS (or, while Helius is dark, the gate degrades to declared-and-logged `unverified` state, never silent pass). Loader runs are idempotent (PK) and resumable (cursor).
- **NFR-3 Zero live-Helius dependency in CI**: all tests run against fixtures; live checks are explicitly post-topup tasks.
- **NFR-4 Secrets**: `DUNE_API_KEY` joins the workflow-secret set; never in argv (env only), never in logs.

## 8. Dependencies & Constraints

- Dune API access (operator account; MCP-verified working 2026-07-05). Row-limit pagination on result fetch [ASSUMPTION: API max_rows per fetch — verify in T-1 and page accordingly].
- Helius credits: NOT required for G1/G2 (loader) or tests; required for G3 live verification + G4 measurement + healing pythians webhook tail — operator tops up later (stated 2026-07-05).
- #122 stays open until post-topup verification lands; loader backfill of the 108-event gap closes the data hole earlier.
- Blue/green not needed (no Envio config change; SVM lane is Postgres-side).

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Dune spellbook decode drift/bugs | §4.5 gate + parity fixture in tests; contract-guard extension for warehouse columns (drift caught in CI, not at 3am — #121 Q5 discipline) |
| Kind-mapping wrong → score distortion | T-2 adjudicates against Helius-classified fixture BEFORE batch ingestion; option (c) ships transfers-only rather than wrong kinds |
| Dune result pagination limits on big collections | cursor design (block_time-bounded windows) from day one; measured on pythians (28.7k rows) then Mad Lads-scale |
| Webhook refactor regresses pythians live tail | webhook tests (existing 4) extended to multi-collection; pythians kept as first tenant unchanged |
| member-set tail (±7 pythians: 3,683 ever vs 3,682 DAS) | reconcile gate adjudicates burnt/re-minted mints; documented per-collection |
