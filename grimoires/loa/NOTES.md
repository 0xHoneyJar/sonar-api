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
  - **RESOLUTION (2026-05-20, validated): bump Envio alpha.14 → alpha.16 — the sovereign
    path holds.** Per Envio [#994](https://github.com/enviodev/hyperindex/issues/994) /
    [#998](https://github.com/enviodev/hyperindex/pull/998) the totalDifficulty parse bug is
    fixed from **alpha.16**. Tested alpha.16 (invoking the platform binary directly — see bin
    caveat): codegen clean; **no `eventConfigs=0`** (handler API preserved — the break is only
    at *stable* 3.0.0, NOT the alphas); and **no totalDifficulty error** on two fresh endpoints.
    The only remaining error is per-endpoint rate-limiting (Cloudflare 1015 on berachain-apis;
    QuickNode `-32008` 250/min on berachain.com) — **exactly what eRPC absorbs** (hedge across
    the 4-endpoint cluster + finalized-block cache). Validated sovereign architecture:
    **belt → eRPC → free Berachain RPC cluster, on envio alpha.16+** — no HyperSync, no token,
    no hosted dependency. The ~40-line totalDifficulty-injection shim (PoC proven) is the alpha.14
    fallback; alpha.16 makes it unnecessary.
    - **Bin caveat (adoption detail)**: `envio@3.0.0-alpha.16` npm package has NO `bin` field
      (alpha.14 had `bin: ./bin.js`); pnpm didn't link `envio`, so `pnpm envio` fails. The
      platform binary lives at `node_modules/.pnpm/envio-darwin-arm64@.../bin/envio`. Adoption
      must pin an alpha (16–24) whose package re-exposes a working bin, OR invoke the platform
      binary directly in Railway build/start commands. (HyperSync server is closed-source — no
      self-host; eRPC can't inject response fields — both confirmed by web research.)
- **DISS-003 FIX APPLIED (2026-05-20): pinned `envio@3.0.0-alpha.17`** (expert-endorsed
  "A-prime"). alpha.17 = PR #998 totalDifficulty fix **+ the alpha.15/16 binary-packaging fix**
  (resolves the alpha.16 bin caveat — `pnpm envio` works again) **+ below the alpha.23 "New
  Handlers API" break** (handlers stay unchanged). Validated: `pnpm envio` ✓ · codegen ✓ ·
  `typecheck:mibera` ✓ · `verify-belt-config` ✓ · `envio start` reaches "Starting indexing"
  (eventConfigs>0) with no totalDifficulty error. Exact version pin (no caret). config.mibera.yaml
  unchanged (belt → eRPC; exact start_blocks already set, not genesis). Committed.
  - **Forward plan (from the expert consult)**: (1) **benchmark eRPC cold-sync** on a 100k–250k
    block slice — decide if a one-time *bounded* HyperSync+token backfill is needed for the cold
    sync (then continue sovereign on eRPC, with event-count reconciliation); (2) keep the
    totalDifficulty shim (PoC) as a *disabled-but-deployable* break-glass only — alpha.17 makes it
    unnecessary; (3) toward true sovereignty: run our **own Berachain node** behind eRPC (eRPC today
    = sovereign routing/cache, not sovereign data origin); (4) **stable V3 migration LATER, by
    EXTRACTION** — migrate the /backing belt to stable's `indexer.onEvent` API first, then the
    ~30-handler monolith — not a monolith-shock bump.
- **S2-T3 EMISSION PROOF — substantively PASS (2026-05-20, operator-paired)**, with two HIGH
  infrastructure findings surfaced + fixed (config-only). Local run: belt → local eRPC (4 public
  upstreams) → Berachain; Postgres :5433 / Hasura :8080 (secret "testing"); envio alpha.17.
  - **3 §6 queries**: ① `MiberaLoan` non-empty ✅ · ② `MiberaTransfer` non-empty ✅ ·
    ③ `MintActivity{amountPaid>0}` ⚠️ **UNSATISFIABLE BY REALITY** — `max(amountPaid)=0` across
    all 10,000 mints; **Mibera was a 100% free mint** (belt `amountPaid` matches on-chain tx
    `value=0` exactly via `eth_getTransactionByHash` — the §5 `value` field PROVABLY flows; there
    is simply no paid mint to match the predicate). AC-4 substance (both handlers emit correct,
    contract-scoped data) is MET. **Recommend reconciling the AC**: query 3's "≥1 row amountPaid>0"
    cannot pass for a free-mint collection — replace with a value-flow check that holds (e.g.
    assert MintActivity rows exist AND amountPaid is a populated bigint field), or drop the `_gt:0`.
  - **FINDING A — silent getLogs data loss (HIGH).** `rpc.berachain-apis.com` returns empty `[]`
    with **HTTP 200** for historical *filtered* `eth_getLogs` (proven 0 logs vs publicnode's
    9306/176/6/1 across 4 ranges; lies at ALL window sizes incl. 2k; serves blocks fine). eRPC's
    `markEmptyAsErrorMethods` does **not** include `eth_getLogs`, and eRPC's hedge takes the first
    non-error answer — so berachain-apis (the FASTEST responder ~85ms) wins the race and its lie is
    accepted. First cold sync silently dropped ~95% of logs (585 transfers, **0 mints**). Invisible
    to the DISS-003 "Starting indexing" check — only a data-completeness pass catches it. See KF-012.
  - **FINDING B — per-IP rate-limit stall (HIGH, coupled to A).** Removing berachain-apis entirely
    fixed completeness (10,000 mints) but put all block/tx + getLogs load on publicnode → Cloudflare
    429 with multi-minute `retry-after` → sync froze at block 3,965,807 (0.7%). Root cause = a
    per-second rate burst spiral in dense regions, NOT a long ban (all upstreams recover in seconds
    once load stops).
  - **PROVEN FIX (config-only; sovereign path holds — no HyperSync/token):**
    1. `berachain-apis` → `ignoreMethods: [eth_getLogs]` (keep it for block/tx load; route it OFF
       the method it lies on). eRPC `ignoreMethods` empirically verified (isolation test: getLogs →
       `-32601 method ignored`, chainId/getBlock → OK).
    2. Widen getLogs cluster 3 → 5: add **tenderly** `https://berachain.gateway.tenderly.co`
       (no key, archive, NO range cap / 50k-result) + **sentio** `https://berachain.rpc.sentio.xyz`
       (no key, archive, 10k cap). Research-verified live (the others probed: ankr/swiftnodes/1rpc
       key-required or dead — see session research output).
    3. Per-upstream eRPC `rateLimitBudget` (~25 req/s each) to PACE outbound rate under the free
       endpoints' punitive 429 budget; **drop hedge** (it doubles load under pacing).
  - **BENCHMARK (definitive, corrected+paced+widened):** full **17.3M-block cold sync to HEAD in
    ~5 min**; complete data — MiberaTransfer **39,714**, MintActivity **10,000**, MiberaLoan **176**;
    earliest event now a mint @ 3,838,974 (was a 4.46M secondary). 162 transient 429s, **never
    stalled**. (Earlier broken/stalled runs: 585 transfers / stall @ 0.7%.)
  - **Local-only artifacts (NOT committed):** `/tmp/erpc-local.yaml` (memory cache + the fix),
    `config.mibera.yaml` url/interval edits (REVERTED to committed eRPC-internal URL).
  - **FIX LANDED + VALIDATED (operator chose "land fix + reconcile", 2026-05-20):** committed
    `erpc.yaml` edited with the 3 Finding A+B changes — (1) `berachain-apis` `ignoreMethods:[eth_getLogs]`,
    (2) +tenderly +sentio upstreams (5 getLogs nodes), (3) per-upstream `rateLimitBudget` 25/s + hedge
    removed. Boot-validated end-to-end: the committed config (postgres cache + new sections) loads
    "ready", chainId ✓, getLogs deploy-window 9306 ✓. Belt build gate still green (verify / codegen /
    typecheck:mibera). **NOT committed to git** — awaiting operator review (erpc.yaml is reviewed infra).
    Caveat: 25/s pacing + ~5-min ETA are LOCAL data points (burned IP, memory cache) — re-validate at
    S2-T4 against the Railway egress IP.
  - **S2-T5 / AC-6 RECONCILIATION — PASS ✅ (2026-05-20).** Independently read on-chain
    `MiberaLiquidBacking` (verified ABI via routescan) at pinned block 21,150,981 (belt's synced head):
    `backingLoanId()=176` (== belt totalLoansCreated); enumerated `backingLoanDetails(0..175)`, active =
    `loanedTo != 0x0` (confirmed: repaid loan 0 + defaulted loan 7 both have loanedTo=0). **On-chain
    active set EXACTLY equals belt active set — both 19 IDs [134,135,136,137,146-155,163,164,165,174,175],
    only-on-chain=[], only-belt=[].** The belt data is complete AND correct vs chain. (`backingLoanExpired`
    is a state-MUTATING fn with no outputs — SDD §6 mislabels it as readable; the discriminator is
    `backingLoanDetails.loanedTo`. Recommend reconciling SDD §6 wording.)
  - **S2-T4 COMPLETE — belt LIVE on Railway (2026-05-20, driven via railway CLI w/ project token).**
    `freeside-sonar`/production now runs: `erpc` (rebuilt w/ A+B fix — 6 upstreams incl tenderly/sentio),
    `Postgres` (eRPC cache), `Postgres-3vIC` (belt DB), `belt-hasura` (graphql-engine v2.43), `belt-indexer`
    (Dockerfile.belt). **Belt cold-synced to head sovereignly through eRPC** (chain_metadata: latest_processed
    21,156,792 = head, is_hyper_sync=false, 51,818 events, first_event 3,838,974 = mint captured). Data
    COMPLETE + CORRECT, byte-identical to local: MiberaTransfer 39,714 · MintActivity 10,000 · MiberaLoan 176.
    **AC-6 on Railway: totalActiveLoans=19**, active IDs identical to the on-chain-reconciled set. Public
    GraphQL (anonymous `public` role) verified live: `https://belt-hasura-production.up.railway.app/v1/graphql`.
  - **S2-T4 deploy gotchas (factory learnings — folded into runbook):**
    1. **Dockerfile.belt needs `node:22`** — envio alpha.17 handler autoload uses `fs.promises.glob` (Node ≥22);
       node:20 crashes `Promises.glob is not a function`. (Build passes on 20; runtime crashes.)
    2. **eRPC redeploy:** the GitHub-triggered build had failed ("couldn't locate Dockerfile.erpc in code
       archive"); deployed via `railway up -s erpc -c` (local upload w/ Dockerfile.erpc) instead.
    3. **Image services (`railway add -i`) don't auto-deploy** — nudge the first deploy with a var-set.
    4. **`RAILWAY_RUN_COMMAND` is IGNORED for Dockerfile services** — can't inject `--restart` via env.
    5. **Hasura tracking is the big one:** envio runs "Tracking tables in Hasura" ONLY on FRESH storage init,
       NOT on resume. The belt's first start tracked 0 tables (belt-hasura private DNS was seconds-old →
       silent failure), and every resume skips tracking. **Fix applied: manually tracked 94 entity tables +
       `public` SELECT (allow_aggregations) via the Hasura metadata API** (`pg_track_table` +
       `pg_create_select_permission`) — idempotent, no re-sync, replicates exactly what envio does. **Factory
       rule: deploy belt-postgres → belt-hasura (confirm healthy) → belt-indexer LAST; if GraphQL shows
       `field not found in query_root`, run the manual-track step (see runbook).**
    6. **belt-indexer stdout logs barely stream on Railway** (envio non-TUI buffering) — verify via the DB
       (`chain_metadata`) + Hasura metadata, not `railway logs`. Investigate for S3 observability.
  - **CLEANUP / FOLLOW-UPS (operator):** (a) remove the stray PUBLIC domain accidentally created on
    `belt-indexer` (`belt-indexer-production-645f.up.railway.app` — it's a worker, 502s; dashboard removal —
    no CLI remove). (b) ROTATE the belt-hasura admin secret + Postgres-3vIC password (both appeared in the
    session transcript; internal/low-risk but rotate before/at handback). (c) revoke the temporary Railway
    project token (`~/.railway-token`) when CLI driving is done. (d) `~/.railway-belt-hasura-secret` holds the
    current admin secret locally.
  - **S3 IN PROGRESS (2026-05-20, driven). T1 ✅ T2 ✅ T4 ✅ T6 ✅ | T3 + T5 + T7 = operator-paired.**
    - **S3-T1 ✅ L5 gateway (AC-13).** `belt-gateway` (Caddy + caddy-ratelimit, `Dockerfile.gateway` + `Caddyfile`)
      live at **`https://belt-gateway-production.up.railway.app/v1/graphql`** — proxies belt-hasura, single-config
      `BELT_UPSTREAM=belt-hasura.railway.internal:8080`, federation-ready (additive Caddyfile route; public URL
      unchanged). **Swap verified:** bad upstream→502, revert→live data. Recovery = set `BELT_UPSTREAM` + redeploy.
    - **S3-T2 ✅ hardening (AC-12).** Per-IP rate limit 120/min keyed on `{client_ip}` (XFF; `trusted_proxies
      private_ranges` for Railway's edge) + 50KB request-body cap (verified: 60KB→413, small→200). The module is
      loaded + enforced; empirical 429 not triggerable from this session's rotating egress IP — verify from a
      single IP. **Fast-follow:** precise GraphQL depth/complexity cap (graphql-armor proxy or Hasura allowlist) —
      the body cap is the interim coarse guard.
    - **S3-T4 ✅ score-api empty-safe audit (AC-9, HARD GATE) — PASS.** `grimoires/loa/a2a/sprint-3/score-api-empty-safe-audit.md`.
      `fetchWithPagination`→[] on empty; `envioQuery` THROWS on GraphQL errors → empty-safety REQUIRES the tables be
      tracked (the 94-table track makes the 7 uncovered entities return [] — verified live). score-api repoint leg
      UNBLOCKED. Carry-forward: if belt DB is wiped+resumed without re-track, re-run the manual track first.
    - **S3-T6 ✅ schema unchanged (AC-10).** `git diff main…indexer-belt-rebuild -- schema.graphql` = empty.
    - **S3-T3 ⏳ observability (operator-paired — needs alert channel).** Recommended: Railway healthchecks →
      `erpc` `/healthcheck`, `belt-hasura` `/healthz`; sync-lag monitor = compare `chain_metadata.latest_processed_block`
      vs eRPC head, alert if lag > ~300 blocks / 10 min (note: belt-indexer stdout barely streams — monitor via DB,
      not logs); Postgres ≥80% disk alerts on belt + cache PG. Needs an ops channel (Slack webhook / Railway notif).
    - **S3-T5 ⏳ handback (operator-paired, ONE-WAY).** After a soak (≥2h synced-to-head + healthcheck green):
      repoint mibera-honeyroad `NEXT_PUBLIC_ENVIO_URL` (Vercel) → the gateway URL above; confirm `/backing` renders.
      Then (after S3-T4 ✅) score-api `ENVIO_GRAPHQL_URL` → gateway URL. Both → the **gateway** URL, never the raw
      belt URL (so recovery = gateway swap). This is the operator's Vercel flip.
    - **S3-T7 ⏳ E2E goal validation** — after T5 (load live `/backing`).
    - Services now: erpc, Postgres(cache), Postgres-3vIC(belt DB), belt-hasura, belt-indexer, **belt-gateway**.
  - **S3-T5 step 1 DONE — honeyroad.xyz/backing RESTORED on production (2026-05-20, operator-requested, no full soak).**
    PRD **G1 achieved live.** Set `NEXT_PUBLIC_ENVIO_URL` = `https://belt-gateway-production.up.railway.app/v1/graphql`
    + `NEXT_PUBLIC_MAINTENANCE_BANNER=false` on Vercel, redeployed → honeyroad.xyz now renders Total Backing
    31,632.007, the backing-per-NFT floor-value chart, and live Recent-Activity mints. Verified via browser +
    the gateway returns 200 w/ CORS allow-origin honeyroad.xyz; old hosted indexer (indexer.hyperindex.xyz)
    confirmed DOWN ("Failed to fetch") — the original fire.
    - **CRITICAL project-mapping learning:** the repo `0xHoneyJar/mibera-honeyroad` deploys to the Vercel project
      **`mibera-interface`** (domain **honeyroad.xyz**) — NOT the `mibera-honeyroad` Vercel project (whose builds
      have ALL errored 5+ days, missing DATABASE_URL; it's dead/abandoned). I first (harmlessly) set the env +
      a failed build on the dead `mibera-honeyroad` project before finding the live one. **For score-api leg +
      future: target the `mibera-interface` Vercel project / honeyroad.xyz.**
    - The `/backing` "indexer down" strip was env-driven: `MAINTENANCE_BANNER = NEXT_PUBLIC_MAINTENANCE_BANNER !== "false"`
      (defaults ON) — set to `false` to clear it.
    - **Vercel deploy gotcha:** `vercel --prod` from local FAILED on the dead project (no DATABASE_URL); the working
      path was `vercel redeploy <last-good-prod>` on mibera-interface (rebuilds the live commit + current project
      env, which has DATABASE_URL). `vercel redeploy` DID bake the new NEXT_PUBLIC_ vars (data loaded → env applied).
  - **REMAINING / CLEANUP:** (a) **score-api leg (S3-T5 step 2)** — repoint score-api `ENVIO_GRAPHQL_URL` → the gateway
    (S3-T4 audit PASSED → unblocked); operator-paired. (b) stray env var + failed build on the DEAD `mibera-honeyroad`
    Vercel project — harmless (never serves), remove if desired. (c) S3-T3 observability (needs alert channel) — esp.
    a sync-lag monitor since the flip skipped the ≥2h soak (verify belt realtime keeps up). (d) revoke `~/.railway-token`;
    rotate belt-hasura admin secret + Postgres-3vIC password. (e) S3-T7 E2E: G1 ✅ live; G2/G3 ✅ (factory + one-env-var
    recovery + schema unchanged).

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

## NEXT PHASE — Mibera ecosystem sovereign indexer (score-api restoration) — DIRECTION LOCKED 2026-05-20
- **Thesis (operator):** own the Mibera/THJ ecosystem onchain data; sync-speed = the unlock; no SaaS rent;
  build our own Dune later. The **ecosystem's data layer**, not a "score-api indexer." (memory: sovereign-data-thesis)
- **Scope (Zerker-confirmed):** 4 chains (1 ETH · 10 OP · 8453 Base · 80094 Bera) / ~13 contracts / 12 entities
  (frozen schema.graphql). Map: `grimoires/loa/context/score-api-coverage-scope.md`; experiment charter +
  observations log: `grimoires/loa/context/mibera-sovereign-indexer-experiment.md`. (Arb + Zora dropped — HoneyJar-only.)
- **Locked decisions:** (Q2) artifact = **extend the Mibera belt** (these contracts ARE mibera) → one indexer →
  one Hasura → one endpoint. (Q3) build all 4 chains → validate → **ONE** score-api `ENVIO_GRAPHQL_URL` repoint
  (no incremental). (Q1, operator lean — confirm) data source = **bounded HyperSync backfill → eRPC sovereign
  realtime**; HyperRPC paid only as last resort. (Q4) experiment resolves: sovereign viability + **sync speed**
  per chain + cost envelope + single-vs-belts. Hivemind Lab experiment (log in the charter).
- **Build plan (P-build):** extend `config.mibera.yaml` to the 4-chain footprint (pull contract event-defs from
  `config.yaml`) + wire each contract's existing handler into `src/belts/mibera` entrypoint + HyperSync backfill
  source → deploy → backfill → observe per chain → reconcile vs on-chain → repoint. Order: Berachain first
  (biggest share, eRPC ready), then Base/OP/ETH. **MiberaCollection must index ALL transfers incl. to-contracts.**
  Tests + prod-promotion rigor = before the repoint (operator deferred). Build directly (experiment frame).
