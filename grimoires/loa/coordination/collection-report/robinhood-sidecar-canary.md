# Canary — Robinhood HyperIndex sidecar (one-day experiment)

**Goal:** Prove HyperSync-only indexing of StonkBrokers on a dedicated DB without
touching the Henlo monobelt.

**Scaffold:** `config.robinhood-sidecar.yaml`, `src/sidecars/robinhood/`

## Live Railway cut (2026-07-19)

| Resource | Name | Notes |
|----------|------|-------|
| Indexer | `belt-indexer-robinhood` | `BELT_CONFIG=config.robinhood-sidecar.yaml`, `Dockerfile.belt` |
| Postgres | `Postgres` (private `postgres.railway.internal`) | Dedicated — **not** `Postgres-6J4w` |
| Hasura | `belt-hasura-robinhood` | Dedicated — **not** monobelt Hasura |

First deploy used KF-013: `ENVIO_RESTART=1` seed → delete var → resume. HyperSync selected
(`is_hyper_sync=true`). Observed catch-up to tip (~14.25M) with ~4.4k `Token` rows /
~470 `TrackedHolder` rows for StonkBrokers. Monobelt `chain_metadata` still has no 4663.

Remaining canary work: digest proof vs independent HyperSync client, Kitchen readiness
router + flip `ROBINHOOD_OWNERSHIP_SUPPLY_LANE_READY`, Hasura permission WARN cleanup
(`public` role).

## Setup (do not touch monobelt)

```text
config.robinhood-sidecar.yaml
src/sidecars/robinhood/EventHandlers.ts
fresh dedicated Postgres (+ optional throwaway Hasura)
Envio 3.2.x matching production
ENVIO_API_TOKEN=<sidecar-scoped>
ENVIO_PG_SCHEMA=envio_rh4663   # or default on dedicated DB
ENVIO_PG_*=<dedicated credentials only>
```

**Must be unset on the sidecar process:** `ROBINHOOD_RPC_URL`, monobelt DB URLs,
Kitchen DB URLs.

```bash
# From repo root (after ENVIO_API_TOKEN + dedicated PG are set)
pnpm exec envio codegen --config config.robinhood-sidecar.yaml
# Then start against the dedicated DB only — never monobelt credentials
```

Optional canary audit entity (add before proof if digest compare needs log-level
rows): `RhSidecarTransferAudit` keyed `4663:<tx_hash>:<log_index>` with
block/hash/tokenId/from/to. Ownership still lands on `Token` / `TrackedHolder`
via shared `handleTrackedErc721Transfer`.

## Proof sequence

1. Capture HyperSync head `H0`.
2. Start sidecar from `12,493,793` through `H0`.
3. Independent HyperSync client probe: same address + Transfer topic0; SHA-256
   digest of canonical event keys; final `tokenId → owner` map.
4. Compare probe vs sidecar `Token` ownership (+ audit rows if present).
5. Sample live `ownerOf(tokenId)` after catch-up.
6. Stop/restart with **identical** config, no `-r`; confirm resume + tip follow.
7. Kitchen staging: admit StonkBrokers with `belt.evm-erc721.robinhood-sidecar`
   once preparation is re-enabled; route readiness to sidecar GraphQL/SQL.
8. Confirm `queued → indexed` without monobelt `config.yaml` change, without a
   fabricated monobelt `chain_metadata` row for 4663, and without Kitchen loss
   on sidecar reset.

## Pass criteria

- Logs/telemetry prove HyperSync selected; no RPC source/fallback
- No “single wildcard event” fatal
- Reference event count + digest match; owner map matches
- Floor→`H0` backfill ≤ 4 hours; steady head lag < 60s
- Exact-config restart resumes without `-r`
- Kitchen readiness uses floor/through + digests from sidecar only
- Sidecar reset cannot affect Kitchen or monobelt storage

## Kill criteria → thin HyperSync worker

Any of: silent RPC selection; wildcard fatal; digest mismatch; resume needs
reset; miss time/lag targets; migrations need non-sidecar DB; no stable
processed-through + head hash for Kitchen.
