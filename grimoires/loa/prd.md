---
hivemind:
  schema_version: "1.0"
  artifact_type: product-spec
  product_area: "sonar-api — SVM SQD block-stream substrate (history + live tail at $0)"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "give every Solana collection full-genesis history and a live tail from a free block-stream substrate (SQD Portal), so onboarding cost is decode-compute instead of vendor credits, and the #121 Solana ramp completes without Dune egress or Helius Enhanced"}
  learning_status: directionally-correct
  source: team-internal
trust_tier: operator-authored
read_state: read
confidence: 0.8
decay_class: working
last_confirmed: 2026-07-05
operator_signed: self_attested
---

# PRD — SVM SQD Substrate (cycle: svm-sqd-substrate, r1 2026-07-05)

> **Persona**: ARCH (OSTROM) · **Origin**: operator "/plan" 2026-07-05 after the Dune egress economics
> (20cr/MB free tier) and BigQuery staleness (frozen 2025-03-31) closed the paid-warehouse paths.
> **Builds on**: `2026-07-05-warehouse-supply-lane-adr.md` (two-lane doctrine — this cycle swaps the
> batch lane's substrate, invariants unchanged) · `metered-provider-spike-protocol` (memory) ·
> the block-stream seam anticipated in `src/svm/nft-collection-source.ts` header.
> **Grounding legend**: `[MEASURED]` = live probe this cycle · `[CODE:ref]` · `[ASSUMPTION]` flagged.

## 1. Executive Summary

SQD Portal serves Solana **from slot 0, real-time, free, unauthenticated** `[MEASURED 2026-07-05:
/datasets/solana-mainnet/metadata → {start_block: 0, real_time: true}; height 430,905,794]`, and its
stream **filters token balances server-side by mint** `[MEASURED: tokenBalances:[{postMint:[USDC]}]
over 10 slots returned only-USDC pre/post balance diffs with owner + slot + timestamp]`. This cycle
adds `SqdCollectionEventSource`: member mints from DAS (free Helius) → chunked mint-filtered Portal
streams → mint/transfer/burn decode from balance diffs → the EXISTING writer, PK, and §4.5 gate.
Outcome: all 8 batch-1 collections (incl. Clay/FFF/GG, whose Dune member-metadata is broken
`[MEASURED: 4/2/0 members in tokens_solana.nft]`) get genesis→now history + a Dune-free path,
at decode-compute cost only.

## 2. Goals & Metrics

| Goal | Metric | Target |
|---|---|---|
| G1 Decode correctness | pythians fixture parity (30,006 Helius-classified events) | mint/transfer/burn recall ≥99.5% vs fixture's ownership-moving events; §4.5 ownership reconcile ≥99% |
| G2 Batch-1 complete | all 8 collections ingested genesis→now via SQD | per-collection counts + sync_status rows; zero vendor credits consumed |
| G3 PK convergence | same tx via SQD row vs parseHeliusTx fixture | identical `eventId` (test-pinned, per warehouse-loader precedent [CODE:test/warehouse-loader.test.ts PK test]) |
| G4 Throughput sanity | full-history walk of one 10k collection | completes in one ops-workflow run (<2h) [ASSUMPTION: stream rate — measured in T-1 spike] |

## 3. Scope

**IN**: `src/svm/sqd-client.ts` (Portal stream consumer: slot-windowed, resumable, chunked mint
filters ~500/request); `src/svm/sqd-collection-event-source.ts` (balance-diff → CollectionEvent
decode; owner-level from/to via pre/post owner; per-(tx,mint) ordinal identical to parser rule);
members-via-DAS feed (existing `DasNftCollectionSource` [CODE:src/svm/nft-collection-source.ts]);
ops-workflow `sqd-ingest` step; sync_status source label `sqd-stream`; fixtures + gate validation.
**OUT**: marketplace kinds (sale/list/delist stay with the T-2 program-ID follow-up — balance diffs
alone can't attribute sales); replacing the live webhook (SQD real-time tail is a captured VISION,
not this cycle); EVM anything; deleting the Dune loader (kept as alternate supply lane).

## 4. Functional Requirements

- **FR-1** sqd-client: POST `/datasets/solana-mainnet/finalized-stream` with `{type: solana,
  fromBlock, toBlock, fields:{tokenBalance, block}, tokenBalances:[{postMint:[...]}, {preMint:[...]}]}`;
  paginated/windowed by slot ranges; retry/backoff per repo idiom; NO auth assumed but key-ready env
  (`SQD_API_KEY` optional — RESOLVED 2026-07-05 via Exa/executor + docs.sqd.dev/en/data/api-keys: the May-2026 key requirement applies to LEGACY v2 gateways only, Solana legacy retired Jun 1, Portal exempt; free self-serve key app at portal.sqd.dev/app — register one as etiquette at T-1).
- **FR-2** decode: balance-diff semantics — postAmount 1←0 with no prior holder = mint-or-receive
  (cross-check first-appearance = mint); 1→0 + 0→1 pair in same tx = transfer (from=preOwner,
  to=postOwner); 1→0 with no counterparty + closed account = burn. Reject-don't-guess on ambiguous
  rows (rejected counter, warehouse-loader precedent).
- **FR-3** members: DAS getAssetsByGroup per collection (works for ALL 8 incl. Clay/FFF/GG — DAS
  indexes the retroactive collection field; GG's mint was chain-verified via DAS members 2026-07-04).
- **FR-4** convergence invariants unchanged: content-addressed PK; insert-if-absent (coarse source
  never clobbers webhook/Helius-classified rows [CODE:writer INSERT_IF_ABSENT]); §4.5 gate before
  `verified` status; sync_status writes with `sqd-stream` label (extend enum + CHECK constraint).
- **FR-5** ops: `svm-warehouse-ops.yml` gains `sqd-ingest` step (collection, from_slot inputs,
  injection-safe env pattern per #127/#129).

## 5. NFRs & Constraints

- **Cost — honestly stated**: $0 AS OBSERVED 2026-07-05 (open, unauthenticated, no published
  Portal data-access terms found; Cloud compute pricing exists but does not govern Portal reads;
  the May-2026 API-key note's scope is unverified). Operator challenge on record: "are you sure
  it's free?" — answer: NO, and the design doesn't require it. Treat as a GRANT not a right: meter
  request counts locally (helius-meter pattern), stay polite (sequential windows, no fan-out), and
  the spike protocol's shaped probe (T-1) precedes any full-collection walk.
- **Standing rules**: Dune spends still operator-approved only (NOTES); BB merge gate; all tests
  fixture-based, zero live-network in CI.
- **Trust**: SQD is transport, never truth — §4.5 recompute gate is the trust root (per the ADR).

## 6. Risks

| Risk | Mitigation |
|---|---|
| Balance-diff decode misses pNFT/escrow edge cases | fixture adjudication vs pythians BEFORE batch ingestion (G1 gate); reject-don't-guess |
| Portal adds auth/limits mid-cycle, or free access was never intended at bulk scale | T-1 probe IS the terms-discovery instrument (one collection, full volume, metered — throttles surface there, not in the batch); register a free SQD key as etiquette regardless; key-ready env; Dune lane retained as priced fallback; ABORT criterion: if T-1 shows gating, cycle pauses for operator terms decision before any batch walk |
| 10k-mint filter chunking × full history = many requests | T-1 spike measures rows/request/second on ONE collection first; window+chunk sizes tuned from measurement, not guesses |
| Token-2022 / compressed members | in-scope only if fixture shows them; else documented OUT with the Core/cNFT lane extension |
