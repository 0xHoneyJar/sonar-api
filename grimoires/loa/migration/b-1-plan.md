# B-1 — Implementation plan (green-belt → ponder)

**Cycle**: `sonar-ponder-migration-v1` · **Task**: B-1 · **Branch**: `spike/b-1-green-belt-mapping`
**Status**: SPEC — planning artifact only. NO DB, NO code execution, NO prod connection.
**Reuses the Sprint-M pattern**: live-forward + frozen import (spec §4), the T-M0 constraints (Appendix B), the T-M2 transform (`scripts/migration/{transform.ts,entity-map.ts,pg.ts}`).
**Inputs**: `b-1-green-belt-map.{md,yaml}` (entity map), `b-1-handler-gap.md` (the work estimate).

---

## 0. One-paragraph truth

The green belt is **53 envio entities (43 live, 10 dead)** — everything envio indexes that Sprint M did not migrate (~1.64M+ known rows, led by `ValidatorBlockRewards` @ 906,771). The frozen import is the **same near-mechanical camelCase→snake_case transform** as Sprint M, with two extra drift handlers (a new `timestamp_to_bigint` for envio's `Timestamp` scalar, and a `string[]` variant of the existing array→json). The real cost is **not** the import — it is that **0 of 43 live green-belt entities have a ponder forward handler**; B-1 must port ~8 envio handler files (≈22 contracts, ≈14 ABIs, +2 new chains) into `ponder-runtime` + `ponder.config`. Completing those ports is exactly what unblocks the **GLOBAL gateway flip** (ponder ⊇ blue → non-regressing), because today any green-belt entity a consumer reads live would freeze at the boundary.

---

## 1. Sequence (5 phases, reusing Sprint-M structure)

```
(a) schema + config        → ponder OWNS its DDL before any load (T-M0 constraint)
(b) handler ports          → the bulk (b-1-handler-gap.md); restores forward indexing
(c) frozen import          → extend transform.ts to green-belt entities
(d) boundary + forward     → per-chain startBlock; ponder indexes forward
(e) validate + cutover     → count/checksum parity; then the GLOBAL gateway flip
```

A hard ordering constraint from **T-M0 Appendix B finding 1** drives the shape: ponder must boot ONCE on the **final, empty** schema (it creates its tables + `_ponder_meta` + `_ponder_checkpoint` and fixes `build_id`) **before** any frozen row is loaded; a schema change after first boot rotates `build_id` → "different Ponder app" error. **Therefore (a) schema additions for ALL imported green-belt entities must be finalized before (c) the import — even for groups whose handler (b) lands later.** Add the table to `ponder.schema.ts` now (so the frozen rows have a home); the handler can be wired in a later sub-sprint without a schema change.

> Corollary: decide up-front **which** green-belt entities get imported at all. Dead entities (10) are excluded. For live entities whose contract is inactive AND no consumer reads them, you MAY still add the table + import history (cheap, immutable) but defer the handler — that is the "(A) accept-frozen-only" path per group.

---

## 2. Phase (a) — extend `ponder.schema.ts` + `ponder.config` (contracts × 6 chains)

### a.1 `ponder.schema.ts` — add the 43 live green-belt `onchainTable` defs
- Follow the existing 40-table convention exactly: single text `id` PK, `numeric(78,0)` for BigInt, `bigint` (int8) for epoch times, `integer` for Int, `boolean`, `text` for hex/strings, `text` for the drift columns (`user_addresses`, the validator timestamps land as `bigint`).
- **Drift columns become plain ponder types** — the conversion happens in the transform (import) AND must match what the ported handler will write forward: `*_timestamp`/`*_time` → `bigint` (epoch); `user_addresses` → `text` (JSON string).
- Source-of-truth for every column: `b-1-green-belt-map.yaml`.

### a.2 `ponder.config.mibera.ts` — register green-belt contracts + 2 new chains
- **Add 2 chains**: `arbitrum: { id: 42161, rpc: RPC_ARB }`, `zora: { id: 7777777, rpc: RPC_ZORA }` (today only eth/base/bera/op). Add `PONDER_RPC_URL_42161` / `PONDER_RPC_URL_7777777` env + eRPC routes `/main/evm/42161`, `/main/evm/7777777`. **GROUNDED: eRPC already routes both** — `erpc.yaml:107,109` define `bud-arbitrum-hyperrpc`/`bud-zora-hyperrpc` upstreams and `erpc.yaml:175,187` project them as chains 42161/7777777 (added Path ε 2026-05-27). So the chain infra exists; only the `ponder.config` chain entries + outbox-flush blocks are missing.
- **Add ~22 contracts** across the 8 groups (addresses + start_blocks verbatim from `config.yaml`; see `b-1-handler-gap.md` §2 for the per-group list). Each needs a matching `OutboxFlush<Chain>` block-tick if a new chain (Arbitrum/Zora).
- **ABIs**: author ~14 new viem ABIs into `abis/` from the `config.yaml` event signatures (mechanical `parseAbi([...])`, same as `MiberaAbis.ts`). Reuse `Erc721TransferAbi`/`Erc20TransferAbi` where applicable.

### a.3 startBlock per contract (per the T-M2 reduction)
- `startBlock` is per-**contract**, the boundary per-**chain**, the double-count rule per-**entity**. A contract gets `boundary − finalityOverlap` ONLY if every entity its events write is append-only.
- Per `b-1-green-belt-map.yaml` classification: nearly all green-belt contracts touch at least one rollup → pin to **`boundary` exactly**. The only clean append candidates write rollups alongside (HJ contracts, Mirror) → also pin to `boundary`. **Net: pin all green-belt contracts to `boundary` exactly** (safest; the live-overlap diff has almost no surface anyway — §5).
- **Re-ground the Arbitrum + Zora boundaries** from envio `chain_metadata.latest_processed_block` before import — they are NOT in the verified T-M1 boundary set (which covers only eth/base/bera/op). Do NOT reuse a Mibera boundary for them.

---

## 3. Phase (b) — port the missing handlers (the bulk; `b-1-handler-gap.md`)

Port the ~8 envio handler files into `ponder-runtime/src/handlers/` and register them in `ponder-runtime/src/index.ts`, following the proven A-2 pattern (`docs/A-2-handler-port-summary.md`). Per-group effort + ABI/contract gap is enumerated in `b-1-handler-gap.md` §2:

| Order | Group | Effort | Rationale for order |
|---|---|---|---|
| 1 | **D — henlo holder/burn** | M | Lowest friction: `TrackedErc20` already registered + live ponder handler; extend it. No new contract/ABI. Fast win that proves the green-belt port loop. |
| 2 | **H — mirror** | S | Smallest handler; Optimism already a chain. |
| 3 | **G — apdao** | M | Self-contained; harvest `feat/apdao-seat-tracked` branch if it has an ABI/handler draft. |
| 4 | **C — moneycomb-vault** | M | Self-contained Berachain vault. |
| 5 | **E — henlo HENLOCKER vault** | M | Self-contained; shares `tracked_token_balance` (already ported) so port only the `HenloVault*` paths. |
| 6 | **A — validator-rewards** | L | Largest data (906k); most complex (reward-split + Latest* lookups). Port once the loop is well-grooved. |
| 7 | **F — set-and-forgetti** | L | Largest handler (40KB); migration-aware position logic. |
| 8 | **B — honeyjar-genesis** | L | 6-chain spread incl. 2 NEW chains; cross-chain `user_balance` rollup; do last so the chain-addition work is isolated. |

Each port goes through the standard implement→review→audit cycle (the construct/Loa gates), not ad-hoc. Group D first is the de-risking spike for the whole green-belt port loop.

---

## 4. Phase (c) — frozen import (extend the T-M2 transform)

The transform exists and is scratch-validated (33/33) — `scripts/migration/{transform.ts, entity-map.ts, pg.ts}`. Extend, don't rewrite:

1. **`entity-map.ts`**: `MAP_PATH` is hard-coded to the T-M1 yaml; add green-belt support — either point it at `b-1-green-belt-map.yaml` or load both. **Add `"timestamp_to_bigint"` to the `TransformKind` union** (today it is only `rename | jsonb_to_text | array_to_json_text`). The strict hand-rolled parser will hard-error on the new `community`/`chain`/`rows_known`/`dead_entities` keys — extend the parser to accept (or ignore) them.
2. **`transform.ts`**: add a `timestamp_to_bigint` case to `convert()` AND `buildSelect()` — the SELECT must emit `EXTRACT(EPOCH FROM "<col>")::bigint AS "<col>"` for those 8 columns (envio stores them as pg `timestamp`/`timestamptz` from the `Timestamp` scalar; a plain rename would fail the type). The existing `array_to_json_text` already produces JSON-array-of-strings → reuse as-is for `withdrawal_batch.user_addresses` (`String(x)` on string input is identity-safe).
3. **Idempotency + safety carry over unchanged**: `ON CONFLICT (id) DO UPDATE` (or `--on-conflict nothing` for append), keyset batching on text PK `id`, `DISABLE TRIGGER USER` → load → re-enable (T-M0 finding 2), and the `TM2_ALLOW_PROD=I_UNDERSTAND` + `3vic`/`vrr1` refusal guard.
4. **Exclude the 10 dead entities** + envio-internal `Block`/`Transaction`/`Aggregated*` (the transform already skips the latter).
5. Per-entity row counts logged; second run byte-identical (per-table md5).

---

## 5. Phase (d) boundary + forward-index, Phase (e) validate + GLOBAL cutover

- **(d)** With contracts registered (a) and handlers ported (b), ponder indexes **forward** from each contract's `startBlock` (= `boundary` exactly for nearly all green-belt contracts). Frozen history below the boundary is immutable (triggers-off load → not in `_reorg__`).
- **(e) Validation** = the T-M3 bar: per-entity `count(envio)==count(ponder)` + aggregate checksum parity over key columns (universal — the backstop for the `timestamp_to_bigint` + `user_addresses` drift columns, which mostly live on rollup entities that can't be overlap-diffed). The **live-overlap diff** exists only where a contract is append-only-pure with overlap — which is **almost nowhere** in the green belt (same conclusion as T-M2 for Mibera), so count+checksum carries the weight. For the validator family specifically, checksum must account for the `timestamp_to_bigint` conversion (checksum the converted value, not the raw pg timestamp).
- **THE UNBLOCK**: completing B-1's forward coverage is what makes **ponder ⊇ blue** — every entity a consumer reads (Mibera 40 + green-belt 43) is indexed live, so the **GLOBAL gateway flip is non-regressing**. Until then, any green-belt entity read live would freeze at the boundary (acceptable only for inactive contracts under the accept-frozen-only path).

---

## 6. Per-chain cold-sync budget (HyperRPC cost — recurring on growth)

Ponder is RPC-only (spec §0): forward-indexing from `boundary` is cheap (tip-following), but each contract's forward range still flows through eRPC → HyperRPC (≤100 RPM, spec §3). Budget notes:
- **Existing 4 chains (eth/base/bera/op)** — green-belt contracts forward-index from `boundary`, same as the 40 Mibera; marginal cost (more contracts × more log filters per block, not more historical sweep). Berachain carries the most green-belt contracts (validator family + SF + HenloVault + ApDAO + Moneycomb) → highest per-block filter load there.
- **2 NEW chains (Arbitrum 42161, Zora 7777777)** — HoneyJar-genesis only. These have **no prior ponder presence**, so they cold-sync from their `boundary` forward. eRPC HyperRPC upstreams for both already exist (`erpc.yaml:266 arbitrum-hyperrpc → https://42161.rpc.hypersync.xyz`, + the zora leg), so transport is covered; the recurring cost is the forward-sync request budget at ≤100 RPM. This is the recurring-on-growth HyperRPC cost the spec §9 flags: every new chain/contract onboarded = a fresh forward-sync budget line.
- The frozen import (c) does NOT touch RPC at all (pure Postgres→Postgres) — the ~1.64M rows are a one-time DB transfer, not a chain backfill.

---

## 7. Risks (green-belt-specific, atop the Sprint-M risk table)

| Risk | Severity | Mitigation |
|---|---|---|
| `timestamp_to_bigint` conversion wrong (timezone / epoch-vs-ms) | MED | `EXTRACT(EPOCH FROM ...)::bigint` is UTC-seconds; unit-test against a known validator row; checksum the converted value |
| New-chain (Arb/Zora) boundary unverified | MED | re-ground from envio `chain_metadata` before import; do NOT reuse a Mibera boundary |
| `sf-vaults.ts` (40KB) port drops migration-aware position logic | MED | port last, after the loop is grooved; A-2-style handler-parity test |
| Schema-finality coupling (T-M0): a late schema add rotates `build_id` | HIGH | add ALL imported green-belt tables to `ponder.schema.ts` BEFORE first boot, even for deferred-handler groups |
| 14 new ABIs authored wrong | LOW-MED | extract verbatim from `config.yaml` event sigs; `parseAbi` type-checks |
| Forgetting a green-belt entity Score reads live → silent freeze post-flip | MED | before the GLOBAL flip, enumerate which green-belt entities each consumer (Score, Quests API) reads live; port those first |

---

## 8. Effort headline

- **Handler ports (the bulk)**: 3×L + 4×M + 1×S ≈ **~12 engineer-days** of handler+ABI+config, before review/audit + per-group validation (`b-1-handler-gap.md` §5).
- **Transform extension**: small — 2 new cases in `transform.ts` + `TransformKind`/parser tweak in `entity-map.ts` (≈½ day).
- **Schema additions**: 43 `onchainTable` defs (mechanical from the YAML; ≈1 day).
- **Total B-1 ≈ 2–3 weeks** of focused work, dominated by the 3 L-groups (validator-rewards, set-and-forgetti, honeyjar-genesis-6-chains).
- **Recommended**: do NOT port all 8 groups before any cutover — port by consumer-criticality, accept-frozen for inactive contracts, and flip the global gateway once forward coverage spans every live-read entity.
