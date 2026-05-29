# Session 6 — B-1 (green-belt → ponder) + GLOBAL flip (retire blue)

> The sovereign indexer's last mile: port the green belt into ponder, wire every app onto it, then flip the gateway off envio-blue for good. Sprint M proved the pattern on Mibera (5.14M rows, live). This finishes the job.

> **Mode**: ARCH (Ostrom — structure/blast-radius/reversibility) · driving loop = `code-implement-and-review` (implement → FAGAN, per handler group). Craft lens N/A (no UI; this is handlers + data + ops).
> **Date**: 2026-05-28 · **Authority**: operator (zksoju) · **Status**: ready-to-build

---

## Context

Sprint M migrated the **Mibera blue-belt** (40 entities, 5.14M rows) into ponder on `Postgres-vRR1`, brought green ponder live (forward-indexing from the boundary), and cut **Score** over to it — all verified, all consumer-safe, blue never moved. The pattern is proven: empty-boot ponder → frozen-import envio rows (triggers-off, idempotent) → forward-index from a per-chain boundary.

**What's left is the green belt.** Blue (`Postgres-3vIC`) still serves ~1.64M+ green-belt rows ponder lacks (validator-rewards, HoneyJar genesis, henlo, apdao, fatbera, candies, moneycomb, mirror, set-and-forgetti). Until ponder holds them too, the **global gateway flip would regress every green-belt consumer**. B-1 closes that gap; then the flip retires blue.

**Operator scope decisions (locked this kickoff):**
- **Spike → then ALL 43.** Port one group first to de-risk + measure, then port *all* 43 live green-belt entities (full parity). **Do NOT cull/prune** — we need everything to restore every app. Culling unused entities + intentional API/GraphQL schema design come **later, only after** migration is complete AND apps are wired in.
- **Flip executes autonomously** once gates + AC pass (operator delegated the sacred /backing flip to the build session — blue stays hot, auto-rollback on any failure).
- **§7 gates**: sietch = not a concern (skip); Redis PrevHashStore + envio deployment-ID = 10-min verify, not blockers.

## Run via — `code-implement-and-review` (REQUIRED)

`@~/bonfire/construct-compositions/compositions/delivery/code-implement-and-review.yaml`

Rails (run **once per handler group**, 8 groups): **implement** (CODEX-RESCUE ports the envio handler → ponder handler) → **review** (FAGAN reviews against the envio source for parity). The operator directs at each group boundary: accept the port, or send back. The data-migration + flip steps wrap this loop and are mechanical (the proven Sprint M scripts) — the loop's judgment is in the handler ports.

## Load Order

1. `@~/bonfire/construct-compositions/compositions/delivery/code-implement-and-review.yaml` — the driving loop
2. `grimoires/loa/migration/b-1-handler-gap.md` — **THE key artifact**: the 8 port groups, envio handler sources, ABIs, chains, effort
3. `grimoires/loa/migration/b-1-green-belt-map.yaml` — machine-readable entity→column map (source of truth for the transform extension)
4. `grimoires/loa/migration/b-1-plan.md` — sequencing + per-group effort
5. `/Users/zksoju/bonfire/sonar-ponder-coordinator/grimoires/loa/migration-A-data-migration-spec.md` Appendices B/C/D — the **proven Sprint M load pattern** (empty-boot-first, triggers-off, per-classification startBlock, type-drift rules, build_id finding)
6. `scripts/migration/transform.ts` + `entity-map.ts` — the transform to extend (add `timestamp_to_bigint` + `string[]` cases)
7. `ponder.config.mibera.ts` + `ponder.schema.ts` + `ponder-runtime/src/index.ts` — what to extend (currently 15 Mibera handlers; add green-belt)

## Persona
ARCH (OSTROM) for the structure; per-group ports run CODEX-RESCUE → FAGAN via the composition. No craft lens (no UI surface).

## Invariants (must not change)
- **Blue stays untouched + hot** until the flip, and hot as failback after. Consumers read blue (via belt-gateway) the entire time B-1 builds.
- **The Sprint M load pattern** — empty-boot ponder creates tables/`build_id` FIRST, frozen-import triggers-off, per-entity startBlock (append-only = boundary−overlap; rollup = boundary exactly). Don't reinvent; reuse `transform.ts`.
- **`build_id` discipline** — any schema change (adding green-belt tables) rotates `build_id`. So green-belt schema must be FINAL before its empty-boot, and the deployed green config must match the empty-boot config exactly (Sprint M lesson: startBlock alone rotated `build_id` 30d3d434b0→396e1de377).
- **No cull, no API redesign, no premature flip** (see What NOT to Build).

## What to Build (in order)

### Phase 0 — De-risk spike (ONE group: henlo / Group D)
Port end-to-end, measuring cost + throughput before committing the other 7 groups:
1. Add henlo green-belt tables to `ponder.schema.ts` (snake_case; apply type-drifts from the map).
2. Port the envio handler(s) (`tracked-erc20/{holder-stats,burn-tracking}.ts`) → ponder handlers; register in `ponder-runtime/src/index.ts`.
3. Extend `transform.ts` for the new drifts: **`timestamp_to_bigint`** (`EXTRACT(EPOCH FROM col)::bigint` — envio `Timestamp` scalar is pg `timestamp`, NOT bigint) and **`string[]`** (`JSON.stringify`, like the Mibera `bigint[]` case).
4. Re-ground the henlo chains' boundaries from envio `chain_metadata` (base/bera already verified in T-M1; reuse).
5. Frozen-import henlo green-belt rows; forward-index; **validate** (count + checksum parity, per the Sprint M T-M3 method).
**Acceptance / GATE**: henlo green-belt live in ponder + parity-verified. Measure cold-sync throughput + HyperRPC cost → confirm the all-43 plan is viable. If a surprise, escalate to operator before Phase 1.

### Phase 1 — Port the remaining 7 groups (full parity, all 43)
Per `b-1-handler-gap.md`, run the `code-implement-and-review` loop per group: validator-rewards (`fatbera.ts`), HoneyJar-genesis (`honey-jar-nfts.ts`+`crayons.ts`, **6 chains** incl. NEW Arbitrum 42161 + Zora 7777777), moneycomb (`moneycomb-vault.ts`), set-and-forgetti (`sf-vaults.ts`), apdao (`apdao-auction.ts`), mirror (`mirror-observability.ts`). ~14 new ABIs (only Erc721/Erc20 reusable), ~22 contract registrations.
- **NEW CHAINS**: re-ground Arbitrum + Zora boundaries from envio `chain_metadata` FIRST (they're NOT in the T-M1 verified set — do not reuse a Mibera boundary). eRPC already routes both (`erpc.yaml`).
- Extend `ponder.config` per group; keep schema final before each empty-boot.

### Phase 2 — Frozen-import all green-belt data
Extend the `entity-map.yaml` the transform loads to the green-belt set; run `transform.ts` (triggers-off, idempotent, batched) per group. Pre-import: **verify the 10 "dead" entities are truly 0-rows in blue 3vIC** (if any has rows, a write path was missed — re-map it).

### Phase 3 — Validate (the correctness gate)
Per group: count parity + id-set checksum (the Sprint M T-M3 method — see `scripts/` + the source-baseline approach) + forward-index advancing. Result: **ponder ⊇ blue** (Mibera 40 + green-belt 43).

### Phase 4 — GLOBAL FLIP (gated final phase — executes autonomously when ALL of the below pass)
**Pre-flip gates (all must pass):**
- ponder ⊇ blue (Phases 1-3 complete + parity-verified for all in-scope entities)
- green ponder `is_ready=1` (caught up to head on all chains)
- §7 quick-verify: sietch = skip (not a concern); Redis PrevHashStore = confirm it's Redis-backed (not InMemory) so the ACVP chain survives restart; envio deployment-ID = confirm canonical (moot post-flip)
- AC-2..6 pass against the full ponder side (`scripts/ac-validate.sh`)

**Flip sequence (build-session executes; blue hot; auto-rollback on any failure):**
1. `scripts/cutover-hasura-tracking.sh cutover` on **belt-hasura** (blue's hasura) → ponder.* (the A-3.6 introspection-hardened path; same script that cut belt-hasura-green this session).
2. Flip `belt-gateway BELT_UPSTREAM` → the ponder hasura, API-direct (railway CLI can't auth — §8; byte-identical to `promote.sh`, under the operator's standing delegation).
3. `scripts/nats-reconciliation-24h.sh` + AC re-validate against the live gateway.
4. **Auto-rollback trigger**: any AC fail or reconciliation divergence → flip `BELT_UPSTREAM` back to blue immediately (reversible; blue kept hot). Surface to operator.
**Acceptance**: gateway serves ponder for ALL consumers; Score + every green-belt app green; blue retired-but-hot.

## Design Rules
- Reuse `transform.ts` — add only the 2 new drift cases (`timestamp_to_bigint`, `string[]`); everything else is the proven path.
- Schema FINAL before each empty-boot (build_id discipline). Deployed green config == empty-boot config exactly.
- append-only entities → `startBlock = boundary − overlap`; additive-rollup → `boundary` exactly (no overlap = no double-count). Classify each green-belt entity per `b-1-green-belt-map.yaml`.
- New chains (Arbitrum/Zora): re-ground boundaries from live envio `chain_metadata` — never reuse a Mibera chain's boundary.
- Every handler port reviewed by FAGAN against the envio source for parity before merge.

## What NOT to Build
- **NO culling/pruning** of green-belt entities — port ALL 43 even if some look unused. Culling is a *later* phase, only after full migration + all apps wired in.
- **NO API/GraphQL schema redesign** — preserve the consumer-facing contract (custom_root_fields keep PascalCase names resolving). Intentional API/schema design is explicitly deferred to *after* this migration.
- **NO flip before ponder ⊇ blue + green is_ready=1 + AC pass** — a premature flip regresses green-belt consumers (the 1.64M-row gap).
- **NO touching blue** — it's the failback. Don't repoint, stop, or alter belt-indexer/belt-hasura(blue)/3vIC until after the flip is verified stable.

## Verify
- Per group: `count(ponder) == count(blue)` + id-set checksum match + forward-index advancing.
- Pre-flip: ponder ⊇ blue, green `is_ready=1`, AC-2..6 pass, §7 quick-verify clean.
- Post-flip: gateway serves ponder; NATS double-emit reconciliation clean; Score + every green-belt consumer returns live data; blue hot as failback.

## Key References
| Topic | Path |
|---|---|
| Handler-gap (THE work-list) | `grimoires/loa/migration/b-1-handler-gap.md` |
| Entity→column map | `grimoires/loa/migration/b-1-green-belt-map.yaml` |
| B-1 sequencing/effort | `grimoires/loa/migration/b-1-plan.md` |
| Proven Sprint M pattern | coordinator `migration-A-data-migration-spec.md` App. B/C/D |
| Transform (extend) | `scripts/migration/transform.ts` + `entity-map.ts` |
| Hasura cutover | `scripts/cutover-hasura-tracking.sh` |
| Gateway flip | `scripts/promote.sh` (or API-direct) |
| AC + reconciliation | `scripts/ac-validate.sh` + `scripts/nats-reconciliation-24h.sh` |
| Coordinator (beads, cockpit) | `~/bonfire/sonar-ponder-coordinator` (B-1 = bead `…-n3l`) |
