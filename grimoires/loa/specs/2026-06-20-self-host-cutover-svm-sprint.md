---
hivemind:
  schema_version: "1.0"
  artifact_type: product-spec
  product_area: "sonar-api — self-host cutover (green-Ponder → self-host-Envio) + SVM substrate"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "complete the cutover to self-host Envio and add a Solana pipe so Sonar surfaces both EVM and SVM; defer the data-lake"}
  learning_status: directionally-correct
  source: team-internal
---

# Sprint — Self-host cutover + SVM substrate

> **Decision (operator 2026-06-20):** commit self-host. Goal: complete the cutover (green-Ponder →
> self-host-Envio) + support SVM/EVM; **defer data ownership (data-lake).** The spike already de-risked
> the EVM indexing (0 sync toil, rode clean through the KF-015 OOM regions). This sprint finishes the
> cutover and adds the Solana pipe, unified at the belt-gateway.

## Run via
`/run sprint` (gated implement→review→audit cycle). **HIGH STAKES — data-validity:** the swap is
INC-2026-001 class (a shape regression broke 8 frontends + caused a liquidation). The `promote.sh` swap
(E1-T5) is an **OPERATOR CHECKPOINT — never autonomous.** The two parity gates are mandatory pre-swap.

## Invariants (must not change)
- Consumers read the **belt-gateway GraphQL** (the Markov blanket) — 0 consumer config changes through
  the swap (the green-swap proved this: 182 polls, 0 5xx).
- **Two parity checks, never conflated:** SKIN (does self-host satisfy consumer contracts?) →
  contract-validator (loa-freeside federation suite); FACTS (is the data correct?) → on-chain ground
  truth (SKP-002 / promotion-gate.js expansion-mode + golden samples). The swap needs BOTH green.
- Green stays HOT + at-head until the soak window clears (rollback path = `promote.sh --rollback`).
- `NODE_OPTIONS=12288` MUST persist on the self-host indexer post-swap (KF-015).

## EPIC 1 — EVM self-host cutover (green-Ponder → self-host-Envio)
The spike's indexer (`devoted-happiness`/`sonar-api`) is the self-host candidate, OR re-home it into
`freeside-sonar` alongside green (decide in E1-T2).
- **E1-T1 — Hasura on the self-host indexer (GraphQL surface).** Mirror green's `belt-hasura`
  (`hasura/graphql-engine:v2.43.0`, the 93 entities + `chain_metadata`, public select-perms) against the
  spike Postgres. *No-risk, started in parallel — doesn't touch green/consumers.* **Done:** the self-host
  indexer serves the same anon GraphQL surface green does.
- **E1-T2 — Cutover topology decision + belt-gateway candidate wiring.** Self-host indexer stays in
  `devoted-happiness` OR moves to `freeside-sonar` (where green + the gateway live — likely required so
  `BELT_UPSTREAM` can reach it over `railway.internal`). Make the self-host GraphQL a *candidate* upstream
  (NOT flipped). **Done:** the gateway can reach the self-host GraphQL on the private network; `BELT_UPSTREAM` unchanged.
- **E1-T3 — SKIN parity (consumer contracts).** Run the loa-freeside **contract-validator** (federation
  suite V1 = belt-gateway sealed_schema) against the self-host GraphQL. Cross-repo dep:
  `loa-freeside/tests/e2e/contract-validator` (the kickoff is filed). **Done:** self-host passes every
  belt-gateway consumer contract; a deliberately-broken field FAILS it (the INC-2026-001 guard).
- **E1-T4 — FACTS parity (on-chain ground truth).** Run `promotion-gate.js` expansion-mode
  (`EXPECTED_CHAINS=[1,10,8453,42161,80094,7777777]` + `GOLDEN_SAMPLES`) green-vs-self-host AND
  self-host-vs-L1 (SKP-002 — the golden-tx identity match, not engine-vs-engine). **Done:** self-host is
  non-lossy + new-chains-verified; any drop → HALT.
- **E1-T5 — `promote.sh` swap (green → self-host). ⛔ OPERATOR CHECKPOINT.** Gate re-runs as
  non-skippable precondition; operator pulls the trigger; probe for 0 5xx. **Done:** `BELT_UPSTREAM` =
  self-host, consumers seamless, rollback proven.
- **E1-T6 — Soak + retire green.** Green HOT through the rollback window; then retire the Ponder stack.
  Rotate any creds touched. **Done:** one-belt steady-state; green retired; `NODE_OPTIONS` persisted.

## EPIC 2 — SVM substrate (Solana pipe → gateway unification)
Grounded in `2026-06-20-svm-substrate-finding.md`: Envio is EVM-only today (Solana HyperSync = rolling
window, no genesis; HyperIndex-Solana = RPC-driven, no instruction handlers). So SVM = a **separate pipe,
unified downstream** — the Goldsky-Turbo / SQD pattern. **Data-lake deferred** (operator).
- **E2-T1 — Solana substrate decision. ⛔ OPERATOR-GATED (cost/ops).** Choose the pipe: self-host
  Yellowstone/Geyser (realtime; 512GB-RAM node) vs Helius (managed archival+LaserStream) vs Substreams
  for Solana (parallel backfill). Weigh self-host-control vs the 512GB node burden; likely a managed
  backfill (Helius/Substreams) + self-host realtime, OR fully managed to start. **Done:** the substrate
  is chosen with a documented basis + a cost estimate.
- **E2-T2 — Stand up the Solana pipe** (realtime + historical backfill of the target Solana
  contracts/programs). **Done:** Solana events flowing into a Postgres/store with backfill to the target depth.
- **E2-T3 — Unify at the belt-gateway.** Surface Solana data through the same gateway/GraphQL the EVM
  belt uses (the chain-agnostic seam) — the unification the finding prescribes. **Done:** consumers query
  EVM + SVM through one gateway; the contract-validator covers the SVM surface too.

## What NOT to build (Barth)
- NO data-lake / data-ownership layer (deferred — operator).
- NO autonomous swap — E1-T5 is an operator checkpoint.
- NO new contract framework — extend loa-freeside's contract-validator (the kickoff).
- Do NOT adopt Envio-Solana (early/no-genesis) for the SVM backfill — separate pipe per the finding.

## Verify (cutover)
Self-host serves the belt-gateway surface; SKIN green + FACTS green; swap flips with 0 5xx; rollback
proven; green retired post-soak; SVM data queryable through the unified gateway.

## Key references
| Topic | Path |
|---|---|
| Spike result + the deployed indexer | `grimoires/loa/specs/2026-06-20-spike-self-host-envio-hypersync-measure.md` |
| SVM substrate finding | `grimoires/loa/context/2026-06-20-svm-substrate-finding.md` |
| Green swap machinery (promote.sh, gate, Hasura) | `grimoires/loa/NOTES.md` (2026-05-22 sessions 4-5) |
| SKIN gate (contract-validator) | `loa-freeside/.../enhance-federation-contract-suite.md` |
| FACTS gate (on-chain truth) | promotion-gate.js expansion-mode + SKP-002 |
