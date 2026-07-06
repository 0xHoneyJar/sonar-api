---
hivemind:
  schema_version: "1.0"
  artifact_type: technical-rfc
  product_area: "sonar-api — SVM SQD block-stream substrate"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "design SqdCollectionEventSource: Portal stream consumption, balance-diff decode, chunked mint filtering, and convergence with the existing writer/gate — per the svm-sqd-substrate PRD"}
  learning_status: directionally-correct
  source: team-internal
trust_tier: operator-authored
read_state: read
confidence: 0.8
decay_class: working
last_confirmed: 2026-07-05
operator_signed: self_attested
---

# SDD — SVM SQD Substrate (cycle: svm-sqd-substrate, r1 2026-07-05)

Traces: PRD r1 FR-1..FR-5. Grounding: `origin/main` @ 046fb23; live Portal probes 2026-07-05.

## 1. Architecture

The two-lane ADR holds; this cycle gives the batch lane a second, free substrate. All three supply
implementations (Dune, SQD, Helius Enhanced) feed ONE writer under the SAME invariants:

```
DAS getAssetsByGroup ──► member mints (all 8 collections; metadata-era-agnostic)
        │
        ▼ chunks of ≤500 mints
SQD Portal stream ──► SqdCollectionEventSource ──► CollectionEvent[] ──► upsertCollectionEvents(ifAbsentOnly)
 (slot windows,          (balance-diff decode)                                 │
  resumable cursor)                                                     svm.collection_event + sync_status('sqd-stream')
                                                                               │
                                                              §4.5 reconcile gate (DAS recompute = trust root)
```

## 2. Components

### 2.1 `src/svm/sqd-client.ts` (~140 loc)
Portal stream consumer, raw fetch (repo idiom). `POST {PORTAL_BASE}/datasets/solana-mainnet/finalized-stream`
with `{type:"solana", fromBlock, toBlock, fields:{tokenBalance:{account,preMint,postMint,preOwner,postOwner,
preAmount,postAmount,transactionIndex,transactionIndex:true}, block:{number,timestamp}, transaction:{signatures:true}},
tokenBalances:[{postMint:[...chunk]},{preMint:[...chunk]}]}` `[MEASURED: filter shape verified; response =
newline-delimited JSON block objects]`. Both pre+post mint filters so burns (post disappears) and mints
(pre absent) are both captured. Handles: slot windowing (`SQD_WINDOW_SLOTS`, default 500k ≈ ~2.7 days),
resumable via last-processed-slot cursor from `svm.collection_event` (source='sqd-stream'), 429/5xx
retry with cap, request counting via helius-meter's pattern (new `sqd` meter kind, weight 0 — count
requests, price nothing; the meter is the politeness ledger). Env: `SQD_PORTAL_BASE` (default
portal.sqd.dev), `SQD_API_KEY` optional header.
**Open item for T-1**: exact per-request response pagination semantics (does one request return the
full slot range or a bounded chunk with a continuation? probe measured single-block scale only) —
T-1 resolves; client written continuation-tolerant (consume until stream end, note `lastBlock`).

### 2.2 `src/svm/sqd-collection-event-source.ts` (~200 loc, the decode)
Pure decode from token-balance diffs grouped by (tx, mint) — unit-testable, no network:
- **transfer**: within one tx+mint, an account with pre=1→post=0 AND another with pre=0→post=1 →
  `{from: preOwner(losing), to: postOwner(gaining)}`.
- **mint**: gaining account with NO losing counterpart AND no prior sqd-seen balance for the mint
  (first appearance) → from=null. (Cross-check: candy-guard-era mints show pre-account absent.)
- **burn**: losing account with no gaining counterpart → to=null.
- **ambiguous** (multi-leg same-tx custody hops, escrow shuffles): decode the NET owner change per
  the 001-view custody semantics; if net is unresolvable → reject + count (never guess; the fixture
  adjudicates how often this happens — G1 target bounds it).
- `instructionIndex`: per-(tx,mint) occurrence ordinal in (slot, txIndex) order — SAME rule as
  parseHeliusTx/warehouse mapRows [CODE:src/svm/warehouse-loader.ts mapRows]; PK convergence test pinned.
- kinds emitted: mint/transfer/burn ONLY (PRD OUT: marketplace kinds).

### 2.3 CLI `src/svm/sqd-loader.ts` (~80 loc)
`--collection <key> [--from-slot N] [--dry]`: registry resolve → DAS members (existing source) →
chunk → windows → decode → upsert(ifAbsentOnly) → sync_status(`sqd-stream`) → optional §4.5 verify
(same degraded-declared rule). Budget analog: `SQD_MAX_REQUESTS` per run (default 20k) — the
grant-not-right guard; STOP cleanly between windows like DUNE_CREDIT_BUDGET.

### 2.4 Integration deltas
- `sync-status.ts`: `SyncEventSource` += `"sqd-stream"`; migration 003 widens the CHECK constraint
  (idempotent ALTER … DROP/ADD constraint).
- `collection-event-writer.ts`: `EventSource` += `"sqd-stream"` (one union member).
- `svm-warehouse-ops.yml`: `sqd-ingest` step (inputs: collection, from_slot; env-passed + charset
  allowlist per #127/#129 injection posture; no vendor secrets needed).

## 3. Security & Cost
- No secrets required (Portal open; optional SQD_API_KEY env-only if registered). Rows are UNTRUSTED:
  field-validate (base58, slot ints, amount strings) before decode; reject-don't-coerce.
- Politeness: sequential windows, no fan-out, request meter, SQD_MAX_REQUESTS cap; T-1 abort
  criterion (PRD risk row) is the terms tripwire.

## 4. Test Strategy (fixtures only, zero network in CI)
- `test/sqd-decode.test.ts`: transfer/mint/burn/ambiguous-reject cases from constructed balance-diff
  rows; PK-convergence (same tx via SQD rows and parseHeliusTx fixture → identical eventId).
- `test/sqd-client.test.ts`: windowing, chunking (501 mints → 2 chunks), cursor resume, request cap
  stop, retry, key-header only-when-set (mocked fetch).
- `test/fixtures/svm-sqd/`: pythians slice — REAL Portal response rows captured in T-1 (committed),
  adjudicated against the Helius-classified 30,006-event fixture for G1 recall measurement.
- Suite + tsc regression gates per repo standard.

## 5. Rollout (maps to sprint tasks)
1. **T-1 SPIKE (gate for everything)**: register etiquette key; stream pythians (3,682 mints, full
   history) with request meter on; measure rows/request, requests total, wall-clock, any throttle;
   capture fixture slice; ABORT→operator if gating appears. Deliverable: measured table in NOTES +
   fixture files. (Runs via ops-workflow dry mode — no DB writes needed for the spike.)
2. T-2 decode + tests (pure, parallel-safe with T-1 fixture arrival).
3. T-3 client + CLI + integration deltas + migration 003.
4. T-4 G1 adjudication: pythians full ingest (dry→live), recall vs fixture, §4.5 gate.
5. T-5 batch: remaining 7 collections via ops dispatches; sync_status rows; per-run meter lines.
6. T-6 closure rides the EXISTING NOTES protocol (KF-018/#122/#121) — batch-1 landing via SQD
   satisfies the same trigger; Dune path becomes optional (Jul-16 free cycle = bonus seam-fill only).
