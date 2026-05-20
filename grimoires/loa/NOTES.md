# Session Notes

## Current Focus
- indexer-belt-rebuild **RE-SPRINTED against SDD r4 §12** (2026-05-19, `/sprint-plan`) —
  `sprint.md` regenerated for the L0–L6 bottom-up stack: **S0** eRPC calibration spike →
  **S1** build the eRPC L2 substrate (`erpc.yaml` + dedicated Railway service + cache
  Postgres) → **S2** re-point the Mibera belt to eRPC + verify → **S3** L5 gateway / §7
  observability / hardening / staged handback. 18 tasks across 4 sprints.
- The completed belt-config Sprint 1 (`config.mibera.yaml` + `verify-belt-config.js` +
  `src/belts/mibera/`) is **reused, not redone** — S2-T1 modifies the existing config's
  data-source key only (`hypersync_config` → `rpc_config` → eRPC). r3's HyperSync data
  source is retired by r4.
- Ledger: `indexer-belt-rebuild` cycle registered (was previously unregistered) —
  4 sprints, global ids 168–171; `active_cycle` set to `indexer-belt-rebuild`. Note:
  the completed belt-config Sprint 1 predates ledger registration and is not
  retroactively listed.
- S0 COMPLETE (2026-05-20) — free public Berachain RPC + eRPC cold-sync measured
  (~39k blk/s cold, ~192k warm, 0 rate-limiting; encouraging for H1).
- **S1-T1 COMPLETE + review+audit APPROVED** (2026-05-20, `/run sprint-1`) — `erpc.yaml`
  authored + eRPC-v0.0.64-validated; `/review-sprint` "All good (with noted concerns)";
  `/audit-sprint` "APPROVED - LETS FUCKING GO" (0 CRITICAL/HIGH/MEDIUM); both cross-model
  dissents clean. `COMPLETED` marker written (scoped to the run's S1-T1 autonomous scope).
  Run JACKED_OUT — hands back. Ledger: S0→completed, **S1 (169)→in_progress** (NOT
  completed — T2-T4 pending).
- Next: **S1-T2/T3/T4** — operator-paired Railway provisioning (dedicated eRPC service
  + cache Postgres, sizing, smoke-verify). Then S2 (re-point the Mibera belt to eRPC).

## Prior Focus (superseded by r4 re-sprint)
- indexer-belt-rebuild Sprint 1 COMPLETE (2026-05-20, `/run sprint-1`) —
  `config.mibera.yaml` + `verify-belt-config` + belt entrypoint; implement→review→audit
  all APPROVED (commits 1052125, 8cb08ce, 9a97c1a).

## Decisions
- Installed Loa framework with full configuration matching midi-interface setup
- /ride 2026-05-19: regenerated all reality artifacts. Framework cycle-112 PRD/SDD
  archived to `archive/cycle-112-*-framework.md`; `prd.md`/`sdd.md` now document the
  indexer itself.
- Phase 8 (legacy deprecation) deliberately skipped — README/SCALE/DEPLOYMENT_GUIDE
  are active operational docs, not superseded. See `trajectory-audit.md`.
- Sprint 1 (indexer-belt-rebuild · `/run sprint-1` · 2026-05-20): authored
  `config.mibera.yaml` (S1-T1) + `scripts/verify-belt-config.js` + `test/verify-belt-config.test.ts`
  (S1-T2). Belt config is a verbatim extract of `config.yaml`'s 2 Mibera contracts; the
  verify gate mechanically enforces field_selection/address/start_block fidelity (SDD
  §5.3). AC-2 + AC-11 met; 9/9 tests pass. No `src/` changes. beads bd-3eb/bd-11o closed.
- Discovered, pre-existing, NOT introduced by Sprint 1 (logged, not fixed — Karpathy
  surgical-changes; the full `codegen + tsc` build gate is Sprint 2 / S2-T3):
  bd-1kg — `src/handlers/sf-vaults.ts` fails `tsc --noEmit` (~7 errors; surfaced when
  `node_modules` was hydrated to the lockfile — stale `typescript 5.2.2` had masked them;
  `sf-vaults` is an archived contract; `generated/` is stale (Feb 15) so S2-T3 codegen
  may resolve). bd-3nb — no `vitest.config` → `pnpm test` sweeps the whole repo (296
  framework files fail to collect); `test/fatbera-core.test.ts` imports removed `chai`.
- `node_modules` was stale (pre-vitest mocha/chai era) — hydrated via
  `pnpm install --frozen-lockfile`; `package.json` + `pnpm-lock.yaml` unchanged.
- Sprint 1 review (2026-05-20) — BLOCKING cross-model finding DISS-001 (bd-12q): a
  belt-scoped `config.mibera.yaml` cannot build against the monolith barrel
  `src/EventHandlers.ts` (scoped `envio codegen` → `generated/` missing 39 contracts →
  their handler modules fail to resolve). SDD §3.2 "handlers reused as-is, zero code
  changes" + `sprint.md:22` "no handler changes anywhere" are incompatible with a
  scoped config + monolith entrypoint — an SDD-level gap, not an implementation defect.
- **Decision (operator, 2026-05-20, `/run sprint-1`)**: amend SDD §3.2 / `sprint.md:22`
  in effect — per-belt handler **registration entrypoints** are permitted as additive
  scaffolding (handler *logic* unchanged). Deployment #1 adds `src/EventHandlers.mibera.ts`;
  HoneyJar/Purupuru/Sprawl belts will each get their own. config.mibera.yaml's `handler:`
  fields repoint to it; `verify-belt-config` refined to compare field_selection/address/
  start_block excluding the `handler:` line (SDD §5.3's actual scope). Formal SDD
  reconciliation deferred (drift_resolution: code).
- DISS-001 fix CORRECTED (cycle 3, 2026-05-20): the cycle-2 belt entrypoint was
  necessary but insufficient. Envio's `HandlerLoader.registerAllHandlers` always runs
  `autoLoadFromSrcHandlers(config.handlers)` — globs the top-level `handlers:` directory
  (defaults `src/handlers`) and imports every module, independent of the per-contract
  `handler:` field (verified vs `node_modules/envio/src/HandlerLoader.res.mjs`). Fix:
  belt entrypoint relocated to `src/belts/mibera/EventHandlers.mibera.ts`;
  `config.mibera.yaml` gains top-level `handlers: src/belts/mibera`. Factory-model unit
  is a per-belt directory `src/belts/<belt>/`. Autoload glob scope verified empirically.
- S0 (re-sprint, 2026-05-20): eRPC calibration spike — 4 public Berachain 80094 RPC
  endpoints verified (anonymous, no keys); cold-sync measured ~39k blk/s cold /
  ~192k warm (4.9x cache), 0 rate-limiting; extrapolated full cold-sync
  minutes-to-low-hours. H1 strongly encouraging. See `grimoires/loa/spikes/s0-erpc-calibration.md`.
- S1 (re-sprint eRPC L2, `/run sprint-1`, 2026-05-20): **S1-T1 done** — `erpc.yaml`
  authored (4 Berachain public upstreams + postgresql cache + reorg-safe finalized/
  unfinalized policies + hedge/retry/timeout failsafe; multi-chain-additive; zero inline
  secrets; schema-validated vs eRPC v0.0.64). **S1-T2/T3/T4 are operator-paired** Railway
  infra (dedicated eRPC service + cache Postgres, sizing, deployed-URL smoke-verify) —
  designated `(operator-paired)` in `sprint.md`; the run does S1-T1 then hands back. S1
  is not COMPLETE until the operator does T2-T4.

## /ride Results (2026-05-19)
- Target: thj-envio (freeside-sonar) — THJ Envio HyperIndex V3 indexer
- Handlers documented: 84 event handlers across 31 modules
- Entities: 93 GraphQL types | Contracts: 41 definitions | Chains: 6
- Drift score: 8.5/10 (0 ghosts, 0 hallucinations, 4 stale, 2 shadows)
- Consistency score: 8/10
- Governance gaps: 3 (no indexer release tags, CHANGELOG/SECURITY scope mismatch)
- Tech debt: 5 TODOs, 0 FIXME/HACK — LOW density

## Key Findings (for human decision)
- CRITICAL hygiene: Loa framework content (docs/, tests/, CHANGELOG.md, simstim/,
  lib/, tools/, evals/) is mixed into the indexer repo root. Indexer code is `src/`
  + `config.yaml` + `schema.graphql` only. See `reality/hygiene-report.md`.
- `BERACHAIN_TESTNET_ID = 80094` is mislabeled — 80094 is mainnet. Rename via /implement.
- `seaport.ts` handler exists but its config contract is commented out — decide fate.
- Only 1 indexer test (`test/fatbera-core.test.ts`) for 84 handlers — coverage risk.

## Blockers

None. (bd-1ra resolved 2026-05-20 — `origin` + `upstream` remotes configured;
`indexer-belt-rebuild` pushed; draft PR #13 open on `0xHoneyJar/sonar-api`.)
