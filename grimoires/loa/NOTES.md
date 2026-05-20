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
- **S1 COMPLETE — eRPC L2 substrate live on Railway** (2026-05-20, operator-paired):
  - S1-T2 — `freeside-sonar` Railway project (the honey jar ws, id `e240cdf0`) created;
    `Postgres` cache service + `erpc` service deployed. `erpc` builds from `Dockerfile.erpc`
    (digest-pinned eRPC v0.0.64 + baked-in `erpc.yaml`); `ERPC_DATABASE_URL` →
    `${{Postgres.DATABASE_URL}}` (private ref, no inline secret).
  - S1-T3 — cache Postgres = Railway default size ("start small" per OD-2 / R-4).
  - S1-T4 — smoke-verified: eRPC answers `80094` JSON-RPC (chainId `0x138de`, blockNumber,
    getLogs 9270 logs); a repeated finalized getLogs is **served from cache** (log-confirmed
    — `ttl: 0` = cache-forever; audit Concern-1 / the `ttl:0` assumption RETIRED); failover
    observed (publicnode 503'd, eRPC served via the other 3; all 4 upstreams synced).
  - **Deploy findings folded into `erpc.yaml`**: eRPC needs `httpHostV6: "::"` — Railway
    routes to containers over IPv6, IPv4-only bind → 502 (S0 missed it: local Docker is
    IPv4). `logLevel` warn→info for the verification window — REVERT to warn at cycle
    steady-state. The eRPC image EXPOSEs 3 ports (4000/4001/6060) → a Railway public domain
    needs an explicit `targetPort: 4000` (runbook note; private networking is unaffected).
  - eRPC internal address for S2: `http://erpc.railway.internal:4000/main/evm/80094`.
  - Residual: temp public smoke-test domain `erpc-production-0437.up.railway.app` — removal
    staged via config patch; if it lingers, remove in Railway dashboard (Settings→Networking).
- **S2-T1 COMPLETE + review+audit APPROVED** (2026-05-20, `/run sprint-2`) —
  `config.mibera.yaml` chains[0] data source `hypersync_config` → `rpc`
  (`http://erpc.railway.internal:4000/main/evm/80094`, `for: sync` — eRPC as primary
  source, not a HyperSync fallback); `verify-belt-config.js` green; `/review-sprint`
  "All good (with noted concerns)"; `/audit-sprint` "APPROVED" (0 CRIT/HIGH/MED); both
  cross-model dissents clean. Ledger: **S2 (170) → in_progress** (NOT completed — T2-T5
  pending). `COMPLETED` marker scoped to the run's S2-T1 autonomous scope.
  - **Finding (drift_resolution: code)**: SDD §4.1 / sprint.md S2-T1 say `rpc_config`;
    installed Envio v3.0.0-alpha.14 schema field is `rpc` (no `rpc_config`). Implemented
    with the correct `rpc` — SDD §4.1 text should be reconciled `rpc_config`→`rpc`.
  - **S2-T3 charge** (from review): confirm the belt's sync traffic actually reaches eRPC
    (retires the `for: sync` HyperSync-disabled assumption — eRPC `info` logs will show
    belt requests); decide `interval_ceiling: 30000` from observed getLogs behaviour.
- **S2-T2 COMPLETE — belt build gate green** (2026-05-20, operator-paired):
  `pnpm verify:belt-config` ✓ · `pnpm codegen:mibera` (scoped, exit 0) ✓ ·
  `pnpm typecheck:mibera` (exit 0, clean) ✓. Wired as CI — `.github/workflows/belt-build.yml`
  (3-gate job; AC-11). `package.json` gains `codegen:mibera` + `typecheck:mibera` scripts.
  - **DISS-002 (S2-T2 finding — sibling of DISS-001)**: belt-scoped `envio codegen` (the
    DISS-001 fix) generates `generated/` for the 2 Mibera contracts only; a whole-repo
    `tsc --noEmit` then fails — the 27 non-belt monolith handlers import generated types
    belt-scoped codegen never produced (~210 errors: TS2305/2724 missing-member + a
    TS7031 implicit-any cascade). The belt's OWN files (`mibera-*.ts`, `src/belts/mibera/`)
    were clean. **Resolution (operator decision, 2026-05-20)**: `tsconfig.mibera.json` —
    a per-belt typecheck config rooted at `src/belts/mibera/`, typechecking only the
    belt's import closure. Factory invariant: every belt gets a `tsconfig.<belt>.json`
    (parallels `config.<belt>.yaml` + `src/belts/<belt>/`). AC-3's "`tsc --noEmit` clean"
    is met as the **belt-scoped** typecheck — whole-repo tsc is structurally incompatible
    with DISS-001's belt-scoped codegen. SDD §5 / AC-3 to be reconciled to name the
    belt-scoped gate (drift_resolution: code).
  - Also resolved an S2-T4 open question: `envio codegen` **does** support `--config`
    (v3.0.0-alpha.14) — no copy-to-`config.yaml` needed at deploy.
- **S2-T3 → DISS-003: Envio cannot sync Berachain via EITHER data source** (2026-05-20,
  operator-paired). The local dev run surfaced the cycle's pivotal finding. Root cause,
  proven end-to-end after clearing several local-debug layers:
  - **RPC sync is broken for Berachain.** With `generated/` re-codegen'd against a
    *reachable* RPC (`rpc.berachain-apis.com`) and a fresh DB, the indexer reaches the
    endpoint, pulls blocks, and **fails parsing every one**:
    `[rescript-rest] Failed parsing response at ["data"]["result"]["totalDifficulty"].
    Reason: Expected string | null, received undefined`. Envio v3.0.0-alpha.14's RPC
    block parser **requires `totalDifficulty`**; Berachain (post-merge PoS) omits it.
    eRPC is a transparent JSON-RPC proxy — belt→eRPC→public-RPC carries the SAME omission,
    so eRPC does NOT fix this unless it can inject `totalDifficulty` (unverified; not a
    default eRPC feature).
  - **HyperSync now requires a token.** Switching the source to HyperSync crashes at init:
    `An API token is required for using HyperSync as a data-source. Set ENVIO_API_TOKEN…
    get a free API token at https://envio.dev/app/api-tokens`. **This is almost certainly
    the original "fire"** — the indexer used HyperSync, HyperSync made the token mandatory,
    `/backing` broke (PRD G1).
  - **Architecture implication**: r4's premise (belt indexes Berachain over JSON-RPC
    through eRPC) is **not viable as-is** — Envio's RPC source can't parse Berachain. The
    likely simplest fix to PRD G1 is **HyperSync + a free `ENVIO_API_TOKEN`** — which
    reframes eRPC's role (the whole eRPC pivot may have been solving an avoidable problem).
  - **Local-debug layers cleared en route** (all secondary to the above): codegen embeds
    the data source — `generated/` had a stale unreachable `erpc.railway.internal` baked
    in, so config edits did nothing until re-codegen (this masked the real error as
    `knownHeight: 0`); the Ink TUI crashes non-TTY (`TUI_OFF=true`); port-9898 lingers
    across runs; `docker-credential-desktop` missing from envio's PATH (Docker.app bin).
  - **S2-T2's build gate (codegen + belt typecheck + CI) stands** — the verified S2
    checkpoint. S2-T3/T4/T5 blocked pending an architecture decision.
  - **Salvage investigation (operator chose "salvage eRPC/RPC", 2026-05-20)** — both
    RPC-salvage routes hit walls: (1) **eRPC does NOT inject `totalDifficulty`** — ran
    eRPC locally (docker) against the public cluster; its `eth_getBlockByNumber` passes
    the upstream response through unchanged (no `totalDifficulty`). Not a default feature.
    (2) **Envio alpha.14 → 3.0.0 stable is a BREAKING bump** — stable's handler-
    registration API differs; the reused handlers register zero events
    (`Invalid configuration: Nothing to fetch on chain 80094 … eventConfigs=0`), so the
    bump can't even reach the `totalDifficulty` stage to confirm a fix. (Pinned
    `3.0.0-alpha.14`; stable `3.0.0` / next `3.0.1` exist.) Reverted; tree clean.
    **Net**: salvaging RPC needs EITHER a custom `totalDifficulty`-injection shim (new
    code) OR a full Envio alpha→stable migration (handler-API rewrite, monolith-wide,
    then re-test) — neither is quick. **HyperSync + a free `ENVIO_API_TOKEN` remains the
    simplest restore for PRD G1.**
- Next: **operator decision** — HyperSync+token (simple restore) vs the Envio 3.0.0
  migration vs a custom totalDifficulty shim. DISS-003 invalidates r4's RPC premise
  as-is. Then S2-T3+ → S3.

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
