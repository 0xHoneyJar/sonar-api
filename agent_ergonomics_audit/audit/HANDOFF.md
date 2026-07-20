# agent-ergonomics pass 1 — HANDOFF

## What shipped

| Surface | Change |
|---------|--------|
| `scripts/sonar-care.sh` | Mega-command: triage / slo / queue / dream / floors / renvoi / capabilities / robot-docs |
| `CARE.md` | Compressed human care card (S1–S5, floors, onboarding, renvoi) |
| `package.json` | `pnpm care`, `care:json`, `care:caps` |
| `ARRIVAL.md` | Load-order row 1b → CARE |
| `promote.sh` | Error pedagogy + dry-run/rollback aliases |
| `sonar-pulse.sh` | `--help` + unknown-arg teach → care |

## Ambition bar

- Mega-command: yes (`pnpm care` / `--robot-triage`)
- capabilities --json: yes
- robot-docs: yes
- --json on read path: yes
- Error rewrite: yes (care + promote + pulse)
- Intent inference: yes (aliases + did-you-mean)

## Pass 2 queue (do not silently expand this pass)

1. ~~Live S1 lag probe wired into `care triage --json` when GraphQL reachable (fail-soft if offline)~~ **DONE** — `.live` on triage/slo; `SONAR_GRAPHQL_URL` + 2s timeout; offline never non-zero; R-001/R-002 pin it
2. Kitchen `deferred` + `batch_id` + `deferred_reason` (S4 honesty) — feature, not ergonomics-only
3. Apply agent-ergonomics to `sonar-self` / `sonar-sense` incur CLIs (capabilities parity)
4. Reconcile SCALE.md managed-Envio curls → alias (doc renvoi)

## Re-score

```bash
bash agent_ergonomics_audit/audit/regression_tests/R-001__care-first-try-triage.test.sh
bash agent_ergonomics_audit/audit/regression_tests/R-002__care-stdout-json-only.test.sh
pnpm care --json | jq .
```
