# Session 3 — Mibera ecosystem sovereign indexer (score-api restoration)

> The Mibera belt is live + `/backing` is restored on production. Now we grow that belt
> into the **Mibera ecosystem's sovereign data layer** (4 chains) so score-api can come
> back — owning our data, sync-speed as the unlock, no SaaS rent. Berachain leg is **built
> + verified + committed**. This session: deploy/backfill it, then add Base/OP/ETH.

## Context
score-api is down (its source = the dead hosted Envio `indexer.hyperindex.xyz/914708e`).
It needs **4 chains / ~13 contracts / 12 entities** (Zerker-confirmed, frozen `schema.graphql`).
Decision (operator): extend the **Mibera belt** into one multi-chain indexer (one Hasura → one
endpoint), build **all 4 chains → validate → ONE score-api repoint**, **eRPC from the start
(zero flicks)** with bounded HyperSync as a per-chain escape hatch only if a chain's backfill
ETA is unacceptable. Treat as a **Hivemind Lab experiment**; log observations (sync speed = #1).
Last session committed the **Berachain leg** (`7408ceb`): belt 2→8 contracts, verify/codegen/typecheck green.

## Load order (read first)
1. `grimoires/loa/NOTES.md` → "NEXT PHASE — Mibera ecosystem sovereign indexer" section (the locked plan).
2. `grimoires/loa/context/mibera-sovereign-indexer-experiment.md` — experiment charter + observations log + decision triggers. **Append observations here as you go.** *(local/gitignored — same machine)*
3. `grimoires/loa/context/score-api-coverage-scope.md` — the full coverage map (category→entity→contract→chain). *(local/gitignored)*
4. Memory: `sovereign-data-thesis` (WHY), `honeyroad-vercel-mapping`, `thj-abi-locations`.
5. `grimoires/loa/known-failures.md` (KF-012 = the eRPC getLogs-liar + 429 pattern; will recur per-chain).

## Persona
SHIP (the-arcade/BARTH) + **protocol lens** for the Railway/eRPC ops; ARCH (OSTROM) when extending eRPC multi-chain.

## What to build (in order)
### 1. Deploy + backfill the Berachain ecosystem leg — **the #1 experiment observation**
The 8-contract belt is committed but NOT yet deployed/backfilled. eRPC already serves Berachain.
- Redeploy the **belt-indexer** Railway service with the new config (it'll re-init storage + backfill the 6 new contracts from their early start_blocks: BgtToken @ 8221, CubBadges @ 1.08M, CandiesMarket @ 3.72M…). `RAILWAY_TOKEN=$(cat ~/.railway-token) railway up -s belt-indexer -c` (Dockerfile.belt, Node 22).
- **Re-track Hasura** after the fresh init (envio tracks tables only on fresh init — and it'll fail silently if it raced; if GraphQL shows `field not found`, run the manual `pg_track_table` + `pg_create_select_permission` loop — see runbook gotcha #6 / S3-T4 audit).
- **Measure**: backfill blocks/sec across the dense 8-contract scope (vs the sparse 2-contract ~5 min); 429 rate; completeness (entity counts vs on-chain). Log to the experiment charter.

### 2. Base leg (8453) — FriendtechShares + TrackedErc20(MiberaMaker333)
- Extend `erpc.yaml`: add a Base upstream group + `networks[]` entry (additive, OD-4). Research free Base RPCs (repeat the Tenderly/Sentio exercise; expect Findings A+B to recur — Base is denser).
- Add `FriendtechShares` (0xcf20…) + `TrackedErc20` MiberaMaker333 (0x1207…) to `config.mibera.yaml` (defs from `config.yaml` chain 8453) + wire handlers (friendtech, tracked-erc20 modules) into the belt entrypoint + extend `BELT_CONTRACTS`. Add a Base chain block with its own `rpc` → eRPC Base route.

### 3. Optimism leg (10) — MiberaSets, MiberaZora1155, MirrorObservability, TrackedErc721(OP lore)
- Same pattern: eRPC + OP upstreams; add the 4 contracts (defs from config.yaml chain 10) + wire handlers (mibera-sets, mibera-zora, mirror-observability, tracked-erc721) + BELT_CONTRACTS + OP chain block.

### 4. Ethereum leg (1) — MiladyCollection (NftBurn:milady)
- eRPC + ETH upstreams (densest — paid HyperRPC most likely forced here; measure first). Add MiladyCollection (0x5af0…) + wire its handler (tracked-erc721/nft-burn) + BELT_CONTRACTS + ETH chain block.

### 5. Validate + ONE repoint
- Per-chain reconcile (entity counts vs on-chain). Confirm score-api's 12 entities all return data/empty-safe via the gateway.
- Repoint **score-api `ENVIO_GRAPHQL_URL`** → `https://belt-gateway-production.up.railway.app/v1/graphql` (S3-T4 audit PASSED → unblocked). score-api deploys on **Railway project `score-api`** (NOT Vercel). Validate scores vs a known wallet.

## Design rules
- Reuse monolith handlers (`src/handlers/*`) + `schema.graphql` (FROZEN — never rename entities/fields). Belt = config + entrypoint wiring only.
- Each contract: copy event-def + network entry **verbatim from `config.yaml`** (verify-belt-config enforces fidelity); repoint `handler:` → `src/belts/mibera/EventHandlers.mibera.ts`; import its handler module in the entrypoint (DISS-001 autoload boundary — works because each handler imports only its own contract+entities).
- **eRPC from start (zero flicks)** per chain; bounded HyperSync (free `ENVIO_API_TOKEN`) only as a per-chain fallback if eRPC backfill ETA is unacceptable.
- eRPC `erpc.yaml` edits are **additive** (new upstream group + networks[] per chain); berachain-apis stays `ignoreMethods:[eth_getLogs]`; new chains likely have their own getLogs-liars — run the per-upstream reliability matrix (KF-012 method) before trusting any.
- `MiberaCollection` indexes **all transfers incl. to-contracts** (staking capture) — already does.

## What NOT to build (scope discipline)
- **NO belts + GraphQL federation yet** — single multi-chain indexer (one Hasura/endpoint). Federation = later "by extraction" if the single indexer gets unwieldy.
- **NO Arbitrum (42161) / Zora (7777777)** — HoneyJar-only; no score category needs them.
- **NO score-api repoint until ALL 4 chains validated** (operator: all-4-then-one-repoint).
- **NO tests / prod-promotion rigor yet** (operator deferred to before-repoint) — but DO reconcile per chain.
- Don't make HyperSync the steady-state source (sovereignty); bounded one-time per-chain only.

## Verify (per leg)
```bash
pnpm verify:belt-config     # N contracts field-identical to config.yaml
pnpm codegen:mibera         # exit 0
pnpm typecheck:mibera       # exit 0 (belt-scoped DISS boundary)
# + deployed: chain_metadata.latest_processed == head; entity counts vs on-chain getLogs; gateway returns data
```

## Meta-notes (hard-won, NOT in the spec body)
- **Railway write-auth:** browser `railway login` is READ-ONLY here; writes need the **project token** at `~/.railway-token` → `RAILWAY_TOKEN=$(cat ~/.railway-token) railway …`. **Revoke it when done** (or regenerate if expired).
- **Dockerfile.belt = node:22** (envio alpha.17 needs `fs.promises.glob`; node:20 crashes at runtime, build still passes).
- **belt-indexer logs barely stream on Railway** → verify sync via the **DB** (`chain_metadata`) + Hasura metadata, not `railway logs`.
- **Hasura tracking is fresh-init-only** → after any `--restart`/wipe, re-run the manual `pg_track_table` + `pg_create_select_permission` (role `public`, allow_aggregations) for all entity tables, else score-api's `envioQuery` THROWS on `field not found`.
- **eRPC is `railway up -s erpc` to deploy** (GitHub-build had a "Dockerfile.erpc not found" failure); image services need a var-set nudge to first-deploy.
- **mibera-honeyroad repo → Vercel project `mibera-interface` (honeyroad.xyz)**; the `mibera-honeyroad` Vercel project is DEAD.
- **Cleanups still pending:** revoke `~/.railway-token`; rotate belt-hasura admin secret (`~/.railway-belt-hasura-secret`) + Postgres-3vIC password (both in last session's transcript); remove the stray public domain on belt-indexer; wire S3-T3 sync-lag alert (needs a Slack webhook).

## Key references
| Topic | Where |
|---|---|
| Locked plan | `grimoires/loa/NOTES.md` "NEXT PHASE" |
| Experiment charter + obs log | `grimoires/loa/context/mibera-sovereign-indexer-experiment.md` |
| Coverage map (entity→contract→chain) | `grimoires/loa/context/score-api-coverage-scope.md` |
| Contract defs to copy | `config.yaml` (top-level `contracts:` + per-chain `networks:`) |
| Belt build gate | `pnpm verify:belt-config / codegen:mibera / typecheck:mibera` |
| eRPC config | `erpc.yaml` (Berachain live; add Base/OP/ETH additively) |
| Gateway (consumer endpoint) | `https://belt-gateway-production.up.railway.app/v1/graphql` |
| Railway | project `freeside-sonar` (e240cdf0): erpc, Postgres(cache), Postgres-3vIC(belt DB), belt-hasura, belt-indexer, belt-gateway |
| score-api code (entities it reads) | `0xHoneyJar/score-api` `trigger/utils/envio-client.ts` (FETCH_FUNCTION_REGISTRY) |
| ABIs (local — don't fetch) | `mibera-honeyroad/abis/treasury.ts` + `thj-sonar/abis/*.json` |
