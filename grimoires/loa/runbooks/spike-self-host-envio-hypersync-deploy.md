# Runbook — Spike deploy: self-host Envio 3.2.1 + HyperSync (dark, alongside green)

> The agent-prepped half of `bd-fj1n.1`. You execute the Railway steps (your account, your paid
> HyperSync token). It's a **minimal dark variant** of `s2-t4-belt-deploy.md` — one indexer + its own
> Postgres, **NOT** wired to the gateway/consumers. Green is untouched. Spec:
> `grimoires/loa/specs/2026-06-20-spike-self-host-envio-hypersync-measure.md`.

## What this proves
Does self-host Envio HyperIndex 3.2.1 + **paid HyperSync** (the new variable) sync the 6 chains
*without* the Ponder-style toil treadmill? It runs dark; we measure toil + cost; the gate decides.

## Topology (2 new services, isolated)
```
belt-indexer-SPIKE (this repo @ feat/envio-321-port, Dockerfile.belt)
     │  envio start --config config.yaml (envio@3.2.1, HyperSync via ENVIO_API_TOKEN)
     └──ENVIO_PG_*──▶ belt-postgres-SPIKE   (OWN db — do NOT touch belt-postgres/green)
   NO Hasura · NO gateway wiring · NO BELT_UPSTREAM change  ← dark
```
(No Hasura for the spike — we measure the *indexer's* toil/cost. Add Hasura only if/when the gate
votes self-host and we need GraphQL parity for the swap.)

## Step 0 — Source
New Railway service from `0xHoneyJar/sonar-api` @ **`feat/envio-321-port`** (the proven 3.2.1 port),
Dockerfile = **`Dockerfile.belt`** (its `package.json` pins `envio@3.2.1`, so it runs 3.2.1).

## Step 1 — `belt-postgres-SPIKE`
New Railway Postgres (own volume). Capture its `DATABASE_URL` host/port/user/pass/db for the env table.

## Step 2 — `belt-indexer-SPIKE`
New service, Source = Step 0. **Size the container ≥ 24 GB RAM** (KF-015 headroom). Env vars:

| var | value | why |
|---|---|---|
| `BELT_CONFIG` | `config.yaml` | the 6-chain source (HyperSync restored at `d0a4034b`) |
| `ENVIO_API_TOKEN` | **your paid HyperSync token** | the fuel — this is the whole point of the spike |
| `NODE_OPTIONS` | `--max-old-space-size=12288` | **KF-015** — the heap lever the managed Dev tier wouldn't let us set; self-host CAN |
| `ENVIO_PG_HOST/PORT/USER/PASSWORD/DATABASE` | → `belt-postgres-SPIKE` | own DB; never green's |
| `TUI_OFF` | `true` | non-interactive container |
| `ENVIO_RESTART` | `1` | **first deploy only** — the seed dance (Step 3) |

## Step 3 — The seed dance (envio 28P01 init bug — exact sequence)
1. Deploy with `ENVIO_RESTART=1` → the JS seeds schema + `chain_metadata`, **then crashes** (expected).
2. **DELETE the `ENVIO_RESTART` var** (do not set 0/false — the strict gate only wipes on literal `1`).
3. **Redeploy** → it resumes from the seeded checkpoint and begins the cold-sync backfill.

## Step 4 — `bd-fj1n.2` Backfill to head
Watch the 6 chains advance: `1, 10, 8453, 42161, 7777777, 80094`. Record `freshness_lag_s` per chain
vs green's head. **This is where the toil shows** — if it OOM-crash-loops like Ponder did (dense
Arbitrum/Zora regions, KF-015/KF-012), that's a signal; if it rides through clean on HyperSync, that's
the thesis confirming.

## Step 5 — `bd-fj1n.3` Measure → the ledger
Log toil as-it-happens to the loa-finn ledger: `pnpm indexing:capture add` (setup mins + each incident).
Capture Railway $/mo (RAM-dominated) + the HyperSync subscription slice. Honor the early-halt criteria.

## DARK discipline (do NOT break the seam)
- Do **NOT** point belt-gateway / `BELT_UPSTREAM` at this service. Consumers keep reading green.
- Do **NOT** share green's Postgres. Own DB only.
- The `promote.sh` swap + the contract-suite SKIN gate fire **only IF** `bd-fj1n.4` votes self-host.

## Verify
Indexer running, 6 chains advancing, own Postgres filling; green + consumers + `BELT_UPSTREAM`
unchanged; the loa-finn `self-host-envio-hypersync` row accruing `measured` toil.
