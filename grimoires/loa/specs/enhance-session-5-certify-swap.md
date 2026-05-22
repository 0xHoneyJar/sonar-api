# Session 5 — sonar-belt-factory: Certify Green (6-chain consolidated) + Gate Expansion-Mode + Blue→Green Swap

> Blue (4-chain mibera belt) has served the alias flawlessly while green (the 6-chain consolidated belt) backfilled in the dark. This session proves green is non-lossy, then flips the alias — zero consumer downtime — and retires blue.

> **Mode**: ARCH/SHIP — BARTH (the-arcade) + protocol/noether, craft lens. **Operator-paced** at every infra/$ branch. **Kickoff**: skip-dig (research = session 4). **Date**: 2026-05-22.

## Context

Session 4 shipped **S1** (the reconciliation gate, `scripts/promotion-gate.js` — review+audit APPROVED, 18/18, COMPLETED) and stood up **green** as the **6-chain consolidated belt** (`config.yaml`: ETH 1, OP 10, Base 8453, **Arbitrum 42161 [NEW]**, Berachain 80094, **Zora 7777777 [NEW]**, 41 contracts). Green = `belt-indexer-green` + `Postgres-vRR1` (isolated) in `freeside-sonar/production`, seeded (BB-F006 `COUNT==6` PASS), now **cold-syncing all 6 chains** (resume confirmed). Blue = `belt-indexer` + `belt-hasura` + `Postgres-3vIC`, still serving the Caddy `belt-gateway` alias.

This is an **EXPANSION promotion** (green ⊋ blue), not a parity dry-run — the operator chose to combine green-build with full-coverage expansion (NOTES Decision Log 2026-05-22). That has three consequences this session must honor (see Design Rules): the gate needs an **expansion-mode**, the 2 new chains have **no blue baseline** (raw-L1 ground-truth is the only check), and `belt-hasura-green` must exist before the gate can query green over GraphQL.

**Session 5 = make green certifiable, certify it, swap, retire blue.**

## Load Order
1. `grimoires/loa/NOTES.md` → **Session Continuity** (green live-state) + **Decision Log** (expansion scope, deferred ACs) — the resume ground truth.
2. `grimoires/loa/known-failures.md` — KF-012 (getLogs-liar → raw-L1 discipline), KF-013 (`--restart`-seeds-then-resume; **never** chase 28P01 / sslmode), KF-014 (BB enrichment dead on headless → accept Pass-1).
3. `scripts/promotion-gate.js` + `test/promotion-gate.test.ts` — the gate to extend (parity mode shipped; add expansion-mode).
4. `grimoires/loa/sdd.md` §6 (gate), §4 (alias), §7 (Caddy swap, Option B), §8 (rollback), §9.2 (expand/contract), §17 (R-A..R-G).
5. `grimoires/loa/sprint.md` — S2/S3/S4 + SR-1..SR-7. `grimoires/loa/runbooks/belt-reinit.md` — KF-013 dance.
6. `grimoires/loa/a2a/sprint-173/{reconciliation-feasibility,alias-contract}.md` — the 3 reconciliation modes + the swap lever.

## Persona
SHIP/ARCH — BARTH + protocol/noether, craft lens. Operator-paced from any Railway/$/Caddy/live-promotion step. Code (gate expansion-mode, Part-4, promote.sh) goes through `/implement → review → audit`. Infra (hasura-green, swap, delete-blue) is operator-driven, agent-assisted.

## Railway access (carried from session 4)
- Project token at `~/.railway-green.tok` (mode 600). Use as `RAILWAY_TOKEN="$(cat ~/.railway-green.tok)" railway …`. **Reads work; writes need it; `railway whoami` fails under it — expected (project token has no user identity).** **REVOKE this token in Railway when the cycle ships.**
- Green deploys via `railway up -s <svc>` (local dir; **no push** — blue untouched).
- Project = `freeside-sonar` / env `production`. Services: blue (`belt-indexer`,`belt-hasura`,`Postgres-3vIC`) · green (`belt-indexer-green`,`Postgres-vRR1`) · shared (`belt-gateway`,`erpc`).

## Pre-flight — is green converged?
```bash
cd <repo>
export PGDIR="$PWD/node_modules/.pnpm/postgres@3.4.8/node_modules/postgres"
export PGURL="$(RAILWAY_TOKEN="$(cat ~/.railway-green.tok)" railway variables --service Postgres-vRR1 --json | jq -r '.DATABASE_PUBLIC_URL')"
node -e 'const p=require(process.env.PGDIR);const s=p(process.env.PGURL,{ssl:{rejectUnauthorized:false}});(async()=>{const r=await s`select chain_id,block_height,latest_processed_block from chain_metadata order by chain_id`;for(const x of r)console.log(`chain ${x.chain_id}: ${x.latest_processed_block}/${x.block_height} (${((x.latest_processed_block/x.block_height)*100).toFixed(1)}%)`);await s.end()})()'
```
Converged = `latest_processed_block` within block-production distance of `block_height` on **all 6** (Base 8453 is the long pole per KF-012). If not converged, the cold-sync is still running — do gate/Part-4 code work and re-check.

## What to Build (dependency-ordered)

### 1. `belt-hasura-green` (infra — operator-paced)
Green's serving layer (the gate queries it; it's the swap target). Mirror blue's `belt-hasura`: hasura/graphql-engine image (get blue's exact tag from the Railway dashboard → `belt-hasura` → Settings → Source, or pin a stable `v2.x`) → `${{Postgres-vRR1.*}}`. Set the same non-secret vars blue has: `HASURA_GRAPHQL_ENABLE_CONSOLE=false`, `HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES=true` (critical — big ints), `HASURA_GRAPHQL_UNAUTHORIZED_ROLE`, `HASURA_GRAPHQL_NO_OF_RETRIES`, an admin secret, `HASURA_GRAPHQL_DATABASE_URL=${{Postgres-vRR1.DATABASE_URL}}`. Then set `belt-indexer-green` `HASURA_GRAPHQL_ENDPOINT` + `HASURA_GRAPHQL_ADMIN_SECRET` → green hasura (resolves the harmless ECONNREFUSED in the seed logs; enables table tracking so green's GraphQL serves the entities).
```bash
RAILWAY_TOKEN="$(cat ~/.railway-green.tok)" railway add -s belt-hasura-green -i hasura/graphql-engine:<tag> \
  -v 'HASURA_GRAPHQL_DATABASE_URL=${{Postgres-vRR1.DATABASE_URL}}' -v 'HASURA_GRAPHQL_ENABLE_CONSOLE=false' \
  -v 'HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES=true' -v 'HASURA_GRAPHQL_UNAUTHORIZED_ROLE=public' -v 'HASURA_GRAPHQL_ADMIN_SECRET=<gen>'
```

### 2. Gate EXPANSION-mode — `scripts/promotion-gate.js` (`bd-umw.6`, /implement, test-first)
The net-new design. Green ⊋ blue, so parity (`|green−blue|≤tol`) fails by construction. Add a mode-aware reconciliation:
- **Tag each `FOOTPRINT` entity** `presence: 'shared' | 'new'` (shared = exists in blue's 4-chain belt; new = only in green, from Arbitrum/Zora or new contracts) + optional per-chain attribution.
- **`runGate(blue, green, { mode })`** where `mode: 'parity' | 'expansion'`:
  - **parity** (the dry-run / additive-field case): unchanged — keep the 18 tests green.
  - **expansion**: for **shared** entities → assert `green ≥ blue − floor` (NON-LOSSY non-regression, green MAY exceed); for **new** entities → **no blue compare**, defer to Part-4 raw-L1 (step 3). Block-height: green ≥ blue on the 4 shared chains; new chains validated by raw-L1 at-head.
  - Schema (Part 3): unchanged — green ⊇ blue (additive, incl. the enum value-set check from DISS-001).
- **Fail-closed** stays absolute (SR-7a/IMP-004): unknown → FAIL.
- Add expansion-mode tests (shared non-regression PASS/FAIL; new-entity routed-to-raw-L1; mixed snapshot). Keep all 18 parity tests.

### 3. Part-4 raw-L1 ground-truth + content sample — `makeFetchSnapshot` live impl (`bd-umw.7`, /implement)
The S1-deferred ACs, now **load-bearing** (the ONLY correctness check for Arbitrum/Zora). Implement `makeFetchSnapshot(env)` to build a real snapshot from a deployment's Hasura GraphQL: per-MODE entity counts (A at-block via `where blockNumber<=cutoff`, B Action timestamp-proxy, C converged current-state), `chain_metadata` heights, schema introspection. Then **Part-4**: raw `eth_getLogs` spot-check **bypassing eRPC cache** for sampled (chain, contract, block-range) — use a **dedicated low-tier RPC key** (NOT the eRPC pool it's bypassing), exponential backoff + jitter (SR-4), against **golden entity IDs** (SR-5). Treat an empty-200 as a GAP, not a pass (KF-012). For new chains, this is the whole correctness story.

### 4. Certify green (operator-paced — run the enhanced gate)
With green converged + hasura-green serving + gate expansion-mode + Part-4 wired: run `node scripts/promotion-gate.js` (env: `BLUE_GRAPHQL_URL`=blue alias/hasura, `GREEN_GRAPHQL_URL`=green hasura, `PROMOTION_MODE=expansion`, RPC key). Expect: shared entities non-lossy (green ≥ blue), new chains raw-L1-verified, schema superset. Gate writes `a2a/sprint-173/promotion-reconciliation.md`. Exit 0 = green certified.

### 5. Swap + rollback (S3 — `bd-c09.*`, operator-paced)
- `scripts/promote.sh` (`bd-c09.4`/SR-3): the ONLY swap path — runs `promotion-gate.js` as a **non-skippable precondition** (fails closed on non-zero), then is the sole writer of `BELT_UPSTREAM` (→ green hasura) / the Caddy reload.
- Caddy `belt-gateway` admin localhost-only + `caddy reload` swap (`bd-c09.1/.2/.3`, Option B §7.4) — zero-downtime probe (no 5xx during swap). If localhost-admin infeasible on Railway → Option C (≥2 replicas) per §7.4 (no re-decision).
- Rollback: revert `BELT_UPSTREAM`→blue; blue kept hot + at-head through the window (R-A). Exercise it.

### 6. Retire blue + finish
After the rollback window with green serving clean: delete `belt-indexer` + `belt-hasura` + `Postgres-3vIC` (blue). Then S4 (`bd-kgx.*`: FR-1 one-belt note, FR-9 score-api boundary, FR-10 reserve, E2E G1-G4) → **`/run-bridge 3`** over the shipped diff (expect KF-014: BB Pass-2 enrichment dead on headless — accept Pass-1).

## Design Rules
- **Expansion ≠ parity**: green is allowed to have MORE; the gate enforces *no LESS* on shared data + *positively verifies* new data against L1. Never demand green==blue.
- **New chains have no safety net but raw-L1** — Part-4 is not optional for Arbitrum/Zora. An empty getLogs-200 is a GAP (KF-012), never a pass.
- **Fail-closed, non-skippable**: the swap happens ONLY through `promote.sh` after gate exit 0 (R-D). No bare `BELT_UPSTREAM` edits.
- **Blue stays hot + at-head** until after the rollback window (R-A) — lossless rollback.
- **Wipe-blue guard**: any green DB op references `${{Postgres-vRR1.*}}`; never `Postgres-3vIC`. KF-013: don't chase 28P01, don't touch sslmode.
- **Craft (the report is the UX)**: `promotion-reconciliation.md` + `promote.sh` output must make PASS/FAIL + per-check evidence scannable — the operator decides go/no-go from it. `--font-mono` discipline doesn't apply (CLI), but legible per-entity/per-chain deltas do.

## What NOT to Build
- Don't re-litigate S1 (gate parity logic + the 3 deferred ACs are accepted — the deferrals are now being *implemented* as Part-4, not reopened).
- Don't reintroduce the 12-belt federation (retired) or a query-time federation gateway.
- Don't use HyperSync as a *ground-truth* shortcut for new chains (anti-sovereign; raw-L1 is the chosen check — HyperSync stays break-glass for backfill speed only).
- Don't swap before gate exit 0. Don't delete blue before the rollback window closes with green clean.
- Don't let autonomous mode provision Railway / run the live promotion — operator-paced.

## Verify (cycle done when)
- **G1** zero-downtime: swap probe shows 0 5xx on the alias during `caddy reload`.
- **G2** cost < $100/mo steady-state (green replaces blue post-retire; 2× only during the window).
- **G3** 0 consumer config changes across the swap; gate reconciliation = no dropped entity (non-lossy on shared).
- **G4** gate enforced as swap precondition (exit 0 required); rollback exercised.
- New chains (Arbitrum/Zora) raw-L1-verified present. `/run-bridge 3` complete, findings triaged.

## Key References
| Topic | Path |
|---|---|
| Live green-state + decisions | `grimoires/loa/NOTES.md` (Session Continuity + Decision Log) |
| Gate (extend) | `scripts/promotion-gate.js` + `test/promotion-gate.test.ts` |
| Design / §6 §7 §8 §9.2 §17 | `grimoires/loa/sdd.md` |
| Plan / SRs | `grimoires/loa/sprint.md` |
| Green-build dance | `grimoires/loa/runbooks/belt-reinit.md` |
| Alias contract / recon modes | `grimoires/loa/a2a/sprint-173/{alias-contract,reconciliation-feasibility}.md` |
| Known failures | `grimoires/loa/known-failures.md` (KF-012/013/014) |
| Beads (next scope) | `bd-umw.6/.7` (gate+Part-4) · `bd-umw.1/.3/.4/.5` (S2) · `bd-c09.*` (S3 swap) · `bd-kgx.*` (S4) |
