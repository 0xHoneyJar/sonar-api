# B-1 Phase 0 — henlo spike OPS runbook (operator-paired)

**Cycle**: `sonar-ponder-migration-v1` · **Task**: B-1 Phase 0 (henlo / Group D de-risk spike)
**Status**: PLAN — the CODE half is done + locally validated (see §0). The OPS half below is
**operator-paired** (needs prod creds + a working Railway path; `railway` CLI is `Unauthorized`
in the build session, and the transform's `SRC/DST_DATABASE_URL` are operator-supplied per run).
**Authored**: 2026-05-28 (Session 6). Mirrors the proven `t-m2-dry-run-plan.md` (Sprint M), scoped to henlo.

---

## 0. What's already DONE + validated (the code half — reversible, in-repo, no prod touched)

Built via the `code-implement-and-review` loop (CODEX-RESCUE port → FAGAN parity review, both APPROVED),
then locally validated (all 5 checks green). Diff on branch `spike/b-1-green-belt-mapping`:

| File | Change |
|---|---|
| `ponder.schema.ts` | +115 — 8 henlo `onchainTable` defs (henlo_holder, henlo_holder_stats, henlo_burn, henlo_burn_stats, henlo_global_burn_stats, henlo_burner, henlo_chain_burner, henlo_source_burner), types/nullability verbatim from `b-1-green-belt-map.yaml` |
| `ponder-runtime/src/handlers/tracked-erc20.ts` | +612/−34 — activated the two TODO stub branches; ported `holder-stats.ts` (updateHolderBalances/updateHolderStats) + `burn-tracking.ts` (trackBurn + chain/source/global stats + recordAction). FAGAN parity-confirmed vs envio source. |
| `scripts/migration/entity-map.ts` | +57 — `timestamp_to_bigint` added to TransformKind; `MIGRATION_MAP_PATH` env override; the strict `===40` guard is now keyed to the T-M1 default path (green-belt map loads 43 entities) |
| `scripts/migration/transform.ts` | +15 — `timestamp_to_bigint` case in `convert()` (pass-through) + `buildSelect()` (`EXTRACT(EPOCH FROM "<col>")::bigint::text`) |

Local validation (no prod): typecheck clean · green-belt map parses 43 entities / 9 drift cols (none henlo — all rename) ·
T-M1 path still loads exactly 40 · scratch harness **33/33** (real docker) · `timestamp_to_bigint` unit-checked.
NOTE: henlo entities are all `transform=rename` → the henlo import does NOT exercise the new drift cases
(those are Group A/validator); they're added now + unit/scratch-covered, validated for real when Group A imports.

---

## 1. ⚠️ BLOCKING CONFIG ITEM — register `TrackedErc20` on Berachain (do FIRST, before empty-boot)

**The henlo handler is DORMANT until this lands.** It fires only for the HENLO token
(`0xb2F7…6A5`, the only `TOKEN_CONFIGS` entry with `burnTracking+holderStats=true`). HENLO + the 5
HENLOCKED tiers are **Berachain** tokens (envio `config.yaml:923-931`), but ponder registers
`TrackedErc20` on **Base only** (`ponder.config.mibera.ts:253`, and its Base address list wrongly
includes the 6 Berachain tokens — a pre-existing A-1 config error). So today HENLO events never reach
the handler. Required addition to the green/staging config (NOT the live blue config — see §2):

```ts
// Berachain TrackedErc20 — HENLO + HENLOCKED tiers (envio config.yaml:923).
// startBlock = berachain MIGRATION BOUNDARY (NOT envio's 839945 deploy block — pre-boundary
// history comes from the frozen import). TrackedErc20 writes rollups (henlo_holder_stats etc.)
// ⇒ pin to boundary EXACTLY (no finalityOverlap → no double-count). T-M1 bera boundary = 21424739.
TrackedErc20Bera: {                       // or extend TrackedErc20 with a per-chain block
  chain: "berachain",
  abi: Erc20TransferAbi,
  address: [
    "0xb2F776e9c1C926C4b2e54182Fac058dA9Af0B6A5", // HENLO  (the only burn/holder-tracked token)
    "0xF0edfc3e122DB34773293E0E5b2C3A58492E7338", // HLKD1B
    "0x8AB854dC0672d7A13A85399A56CB628FB22102d6", // HLKD690M
    "0xF07Fa3ECE9741D408d643748Ff85710BEdEF25bA", // HLKD420M
    "0x37DD8850919EBdCA911C383211a70839A94b0539", // HLKD330M
    "0x7Bdf98DdeEd209cFa26bD2352b470Ac8b5485EC5", // HLKD100M
  ],
  startBlock: 21424739,
},
```

Open sub-decision for the operator: also FIX the Base `TrackedErc20` list to MiberaMaker333-only
(envio parity)? That touches already-live `tracked_token_balance` rows for those token addresses on Base
(which shouldn't exist — Base has no HENLO/HLKD activity, so likely 0 rows, but verify). Recommend:
verify-then-fix in the full B-1 config (`ponder.config.ts`), not in the henlo spike, to keep the spike narrow.

---

## 2. `build_id` discipline — use a STAGING ponder for the spike (don't disturb live green)

Sprint-M T-M0 finding (migration-A spec App. B): **a schema change after first boot rotates `build_id`
→ ponder treats it as a "different app."** The live green ponder (40 Mibera tables) is **serving Score
right now**. Adding the 8 henlo tables to it = build_id rotation = breakage. So the spike runs on a
**separate staging ponder**:

1. Staging schema = the 40 Mibera tables + the 8 henlo tables (the current `ponder.schema.ts` HEAD of this branch — it's final).
2. Staging config = `ponder.config.mibera.ts` + the §1 Berachain `TrackedErc20` block. **Deployed config MUST equal the empty-boot config exactly** (Sprint-M lesson: even a lone `startBlock` change rotated build_id `30d3d434b0→396e1de377`).
3. Point staging at a fresh `DATABASE_SCHEMA` (e.g. `ponder_b1_spike`) on a staging/scratch Postgres (or vRR1 with a distinct schema) so live `ponder.*` is untouched.

(Full B-1, Phase 1-3: same pattern but the full 83-entity schema → new green ponder → flip in Phase 4.
Live green + blue stay hot as failback the entire time.)

---

## 3. Frozen-import the henlo rows (the proven transform, `--only` the 8 henlo tables)

Connection contract (sacred): `SRC_DATABASE_URL` → envio blue **3vIC** (read) · `DST_DATABASE_URL` →
the staging ponder Postgres (write). `TM2_ALLOW_PROD=I_UNDERSTAND` (set only in the prod-paired session).
`MIGRATION_MAP_PATH` → the green-belt map (so the loader reads the henlo entity defs).

```bash
export TM2_ALLOW_PROD=I_UNDERSTAND
export MIGRATION_MAP_PATH=grimoires/loa/migration/b-1-green-belt-map.yaml
export SRC_DATABASE_URL='<3vIC read URL>'
export DST_DATABASE_URL='<staging ponder URL>'
TSX=node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs

# Step 0 — dry-run (READ-ONLY) → henlo source counts = the parity baseline:
node $TSX scripts/migration/transform.ts --dry-run \
  --only henlo_holder,henlo_holder_stats,henlo_burn,henlo_burn_stats,henlo_global_burn_stats,henlo_burner,henlo_chain_burner,henlo_source_burner

# Step 1 — empty-boot prereq: staging ponder must have booted ONCE on the final schema first
#          (creates the 48 tables + _ponder_meta + _ponder_checkpoint + build_id). The transform
#          asserts every target table exists and hard-errors otherwise.

# Step 2 — real import (triggers-off + idempotent UPSERT automatic, per-entity):
node $TSX scripts/migration/transform.ts --batch 5000 \
  --only henlo_holder,henlo_holder_stats,henlo_burn,henlo_burn_stats,henlo_global_burn_stats,henlo_burner,henlo_chain_burner,henlo_source_burner
```

henlo_holder is ~46,073 rows (App. A); the rest are smaller. All `rename` — no drift conversion runs.

---

## 4. Forward-index + the GATE (measure → confirm all-43 viable)

- With §1's Berachain `TrackedErc20` registered, staging ponder forward-indexes henlo from the boundary.
- **Measure** (this is the spike's purpose): cold-sync throughput (blocks/sec on bera+base for this contract)
  + HyperRPC request budget consumed (≤100 RPM ceiling) → extrapolate the all-43 / 2-new-chain cost.
- **Validate** (Sprint-M T-M3 method): per the 8 tables, `count(staging ponder) == count(blue 3vIC)` +
  id-set checksum (`md5(string_agg(id ORDER BY id))`).
- **Runtime parity spot-check** (FAGAN finding #1): pick a known incinerator burn (source contract
  `0xde81b2…80b8cc`, envio `HENLO_BURN_SOURCES`) and confirm ponder resolved `source='incinerator'`
  (not `'user'`) in `henlo_burn` + that `henlo_global_burn_stats.incinerator_burns > 0`. This confirms
  `event.transaction.from/.to` are populated (they are — the live balance path already uses `event.transaction.hash`).

**GATE**: henlo live in staging ponder + count/checksum parity + a sane measured cost → confirm the all-43
plan is viable → proceed to Phase 1. If a surprise (cost blowup, parity miss) → escalate before Phase 1.

---

## 5. What this session can't do autonomously (the operator-paired part)

- Empty-boot / deploy the staging ponder → **Railway** (CLI `Unauthorized` in-session; per migration-A §8
  the Railway GraphQL API via `curl` Bearer works, or operator does it).
- Open prod DB connections → `SRC/DST_DATABASE_URL` are **operator-supplied per run** (not in-session).

Hand me a working Railway path + the two connection URLs and the build session runs §1-§4 end-to-end to the gate.

---

## Open nits (full-run, not spike blockers)
- The green-belt map header says "44 live" in places (lines ~41/43/85) but parses to **43** (handler-gap §5 sums to 43: 9+6+3+8+6+5+4+2). 43 is correct; reconcile the "44" comments before Phase 1.
- entity-map.ts strict-40 guard is path-keyed (a symlink to the T-M1 file could bypass it) — optional `realpath` hardening; irrelevant to the spike (transform uses the default path for T-M1, the env override for green-belt).
