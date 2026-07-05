# ADR — Warehouse supply lane for SVM history (two-lane architecture)

> **Status**: accepted · ratified by production evidence 2026-07-05 (green run 28731559821, 593 events healed, meter ledger line)
> **Cycle**: svm-warehouse-loader (PRs #123–#127) · **Decided by**: operator (zkSoju) + autonomous cycle · **Form**: follows `2026-06-15-indexing-strategy-reframe-adr.md` precedent
> **Supersedes**: the implicit decision (svm-collection-events cycle) that Helius Enhanced per-address walks are the history substrate.

## Decision

SVM collection **history** is acquired from a columnar warehouse (Dune `tokens_solana.*`) via the
loader lane; the per-call provider (Helius) is demoted to the **speed lane** (webhook tail + DAS
verification snapshots) and **selective enrichment only**. Two lanes converge on
`svm.collection_event` under three invariants: content-addressed PK (`{tx}:{mint}:{index}`,
identical across lanes — proven by test), coarse-never-clobbers merge policy (insert-if-absent for
warehouse writes), and the §4.5 reconcile-by-recompute gate (Dune is transport, never trust root).
Freshness is schema (`svm.sync_status`), spend is metered per call class (helius-meter).

## Context (the numbers that forced it)

- Old design cost O(mints × 100cr) per walk, re-run every 6h: ~53M credits/mo for ONE 3.7k-NFT
  collection → KF-018 (quota exhaustion → 9 days of silent data loss caught by the consumer, #122).
- Measured alternatives (2026-07-05): same full-history answer = 18.6 Dune credits unbounded,
  0.22 date-bounded; per-execution flat rate ≈ 10 credits (medium engine).
- Operator constraint: cost is binding ("$499/mo not scalable"); free tiers must suffice.
- Measured steady state post-decision: reconcile 40cr/run at drift≈0; free Helius tier holds ~60×.

## Alternatives rejected

1. **Provider swap (FluxRPC)** — no DAS, no historical index on tested plan; changes coefficient
   not exponent (#122 thread).
2. **Own the decode layer** (raw getTransaction parsing) — killed under cost constraint as
   over-build at current scale; revives only if Core/cNFT lane extensions force decode ownership.
3. **Bigger Helius plan** — pays retail forever for work the warehouse amortized once; scales with
   paranoia, not activity.

## Consequences

- Marketplace kinds ship coarse (mint/transfer/burn) until program-ID precision ≥99% vs the
  Helius-classified fixture (runbook step 5.3) — coarse-never-wrong over rich-but-unverified.
- New upstream schema dependency (Dune spellbook columns, pinned in `src/svm/sql/`) — guarded by
  row validation + reconcile gate, NOT by introspection (documented in `scripts/svm-contract.json`).
- Onboarding a classic-mint collection = registry entry + one dispatch (`svm-warehouse-ops.yml`);
  the 11-collections/month API ceiling no longer exists.
- The pattern is estate doctrine: see governed memory `two-lane-supply-pattern` — any lane paying
  per-call for bulk history should find its warehouse; any second writer to a shared table owes the
  three convergence invariants first.
