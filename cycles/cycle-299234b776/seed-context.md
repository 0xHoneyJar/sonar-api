# SPIRAL SEED 001 — SQD live-tail (svm-sqd-substrate)

## Task
Land SqdCollectionEventSource as the $0 live-tail lane for svm.collection_event:
finish branch feat/svm-sqd-substrate (decode mint/transfer/burn from token-balance
diffs, 42 tests green), converge on the content-addressed PK
{tx_signature}:{nft_mint}:{instruction_index}, pass the §4.5 reconcile-by-recompute
gate against the pythians 30,006-event fixture, PR with bridgebuilder review.

## Prior outputs (cycle-0 corpus — verified 2026-07-05)
- SQD Portal portal.sqd.dev solana-mainnet: open/unauthenticated, block 0 → real-time
  (height 430,902,735 verified). Filter ceiling ~345KB → MINT_CHUNK=1500. Client-driven
  continuation lastBlock+1. Batch history walks INFEASIBLE (sequential global-density
  scan ~400k reqs) — live-tail role ONLY.
- Branch feat/svm-sqd-substrate (pushed to origin): sqd-client.ts,
  sqd-collection-event-source.ts, re-scoped PRD/SDD/sprint. Start there; do not re-derive.
- Two-lane pattern ADR: grimoires/loa/context/2026-07-05-warehouse-supply-lane-adr.md.
  Insert-if-absent merge policy (coarse never clobbers fine). DAS = trust root.
- Snapshot-first onboarding landed (#136-#138): 9 Solana collections live, ~100cr each.
  This spiral adds EVENT HISTORY FORWARD, not ownership (already served).
- Meter precedent: src/svm/helius-meter.ts + DUNE_CREDIT_BUDGET — ship the guard with
  the first integration line, never after.

## Consumer (anti deployed-but-unconsumed)
score-api (#121/#135) reads svm.collection_event via Hasura. A lane that lands events
no one queries is failure — the PR must demonstrate the consumer-shape query.

## Constraints (hard)
- BB (bridgebuilder-review) gate before ANY merge — operator standing order.
- Dune = operator-approved spends ONLY. No new metered accounts/keys
  (metered-provider-spike-protocol: price-sheet axes + shaped probe + budget guard first).
- §4.5 completeness gate applies per-lane; NEVER combine with windowed ingestion.
- Prefer cheap-and-loud failure shapes (snapshot precedent: 10cr instant confession)
  over cheap-success-expensive-failure shapes (walk trains: 4h/2M-credit silences).

## Stopping conditions
- Chronos: max 3 cycles, $45 total (budget 15/cycle, standard profile).
- Kaironic: findings/PR-delta plateau across a cycle → terminate; do not pad cycles.
- HALT if SQD portal turns authenticated/paid mid-run — re-quote before continuing.

## Cut from scope
No deep-history backfill (solarchive probe is a separate, operator-gated track).
No Base/EVM work. No webhook-lane changes. No new providers. No Dune calls.
