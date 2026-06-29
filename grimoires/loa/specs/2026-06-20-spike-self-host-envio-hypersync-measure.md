---
hivemind:
  schema_version: "1.0"
  artifact_type: experiment-design
  product_area: "sonar-api — Layer-1 indexing: self-host-Envio-with-HyperSync TCO measure-spike"
  workstream: experimentation
  priority: high
  jtbd: {category: functional, description: "measure the toil/TCO of self-host Envio HyperIndex fueled by PAID HyperSync before committing the cutover — the one variable that flipped the prior self-host rejection is now changed"}
  learning_status: directionally-correct
  source: team-internal
---

# Spike — Self-host Envio HyperIndex + paid HyperSync: measure before commit

> A **bounded measurement spike**, not a migration. The PRD measured-and-rejected self-host — but on
> the OLD eRPC config. Paid HyperSync removes exactly that toil. So re-measure the NEW config; let the
> *number* decide self-host vs managed. Reuses the existing measurement machinery; runs ALONGSIDE green
> (consumers untouched). Output: one `measured` ledger row + a quantified decision.

## ✅ Result so far (observed 2026-06-20 — TOIL axis DECIDED; cost pending)
**Self-host Envio 3.2.1 + HyperSync rode CLEAN.** Deployed dark on Railway (project `devoted-happiness`
`5972976f` / service `sonar-api` `920a3274` / deploy `e92ec5e3`, `ENVIO_RESTART=0`, `NODE_OPTIONS=12288`).
Backfilled all 6 chains to head in **~40 min — through Arbitrum (block ~475M) + Zora (~47M), the exact
dense regions KF-015 OOM-killed and the old RPC path made overnight long-poles — with 0 OOM, 0 deploy
restarts.** HyperSync-on-all-chains is the difference: it eliminated the sync toil that flipped the
original TCO to managed.
- **setup_toil:** 4 one-time fixes, now in `feat/envio-321-port`: Railpack→Dockerfile.belt; `3cc18c6b`
  (drop obsolete RPC-debug patch — `require()` under ESM crashed the build); `16f0433c` (events-publisher
  per-event flood when NATS unset); full env wiring. **R1 resolved** — the `@0xhoneyjar/events` private
  clone WORKS on Railway's build sandbox.
- **sync_toil:** 0 incidents.
- **cost:** PENDING — running ~24-48h for a MEASURED Railway $/mo + HyperSync sub → the `bd-fj1n.4`
  crossover vs managed-Envio (operator decision 2026-06-20: let it run for the measured number, not projected).
- **⚠ durability:** the 2 fix commits are local-only in `/tmp/sonar-canary` (ahead 2 of origin) — push
  `feat/envio-321-port` before a `/tmp` clear loses them.

## Context (the decision this resolves)
PRD r3 (`grimoires/loa/prd.md`) settled **managed over self-host** on the loa-finn TCO experiment
(*"toil flips the winner to managed at a $3.59/hr breakeven"*). BUT the rejected self-host ran on
**eRPC** (the source was *"de-HyperSync'd … strip HyperSync entirely … cluster-owned eRPC"*,
`git:01d19638`) — the resize-treadmill / OOM / RPC-management toil is what lost the bet. **HyperSync is
now paid**, which eliminates that toil source. So the self-host-Envio-**with-HyperSync** config is
*unmeasured* — no ledger row exists for it. This spike produces it. (The `measure-before-migrate`
memory, applied to our own re-open: a re-measure is legitimate because the variable changed; a blind
commit is not.)

## Goal (one measured number, Ken-Thompson honest)
The missing loa-finn ledger row: **`self-host-envio-hypersync`** at the current 6-chain / 93-contract
footprint — `$/mo` + `toil_incidents_30d` + `setup_mins`, `cost_source: measured`. Then the crossover:
does it beat **managed-Envio** (the settled direction) and the rejected **sovereign-Ponder** on
TCO-incl-toil? The trust invariant holds: a projection cannot be rendered as a measurement.

## Setup (mostly deploy + measure — config is ready)
1. **A self-host Envio HyperIndex service on Railway** (sibling to the green-Ponder stack; does NOT
   touch green). Run `envio start --config config.yaml` (the ported 3.2.1 source; HyperSync already
   restored at `d0a4034b`).
2. **HyperSync token** in env (the paid one) — this is the fuel; no eRPC.
3. **`NODE_OPTIONS=--max-old-space-size=<~50% of container>`** (KF-015 — the heap fix that the managed
   Dev tier wouldn't let us set; self-host CAN). Real RAM on the container.
4. Backfill the 6 chains to head; record `freshness_lag_s` per chain vs green.

## Measure (reuse the machinery — don't rebuild)
- **Toil, as-it-happens** → the loa-finn ledger via `pnpm indexing:capture add` (setup mins + each
  incident: crash, OOM, resize, RPC-cap). This is the load-bearing axis — the thing that lost the prior
  bet. Honor the early-halt criteria (reuse `bd-yqs.1`).
- **Cost** → Railway $/mo for the self-host service (container RAM-dominated, like the Ponder line) +
  the HyperSync subscription component. Normalize per `bd-yqs.3` (calendar vs billing-period).
- `pnpm indexing:read` → the crossover vs managed + Ponder. The verdict inherits the weakest cost_source.

## Decision gate (quantified — the spike's terminal verdict)
- **Self-host WINS** iff TCO-incl-toil(self-host-hypersync) < TCO-incl-toil(managed) at the breakeven
  rate — i.e. the toil is low enough (few incidents, no resize treadmill) that the control/learning
  upside isn't paid for in attention. → commit self-host; escalate to the full cutover plan.
- **Self-host LOSES** iff it crash-loops / OOMs / needs the same treadmill Ponder did (early-halt). →
  managed; HyperSync becomes the Layer-2 / future lever.
- Record the verdict + ratify-or-revise the ADR (the self-host arm of `bd-buho`).

## Bounded scope (Barth — this is a SPIKE)
**IN:** one Railway service · HyperSync + RAM · backfill to head · the toil/cost ledger row · the
decision. **OUT (only IF self-host wins):** the `promote.sh` swap, the contract-suite SKIN gate, the
FACTS parity, retiring green. Those are the *commit* plan, not the spike. **Do NOT** touch green, the
consumers, or `BELT_UPSTREAM` during the spike — it runs dark, alongside.

## The seam (why this is safe to run now)
Consumers read the belt-gateway GraphQL (the Markov blanket); the self-host service is NOT wired to it.
Zero consumer impact. The swap (and its contract-suite gate) only happens AFTER the spike votes
self-host — exactly the cybernetic isolation: measure the internal candidate without touching the skin.

## Verify
- The `self-host-envio-hypersync` ledger row exists with `cost_source: measured` (not projected).
- The decision is quantified (TCO-incl-toil numbers, not vibes) and ratifies-or-revises the ADR.
- Green untouched; consumers untouched; `BELT_UPSTREAM` unchanged.

## Open questions
- **Window:** a short toil-profile window first (early-halt on crash-loop — if it Ponders, decide fast);
  extend to a representative cost window only if it's clean.
- **HyperSync cost attribution:** is the HyperSync subscription a self-host-only cost, or shared with
  the future Layer-2 firehose? (Affects the crossover — flag it, don't hide it.)
- **Reorg/realtime parity:** does self-host HyperIndex's reorg handling match green's at head?

## Revises
- `prd.md` r3's "managed-only" Layer-1 assumption → adds the **self-host arm** (the re-measure).
- `bd-yqs` (S5 measured cycle): the measure machinery gains a self-host configuration alongside managed.
- The cutover beads (`bd-bua`/`bd-yqs`) stay managed-shaped until the spike votes; the swap path forks then.
