# Review + Audit — svm-warehouse-loader sprint-1 (2026-07-05, autonomous run)

## Acceptance-criteria review (vs sprint.md)
| Task | AC status | Evidence |
|---|---|---|
| T-1 | PASS | test/dune-client.test.ts 5/5 — pagination drain, retry cap, cost surfaced, key never in URL/messages. Real-API pagination limit NOT yet observed live (needs DUNE_API_KEY) — flagged, runbook step 0 |
| T-2 | PASS (scoped) | program map measured + committed fixture; decision (c) recorded in SDD §2.4; precision-vs-Helius = runbook 5.3 pre-flag-flip. test/kind-mapping.test.ts 2/2 |
| T-3 | PASS | test/warehouse-loader.test.ts 15/15 — incl. PK-convergence (same tx via warehouse row and parseHeliusTx → identical eventId), ordinal rules, malformed-row rejection, --dry |
| T-4 | PASS | migration 002 idempotent; test/sync-status.test.ts 4/4 — partial-column upsert, source labels, skipped-no-das, never-throws |
| T-5 | PASS | webhook tests 11/11 (4 original preserved); routing, override, /health shape, per-collection DEGRADED |
| T-6 | PASS | test/incremental-reconcile.test.ts 10/10 — drifted-only walk proven by counting fake; --full parity; --verify-off declared state |
| T-7 | PASS | 8 registry entries, addresses = candidates doc (on-chain verified 2026-07-04) |
| T-8 | PASS | verify-svm-contract.mjs: 66 assertions hold, svm_sync_status warns pending-exposure (exit 0) |
| T-9 | PASS | runbook exists, commands copy-pasteable |
| Suite | PASS | 431 passed / 0 failed / 40 skipped; tsc --noEmit: zero NEW errors in touched files (pre-existing SFVaultHandlers/EventHandlers.mibera errors untouched) |

## Security audit
- Secrets: DUNE_API_KEY env-only, header-auth, leak-asserted in tests; no new secrets in argv/logs. PASS
- Untrusted input: warehouse rows field-validated (base58/slot/time), rejected-not-coerced, rejection counted + warned. PASS
- Write surface: no new public writes; Hasura admin-gated as before; loader insert-only/idempotent; rollback scoped by provenance column. PASS
- Trust boundary: Dune = transport; §4.5 gate + sync_status declared-degraded states preserve verify-by-recompute. PASS

## Known deviations (carried to HITL, not hidden)
1. Flatline reviews skipped — flatline_protocol.autonomous_mode unset in .loa.config.yaml (per skill spec: skip+log).
2. T-2 precision measurement and ALL live-Helius verification deferred to post-topup (operator-stated constraint); runbook step 5 owns them.
3. sync_status writer fires per webhook batch — acceptable write volume at current event rates; revisit if SVM event volume grows 100×.
4. Audit performed in-session by the implementing agent (self-audit) — the PR is the independent-eyes gate; recommend zerker review before merge + belt deploy.
