# agent-ergonomics — HANDOFF

**Tool.** `sonar-care` (`scripts/sonar-care.sh`)  
**Contract.** `sonar.care.v1`  
**Workspace.** `agent_ergonomics_audit/` (in-tree; no sibling)  
**Branch policy.** All work on current branch — **no** `agent-ergonomics-pass-N` branches.  
**Mode.** `full` (scoped to care mega-command surface, not full 30+ scripts inventory)

---

## Pass summary (1–5)

| Pass | Theme | Commit (when landed) | Primary artifacts |
|------|-------|----------------------|-------------------|
| **1** | Live health (`.live`) | `c96a087f` | Fail-soft S1 probe on triage/slo; `.live.status` ∈ {ok,offline,error} |
| **2** | Intent pedagogy | `b1016024` | Verb/flag typos → `exact:` / `did you mean`; promote/pulse pedagogy |
| **3** | Determinism | `34db8532` | `jq -S` keys; `SOURCE_DATE_EPOCH`→`generated_at`; chain_id sort; NO_COLOR |
| **4** | Cross-CLI discovery | `d655f5cc` | Mutual help renvoi; `related` / `related_commands`; robot-docs family section |
| **5** | Regression resistance + polish bar | *(this pass — uncommitted until operator commits)* | **R-006** capabilities schema pin; HANDOFF; manifest; `ambition_bar_check.md` |

### What shipped (detail)

| Pass | Surface | Change |
|------|---------|--------|
| foundation | `scripts/sonar-care.sh` | Mega-command: triage / slo / queue / dream / floors / renvoi / capabilities / robot-docs |
| foundation | `CARE.md` | Compressed human care card (S1–S5, floors, onboarding, renvoi) |
| foundation | `package.json` | `pnpm care`, `care:json`, `care:caps` |
| foundation | `ARRIVAL.md` | Load-order row 1b → CARE |
| 1–2 | `promote.sh` / `sonar-pulse.sh` | Error pedagogy + intent aliases |
| 1 | `sonar-care.sh` | Live S1 lag probe → `.live` on triage/slo (fail-soft) |
| 2 | `sonar-care.sh` + promote/pulse | Intent inference + error pedagogy corpus (**R-003**) |
| 3 | `sonar-care.sh` | Output contract: `jq -S`, `SOURCE_DATE_EPOCH`, `.live.chains` sort, NO_COLOR (**R-004**) |
| 4 | `sonar-care.sh` + pulse/promote help + CARE.md | Cross-CLI discoverability (**R-005**) |
| **5** | `audit/regression_tests/` | **R-006** pins capabilities envelope; ambition bar + handoff refresh |

---

## Ambition bar (care surface)

| Checklist item | Status |
|----------------|--------|
| Mega-command (`pnpm care` / `--robot-triage`) | **yes** |
| `capabilities --json` (+ bare forces json) | **yes** |
| `robot-docs` guide (+ `--json` guide field) | **yes** |
| `--json` on read path (stable key order) | **yes** |
| Error rewrite (`exact:` / `did you mean`) | **yes** |
| Intent inference | **yes** |
| Determinism / SOURCE_DATE_EPOCH / NO_COLOR | **yes** (R-004) |
| Schema pin / regression resistance | **yes** (R-001…**R-006**) |
| Dimensions touched | **≥ 9** of 11 (see `ambition_bar_check.md`) |
| **Bar met** | **YES** for scoped care surface |

Full inventory + self-prompt outcome: [`ambition_bar_check.md`](./ambition_bar_check.md).

---

## Verify (all regression tests)

```bash
bash agent_ergonomics_audit/audit/regression_tests/R-001__care-first-try-triage.test.sh
bash agent_ergonomics_audit/audit/regression_tests/R-002__care-stdout-json-only.test.sh
bash agent_ergonomics_audit/audit/regression_tests/R-003__intent-inference-errors.test.sh
bash agent_ergonomics_audit/audit/regression_tests/R-004__output-determinism.test.sh
bash agent_ergonomics_audit/audit/regression_tests/R-005__help-discoverability.test.sh
bash agent_ergonomics_audit/audit/regression_tests/R-006__capabilities-schema-pin.test.sh
```

Or:

```bash
for t in agent_ergonomics_audit/audit/regression_tests/R-00*.test.sh; do bash "$t" || exit 1; done
```

### R-006 contract (must not drift)

`pnpm care capabilities` / `capabilities --json` MUST retain:

- `.schema` / `.name` / `.contract_version` (`sonar.care.v1` / `sonar-care`)
- `.features.robot_triage` / `.features.live_s1_probe` (true)
- `.exit_codes["0"…"5"]` dictionary
- `.related_commands` (care_triage, care_caps, pulse, promote_dry_run, self_check, …)

Removing any of these is a **hard fail** of R-006.

---

## How to re-score (next agent)

1. Read this HANDOFF + `manifest.json` + `ambition_bar_check.md`.
2. Run all `R-00*.test.sh` (above). Any red → fix before new recs.
3. Spot-check live contract:
   ```bash
   bash scripts/sonar-care.sh capabilities --json | jq '{schema,name,features,exit_codes,related_commands}'
   bash scripts/sonar-care.sh triage --json | jq '{schema,live}'
   ```
4. If target HEAD ≠ last pass SHA and user wants uplift: mode `re-score-only` or `full` Pass 6 on **deferred queue only** — do not re-apply fixed surfaces.
5. Regression > 50 pts on any surface → **hard stop** (skill Phase 6); investigate before more apply.
6. Do **not** create a branch or sibling audit dir.

---

## Deferred (Pass N+1 / feature — do not silently expand)

1. **Kitchen `deferred` + `batch_id` + `deferred_reason`** (S4 honesty) — feature work → `/implement`, not pure ergonomics
2. **Apply agent-ergonomics** to `sonar-self` / `sonar-sense` incur CLIs (capabilities parity with care)
3. **SCALE.md** managed-Envio curls → alias renvoi (doc)
4. **promote capabilities --json** (sibling CLI self-describing surface)
5. **CI wire-up** of `R-00*.test.sh` (hooks / CI-integration recipes) — process layer

---

## Recommendations ledger

See [`recommendations.jsonl`](./recommendations.jsonl). Applied: R-001…R-004 (+ foundation). R-005 kitchen deferred remains `applied:false`. Pass-5 schema pin is regression **test** R-006 (pins existing contract; not a new feature rec).
