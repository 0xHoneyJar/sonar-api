# Trajectory Self-Audit

> `/ride --enriched --force-restore` · 2026-07-19

## Execution summary

| Phase | Status | Output | Findings |
|------:|--------|--------|----------|
| 0 Preflight | complete | trajectory | force-restore from `loa/main`; checksums 5981 ok; loa 1.196.0 |
| 0.5 Probe | complete | loading-plan.md | prioritized src (~14k LOC) |
| 0.6 Staleness | stale→reanalyze | — | prior reality 13d old |
| 1 Context | complete | claims-to-verify.md | interview skipped; 20+ claims from context |
| 2 Extraction | complete | reality/*-raw, api-routes, data-models, env, debt, tests | 95 entities, 143 src TS, 541 tests |
| 2b Hygiene | complete | hygiene-report.md | Node version conflict; CI naming |
| 3 Legacy | complete | legacy/INVENTORY.md | 101 docs; CLAUDE.md 6/7 |
| 4 Drift | complete | drift-report.md | score 72; D-001 critical |
| 5 Consistency | complete | consistency-report.md | 7.5/10 |
| 6 Artifacts | partial/preserve | as-built-prd/sdd; **prd.md/sdd.md NOT overwritten** | active planning preserved |
| 6.5 Reality | complete | reality hub files + meta | within budget |
| 7 Governance | complete | governance-report.md | semver tags missing |
| 8 Deprecation | deferred | — | blast-radius on 101 ops docs |
| 9 Self-audit | complete | this file | — |
| 10 Handoff | complete | NOTES update | — |
| 11 Ground truth | skipped | — | flag not set |
| 12 Gaps | complete | gaps.md | 6 open (session 4d9f) |
| 13 Decisions | complete | reality/decisions.md | 4 active ADRs/records |
| 14 Terms | complete | reality/terminology.md | ~35 terms |
| 15 Simplicity | complete | reality/over-engineering.md | 3 shortcuts |

## Grounding analysis

### as-built-prd.md

| Marker | Count |
|--------|------:|
| GROUNDED | 14 |
| INFERRED | 2 |
| ASSUMPTION | 1 |
| Grounded % | ~82% |

### as-built-sdd.md

| Marker | Count |
|--------|------:|
| GROUNDED | 18 |
| INFERRED | 1 |
| ASSUMPTION | 1 |
| Grounded % | ~90% |

### Active planning prd.md / sdd.md

Not regenerated — preserved. Quality not re-scored this ride.

## Claims requiring validation

1. Parallel SQD loader existence (GAP-002) — ASSUMPTION from context vs missing file
2. NftActivity persistence model (GAP-005)
3. CI Ponder/Envio labels (GAP-004)

## Hallucination checklist

- [x] No invented chain IDs (verified in config.yaml)
- [x] Entity count measured (`^type ` = 95)
- [x] Missing parallel loader reported as gap, not claimed present in code
- [x] Force-restore remote named correctly (`loa`, not `loa-upstream`)
- [x] Did not overwrite active planning PRD/SDD

## Reasoning quality score: **8 / 10**

Deductions: Phase 8 deferred; interview non-interactive; subagents unavailable (usage limit) so extraction was shell-primary.
