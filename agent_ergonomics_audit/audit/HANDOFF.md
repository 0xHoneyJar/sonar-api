# agent-ergonomics — HANDOFF

## What shipped

| Pass | Surface | Change |
|------|---------|--------|
| 1 | `scripts/sonar-care.sh` | Mega-command: triage / slo / queue / dream / floors / renvoi / capabilities / robot-docs |
| 1 | `CARE.md` | Compressed human care card (S1–S5, floors, onboarding, renvoi) |
| 1 | `package.json` | `pnpm care`, `care:json`, `care:caps` |
| 1 | `ARRIVAL.md` | Load-order row 1b → CARE |
| 1 | `promote.sh` / `sonar-pulse.sh` | Error pedagogy + intent aliases |
| 2 | `sonar-care.sh` | Live S1 lag probe → `.live` on triage/slo (fail-soft) |
| 3 | `sonar-care.sh` + promote/pulse | Intent inference + error pedagogy corpus (R-003) |
| **4** | **`sonar-care.sh`** | **Output contract: `jq -S` key order, `SOURCE_DATE_EPOCH`→`generated_at`, `.live.chains` sort_by chain_id, NO_COLOR empty-set + `--json` forces no ANSI** |

## Ambition bar (care surface)

- Mega-command: yes (`pnpm care` / `--robot-triage`)
- capabilities --json: yes (+ determinism features / SOURCE_DATE_EPOCH env)
- robot-docs: yes
- --json on read path: yes (stable key order)
- Error rewrite: yes
- Intent inference: yes
- Determinism / SOURCE_DATE_EPOCH / NO_COLOR: yes (R-004)

## Verify

```bash
bash agent_ergonomics_audit/audit/regression_tests/R-001__care-first-try-triage.test.sh
bash agent_ergonomics_audit/audit/regression_tests/R-002__care-stdout-json-only.test.sh
bash agent_ergonomics_audit/audit/regression_tests/R-003__intent-inference-errors.test.sh
bash agent_ergonomics_audit/audit/regression_tests/R-004__output-determinism.test.sh
```

## Pass queue (do not silently expand)

1. Kitchen `deferred` + `batch_id` + `deferred_reason` (S4 honesty) — feature, not ergonomics-only
2. Apply agent-ergonomics to `sonar-self` / `sonar-sense` incur CLIs (capabilities parity)
3. Reconcile SCALE.md managed-Envio curls → alias (doc renvoi)
