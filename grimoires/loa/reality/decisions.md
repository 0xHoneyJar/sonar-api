# Decision Archaeology

> Extracted from ADR / decision records. Claims — verify with HITL before treating as hard constraints.
> Generated: 2026-07-19 · stale threshold: 12 months

## ADR directories found

- `docs/architecture/` (ADR-001, ADR-002 — Loa framework adjacent)
- `grimoires/loa/context/*-adr.md` + lake-decision-record (product decisions)

## Active Decisions

### ADR-001 — Model-Registry Consolidation (Cycle-099)

- **Status**: Decided (2026-05-06)
- **File**: `docs/architecture/ADR-001-cycle-099-model-registry.md`
- **Decision**: `.claude/defaults/model-config.yaml` + `.loa.config.yaml` model keys are the only authoritative model registry; other mentions are generated or tier-tag references.
- **Rejected**: Per-adapter associative arrays / scattered lookups
- **Constraints for agents**: Do not add new ad-hoc model lookup tables; use FR-3.9 resolver
- **Age**: ~2.5 months — active

### ADR-002 — Multi-Model Cheval Substrate

- **Status**: Accepted (v1.157.0, 2026-05-12)
- **File**: `docs/architecture/ADR-002-multimodel-cheval-substrate.md`
- **Decision**: Single Python cheval HTTP boundary for BB/FL/RT provider calls
- **Rejected**: Per-consumer HTTP clients
- **Constraints for agents**: Prefer cheval/model-invoke path; don't revive per-consumer fetch stacks
- **Age**: ~2 months — active (framework)

### Warehouse supply lane for SVM history (two-lane)

- **Status**: accepted · ratified 2026-07-05
- **File**: `grimoires/loa/context/2026-07-05-warehouse-supply-lane-adr.md`
- **Decision**: SVM **history** from Dune warehouse; Helius demoted to speed/enrichment; converge on `svm.collection_event` with content-addressed PK + insert-if-absent + §4.5 gate
- **Rejected**: FluxRPC swap; own raw decode layer (for now); bigger Helius plan
- **Constraints for agents**: Don't reintroduce Helius full-history walks as default substrate
- **Reversal**: revive decode ownership if Core/cNFT forces it

### FR-7 Lake Decision — GO on SQD (SVM deep history)

- **Status**: COMPLETE — GO on SQD (2026-07-06)
- **File**: `grimoires/loa/context/2026-07-06-lake-decision-record.md`
- **Decision**: Self-host Solana NFT deep history on SQD Portal `solana-mainnet`; Envio HyperSync-Solana eliminated for genesis coverage
- **Rejected**: Envio HyperSync-Solana as deep-history lake (rolling floor / NXDOMAIN)
- **Constraints for agents**: Don't plan Envio-Solana genesis backfill without re-open conditions in that record
- **Code check**: `src/svm/sqd-parallel-loader.ts` restored 2026-07-19 from `9c33df84` (GAP-002 closed); vitest 13/13

## Stale Decisions

_None >12 months in scanned ADR set._

## Notes

Product lake/warehouse decisions live in `grimoires/loa/context/` (gitignored context) more than `docs/adr/`. Agents should read both.
