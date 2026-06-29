---
session: 6
date: 2026-05-28
type: kickoff
status: complete
---

# Session 6 — B-1 (green-belt → ponder) + GLOBAL flip (kickoff)

## Scope
- Port the green belt into ponder: spike ONE group (henlo) → then ALL 43 live entities (8 handler groups, ~14 ABIs, 2 NEW chains: Arbitrum 42161 + Zora 7777777).
- Frozen-import green-belt data (reuse `transform.ts`; add `timestamp_to_bigint` + `string[]` drift cases).
- Validate per group (count + checksum parity) → ponder ⊇ blue.
- GLOBAL flip (gated final phase, **executes autonomously**): cutover belt-hasura → ponder, flip belt-gateway `BELT_UPSTREAM` blue→ponder, AC + NATS reconciliation, blue hot failback + auto-rollback.

## Artifacts
- Build doc: `specs/enhance-b1-and-global-flip.md` (merged ARCH + build sequence + flip runbook)
- Research (DIG, done): `migration/b-1-handler-gap.md`, `b-1-green-belt-map.{md,yaml}`, `b-1-plan.md`

## Prior session
Session 5 / this session: Sprint M complete — migrated Mibera blue-belt (40 entities, 5.14M rows) into ponder, green live-indexing, Score cut over to ponder (live). Pattern proven + reusable.

## Decisions made (this kickoff)
- **Spike → then ALL 43** (full parity to restore every app). NO culling + NO API/GraphQL redesign until *after* migration + apps wired in.
- One build doc; flip = gated final phase within it.
- §7 gates: sietch = skip (not a concern); Redis PrevHashStore + envio deployment-ID = 10-min verify, not blockers.
- Flip executes **autonomously** once ponder ⊇ blue + green is_ready=1 + AC pass; blue hot; auto-rollback on failure.
- Driving composition: `code-implement-and-review` (implement→FAGAN per handler group).

## Blast radius (high level)
- NEW: green-belt ponder schema tables, ~8 handler files, ~14 ABIs, Arbitrum+Zora chain config.
- MODIFIED: `ponder.config.mibera.ts`, `ponder.schema.ts`, `ponder-runtime/src/index.ts`, `transform.ts`/`entity-map.ts` (+2 drift cases).
- OPS (flip): belt-hasura metadata, belt-gateway `BELT_UPSTREAM`. Blue untouched until flip; hot as failback after.
- Reversible: flip is `BELT_UPSTREAM` back to blue.

---

## OUTCOME — Session 6 complete (2026-05-28)

**Keystone landed: Mibera is sovereign — live on ponder via the gateway.** A buried surprise drove the session: the kickoff assumed Mibera was already cut over, but the gateway was still on BLUE and a prior flip had been rolled back on a green-Hasura field-parity bug.

1. **Railway CLI auth — permanently fixed.** A stale `RAILWAY_API_TOKEN` in `~/.claude/settings.json` was shadowing the operator's valid login every session; removed. CLI now drives Railway via the auto-refreshing login (use `env -u RAILWAY_API_TOKEN` in already-running sessions).
2. **green-Hasura field parity fixed.** `cutover-hasura-tracking.sh` baked `custom_root_fields` but left `column_config` EMPTY → green leaked snake_case column names while consumers expect blue's camelCase. Generated 223 `custom_name` aliases for all 40 Mibera tables from the T-M1 map; applied via bulk `pg_set_table_customization`. Verified 40/40 root fields match blue, 0 missing. **FOLLOW-UP:** extend `cutover-hasura-tracking.sh` to bake `column_config` so re-tracks don't regress.
3. **Consumer audit (8 apps) = FLIP-SAFE.** Every app reads the hosted Envio cloud (`indexer.hyperindex.xyz/914708e`), not the self-hosted belt; only Score plausibly reads the belt, and it reads only Mibera-40.
4. **GATEWAY FLIPPED → green.** `BELT_UPSTREAM`→belt-hasura-green + `CURRENT_BELT_DATABASE_URL`→vRR1 (API-direct via login; both promote.sh tokens are dead). Validated: parity queries resolve, `Action_aggregate`=2,397,298, HenloHolder errors (confirms green), HTTP 200. Blue HOT as failback; rollback snapshot at coordinator `grimoires/loa/migration/FLIP-ROLLBACK-snapshot.txt`; T+24h reconciliation scheduled (routine `trig_01NfBNLoXHGN6Ztmqv9jossz`).
5. **B-1 henlo Phase-0 — code-half + spike GATE PASSED.** schema (8 henlo tables) + handler port (FAGAN-approved vs envio) + transform (`timestamp_to_bigint` + green-belt-map loading). Isolated spike: 43 green-belt tables created locally (map-driven DDL), henlo frozen-imported from blue-3vIC (47,523 rows), FULL PARITY (count + id-set + value checksum). all-43 VIABLE; only material new cost = the 2 NEW chains (Arbitrum/Zora) cold-sync.

## NEXT — Phase 1 (port the remaining 7 groups)
Order (b-1-plan.md): H-mirror (S) → G-apdao (M) → C-moneycomb (M) → E-henlo-vault (M) → A-validator (L) → F-set-and-forgetti (L) → B-honeyjar-genesis (L, +2 new chains). Then land all-43 on a **FRESH green boot** + the **Berachain `TrackedErc20` registration** → repoint the green-belt apps off hosted Envio → retire blue.

**INVARIANT:** do NOT touch `belt-indexer-green`'s live config (`ponder.config.mibera.ts`) — adding green-belt there rotates its `build_id` and breaks the Mibera serving. Phase 1 builds toward a fresh green on the full 83-entity schema.
