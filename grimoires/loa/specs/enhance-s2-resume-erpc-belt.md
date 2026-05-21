# Session 2 — Resume Mibera Belt (S2-T3 → S3) on the sovereign eRPC path

> The fire-fix belt builds and parses Berachain now. What's left is proving it emits
> data through eRPC, then deploying it. The hard architectural question — "can we
> restore `/backing` sovereignly?" — is answered **yes**. This doc is the build map.

## Context

`indexer-belt-rebuild` cycle restores the broken mibera-honeyroad `/backing` page (PRD
G1) by shipping a thin **Mibera belt** Envio indexer as instance #1 of a factory
(eRPC L2 substrate + per-belt config/handlers). Across this session the cycle's central
blocker (**DISS-003**) was found and fixed:

- The original fire = Envio **HyperSync now requires a (free) `ENVIO_API_TOKEN`** (V3).
- We pivoted to **sovereign RPC sync through our own eRPC** (no hosted dep).
- Envio RPC sync crashed on Berachain (`totalDifficulty` omitted by BeaconKit/Cosmos-EVM;
  Envio's parser required it). This is Envio **#994**, fixed in **PR #998** (alpha.16+).
- **FIX APPLIED + committed (`08f3a99`)**: pinned `envio@3.0.0-alpha.17` (exact). alpha.17
  = the #998 parser fix + the alpha.15/16 binary-packaging fix (so `pnpm envio` works —
  alpha.16's package had no `bin`) + **below the alpha.23 "New Handlers API" break**, so
  the reused handlers register unchanged. Validated: `pnpm envio` / codegen / typecheck:mibera
  / verify-belt-config all green; `envio start` reaches "Starting indexing" (eventConfigs>0),
  no `totalDifficulty` error.

**Done:** S0 (eRPC calibration) · S1 (eRPC L2 substrate live on Railway `freeside-sonar`,
project `e240cdf0`) · S2-T1 (`config.mibera.yaml` → `rpc`/eRPC) · S2-T2 (belt build gate +
CI) · **DISS-003 fix (alpha.17)**. Ledger: S2 (170) = in_progress; S3 (171) = planned.

## Invariants (must NOT change)

1. **Sovereignty**: belt → eRPC → free Berachain RPC cluster. No HyperSync, no
   `ENVIO_API_TOKEN`, no hosted dependency in steady state.
2. **`envio@3.0.0-alpha.17`, exact pin.** Do NOT bump to alpha.23+/stable 3.0.0/3.0.1 —
   the "New Handlers API" break (alpha.23) makes the reused handlers register 0 events
   (`eventConfigs=0`). Stable V3 migration is a LATER, deliberate, by-extraction effort.
3. **`schema.graphql` frozen** (consumer contract — AC-10). No entity/field renames.
4. **`config.mibera.yaml` committed data source = the eRPC internal URL**
   (`http://erpc.railway.internal:4000/main/evm/80094`) with exact contract start_blocks
   (3837808 / 3971122 — never genesis). Local-run endpoint swaps are temp + reverted.
5. **Belt-scoped everything** (DISS-001/002): `src/belts/mibera/` entrypoint +
   `handlers: src/belts/mibera` + `tsconfig.mibera.json` + `verify-belt-config.js`.

## Load order (read first)

1. `grimoires/loa/NOTES.md` — the DISS-001/002/003 decision log (the whole arc + every gotcha).
2. This doc.
3. `grimoires/loa/sprint.md` §"Sprint 2"/"Sprint 3" — task ACs.
4. `grimoires/loa/sdd.md` §3 (eRPC L2), §4 (belt), §6 (the 3 reconciliation queries), §7 (observability).

## What to do (in order)

### 1. S2-T3 — entity-emission proof (the immediate next task) [bd-1cc]
Run the belt locally **through eRPC** and confirm the 3 SDD §6 queries return data
(AC-4): `MiberaLoan(limit:5)` non-empty · `MiberaTransfer(limit:5)` non-empty ·
`MintActivity(where:{amountPaid:{_gt:"0"}},limit:5)` ≥1 row.

**Setup (the hard-won gotchas — these cost hours this session):**
- `export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"` first — else
  `envio local docker up` fails with `docker-credential-desktop not found`.
- `pnpm envio local docker up --config config.mibera.yaml` (postgres + Hasura @ localhost:8080).
- **Point the belt at eRPC, not a raw endpoint.** The 4 public RPCs were rate-limited into
  hard blocks on 2026-05-20 (Cloudflare 1015 / QuickNode `-32008` 250/min). eRPC's hedge
  across the 4 + finalized cache is what absorbs that. Either: (a) run eRPC locally
  (docker `ghcr.io/erpc/erpc@sha256:862056...`, mount `erpc.yaml` at `/home/nonroot`,
  `-e ERPC_DATABASE_URL=postgresql://u:p@127.0.0.1:5432/none`), point the belt at
  `http://127.0.0.1:<port>/main/evm/80094`; or (b) temporarily expose the deployed Railway
  eRPC (set the public domain's target port to 4000 in the dashboard — the CLI `--port` and
  API `serviceDomainUpdate` both failed; the dashboard works).
- **Re-codegen after ANY data-source edit** — `generated/` EMBEDS the URL at codegen time;
  editing `config.mibera.yaml` alone does nothing (`pnpm envio codegen --config config.mibera.yaml`).
- `TUI_OFF=true pnpm envio start --restart --config config.mibera.yaml` — `TUI_OFF` (Ink TUI
  crashes `String.repeat(-18)` non-TTY); `--restart` clears a corrupted checkpoint.
- Between runs: `pkill -9 -f 'envio start'; lsof -ti tcp:9898 | xargs -r kill -9` (port collision).
- Query Hasura: `curl localhost:8080/v1/graphql -H 'x-hasura-admin-secret: testing' -d '{"query":"..."}'`.
- Break-glass only: the `totalDifficulty`-injection shim (PoC built this session — a ~40-line
  proxy injecting `totalDifficulty:"0x0"`; recreate from the NOTES DISS-003 entry if ever
  needed). alpha.17 makes it unnecessary.

### 2. (Optional) eRPC cold-sync benchmark
Run a fixed 100k–250k block slice through eRPC, measure ranges/sec + 429 rate, extrapolate
the 3.8M-block cold sync. If ETA is unacceptable, do a **bounded one-time HyperSync+token**
backfill, then continue sovereign on eRPC with event-count reconciliation. (Expert plan.)

### 3. S2-T4 — deploy belt Railway service + belt Postgres [bd-25h]
In `freeside-sonar` (project `e240cdf0`): new belt service (this repo) + its own Postgres
(separate from the eRPC cache PG). Build `pnpm install --frozen-lockfile && pnpm envio codegen
--config config.mibera.yaml` (alpha.17 `bin` works); start `pnpm envio start --config config.mibera.yaml`.
Config selection: Railway build copies `config.mibera.yaml`→`config.yaml`, OR use `--config`
(supported). Belt's `rpc` resolves `erpc.railway.internal:4000` over Railway private net.

### 4. S2-T5 — cold sync to head + on-chain loan reconciliation [bd-2kh]
Let it sync; reconcile the active-loan set against on-chain `MiberaLiquidBacking` at a block
past finality (≈19 active loans is the 2026-05-19 reference; gate is exact equality). AC-6.

### 5. S3 — L5 gateway · observability · hardening · staged handback
Per `sprint.md` Sprint 3 (AC-7..AC-13): stable federation-ready gateway, two-layer health +
sync-lag + disk alerts, score-api empty-safe audit (HARD gate), staged consumer repoint
(mibera-honeyroad `NEXT_PUBLIC_ENVIO_URL` → gateway), schema-unchanged confirm, E2E goal validation.

## What NOT to do (scope discipline)
- Do NOT bump `envio` past alpha.22 (alpha.23 handler-API break). Stable V3 = separate cycle, by extraction.
- Do NOT make HyperSync the steady-state source (sovereignty). One-time bounded backfill only, if needed.
- Do NOT commit local-run config edits (the committed `rpc.url` = the eRPC internal URL).
- Do NOT sync production directly off a raw public endpoint (rate-limits) — always through eRPC.
- Do NOT use `dig-search.ts` for research here — it hangs (gemini CLI subscription unauth'd +
  480s×3 timeout) and `GOOGLE_API_KEY` is `PERMISSION_DENIED`. Use the Agent tool + WebSearch.
  (`gpt-review` is also broken here — SSRF allowlist blocks api.openai.com.)

## Verify (belt build gate — all must stay green)
```bash
pnpm envio --version            # 3.0.0-alpha.17
pnpm verify:belt-config          # ✓ 2 belt contracts field-identical
pnpm codegen:mibera              # exit 0
pnpm typecheck:mibera            # exit 0 (belt-scoped tsconfig.mibera.json)
# + the 3 §6 GraphQL queries return data (AC-4)
```

## Key references
| Topic | Where |
|---|---|
| DISS-001/002/003 + gotchas | `grimoires/loa/NOTES.md` |
| Sprint tasks + ACs | `grimoires/loa/sprint.md` |
| eRPC L2 / belt / queries / observability | `grimoires/loa/sdd.md` §3/§4/§6/§7 |
| eRPC config | `erpc.yaml` (digest-pinned eRPC; 4 Berachain upstreams; reorg-safe cache) |
| Belt build gate CI | `.github/workflows/belt-build.yml` |
| Railway | `freeside-sonar` project `e240cdf0` (eRPC svc + cache PG live); old `thj-sonar` = retired ERC1155 indexer, leave it |
| Expert consult (full) | pasted into the 2026-05-20 session transcript (4 options; A-prime chosen) |

## Expert forward plan (strategic, deferred)
1. Benchmark eRPC cold-sync; bounded HyperSync backfill only if the cold ETA forces it.
2. Keep the `totalDifficulty` shim as *disabled* break-glass.
3. Toward sovereign data **origin**: run our own Berachain node (Bera-Reth/BeaconKit, archive)
   behind eRPC — eRPC today is sovereign routing/cache, not origin.
4. Stable Envio V3 migration LATER, by **extraction**: migrate the `/backing` belt to the
   stable `indexer.onEvent` API first, then the ~30-handler monolith. Not a monolith-shock bump.
