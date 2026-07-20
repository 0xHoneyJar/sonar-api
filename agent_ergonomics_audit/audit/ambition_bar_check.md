# Ambition Bar Check — sonar-care (passes 1–5)

**Target.** `scripts/sonar-care.sh` (+ CARE.md, promote/pulse help cross-links)  
**Workspace.** `agent_ergonomics_audit/` (in-tree)  
**Branch.** current (`feat/belt-zero-downtime`) — **no new branch created**  
**Self-prompt.** "That's it??" — one mandatory reflection at end of pass 5 (this file).

---

## Soft targets (skill Axiom 3)

| Gate | Target | Result |
|------|--------|--------|
| Substantive landed changes | ≥ 5 (tiny surface) / ≥ 10 (non-trivial) | **≥ 10 across loop** (see inventory) |
| Dimensions touched | ≥ 3 of 11 | **9** (see below) |
| Mega-command | when missing | **✓** `pnpm care` / `triage --json` / `--robot-triage` |
| capabilities / robot-docs | when missing | **✓** both; bare `capabilities` forces JSON |
| --json on read path | when missing | **✓** triage/slo/queue/floors/renvoi/capabilities/robot-docs |
| Error rewrite | when missing | **✓** exact: / did you mean on care+promote+pulse |
| Intent-inference handler | when missing | **✓** verb+flag typos (R-003 corpus) |
| Regression tests pin applied recs | mandatory | **R-001 … R-006** green |
| Bar met? | — | **YES** for care surface scope |

---

## Substantive changes across the loop

### Pass 1 — Live health (`.live`) · c96a087f
- Fail-soft S1 lag probe on `triage`/`slo` → `.live.status` ∈ {ok,offline,error}
- Never blocks care exit code; `SONAR_GRAPHQL_URL` / `SONAR_CARE_PROBE_TIMEOUT` overrides
- Dimensions: **agent_ergonomics**, **output_parseability**, **composability**

### Pass 2 — Intent pedagogy · b1016024
- Verb/flag typo corpus (`traige`, `--jsno`, `capasities`, …) with exact corrected command
- promote/pulse unknown-flag pedagogy + dry-run alias acceptance
- Dimensions: **intent_inference**, **error_pedagogy**, **agent_intuitiveness**

### Pass 3 — Determinism · 34db8532
- `jq -S` stable key order via `emit_stable_json`
- `SOURCE_DATE_EPOCH` → `generated_at`; omit wall-clock when unset
- `.live.chains` sorted by `chain_id`; NO_COLOR / CI / TERM=dumb / non-TTY
- Dimensions: **determinism_and_reproducibility**, **composability**, **output_parseability**

### Pass 4 — Cross-CLI discovery · d655f5cc
- Mutual `--help` renvoi (care ↔ pulse ↔ promote ↔ self)
- `robot-docs` Related CLIs + queue policy verbs
- `capabilities.related` + `related_commands` stable maps
- Dimensions: **self_documentation**, **agent_ease_of_use**, **agent_ergonomics**

### Pass 5 — Regression resistance + polish bar · (this pass, uncommitted)
- **R-006** capabilities schema pin (schema/name/contract_version/features/exit_codes/related_commands)
- HANDOFF full pass 1–5 + re-score recipe; manifest summary; this ambition check
- robot-docs --json validity re-checked as adjacent contract in R-006
- Dimensions: **regression_resistance**, **self_documentation**

### Foundation (pre-loop / R-001 applied surface)
- Mega-command `sonar-care.sh` (triage/slo/queue/dream/floors/renvoi/capabilities/robot-docs)
- CARE.md compressed care card; ARRIVAL 1b pointer; `pnpm care` / `care:json` / `care:caps`

---

## Dimensions touched (11-dim rubric)

| # | Dimension | Touched? | Evidence |
|---|-----------|----------|----------|
| 1 | agent_intuitiveness | ✓ | bare `pnpm care`, typo redirects |
| 2 | agent_ergonomics | ✓ | mega-command + related_commands |
| 3 | agent_ease_of_use | ✓ | help cross-discovery, CARE.md |
| 4 | output_parseability | ✓ | --json pure stdout, schema |
| 5 | error_pedagogy | ✓ | exact: / did you mean |
| 6 | intent_inference | ✓ | R-003 corpus |
| 7 | safety_with_recovery | partial | promote --dry-run pedagogy (feature gate pre-existed) |
| 8 | determinism_and_reproducibility | ✓ | R-004 |
| 9 | self_documentation | ✓ | capabilities + robot-docs |
| 10 | composability | ✓ | NO_COLOR / non-TTY / fail-soft live |
| 11 | regression_resistance | ✓ | R-001…R-006 |

**Count: 9 hard-touched + 1 partial ≥ 3 required.**

---

## Checklist (five surface types)

- [x] **Mega-command** — `pnpm care` / `bash scripts/sonar-care.sh triage --json` / `--robot-triage`
- [x] **capabilities --json** — schema `sonar.care.v1`; bare forces JSON
- [x] **robot-docs guide** — paste-ready handbook; `--json` wraps `{schema,command,guide}`
- [x] **--json on read path** — triage, slo, queue, floors, renvoi, capabilities, robot-docs
- [x] **Error rewrite** — stderr names exact fix command (care + promote + pulse)
- [x] **Intent-inference** — Levenshtein-style verb/flag hints (R-003)
- [x] **Schema pin regression** — R-006 fails if critical capabilities keys removed

---

## Self-prompt outcome ("That's it??")

> Where are the dramatic improvements?

Already landed across passes 1–4: first-try triage with live S1, full intent/error pedagogy, byte-stable JSON, and cross-CLI discovery. Pass 5's job is **not** another feature surface — it is **regression resistance**: without R-006, the capabilities contract can silently lose `features.robot_triage` / `exit_codes` / `related_commands` and agents break with no test red. That is Axiom 17 / Polish Bar "Regression test" / Stack E pin.

**Deferred (honest, not "polite stop"):**
1. Kitchen `deferred` + `batch_id` + `deferred_reason` (S4 honesty) — **feature**, needs `/implement`
2. Apply same ergonomics stack to `sonar-self` / `sonar-sense` incur CLIs (capabilities parity)
3. SCALE.md managed-Envio curl → alias renvoi (doc)
4. Optional: promote capabilities --json of its own (sibling CLI; out of care scope)
5. Optional: wire R-00x into CI (hooks-integration) — process, not surface

**Bar met: YES** for the scoped care surface. Residual is Pass-N+1 / feature beads, not under-delivery on this loop.

---

## How to re-score

```bash
# 1. Green regression suite
for t in agent_ergonomics_audit/audit/regression_tests/R-00{1,2,3,4,5,6}*.test.sh; do
  bash "$t" || exit 1
done

# 2. Spot-check contract
bash scripts/sonar-care.sh capabilities --json | jq '{schema,name,contract_version,features,exit_codes,related_commands}'
bash scripts/sonar-care.sh triage --json | jq '{schema,live,exit_codes}'

# 3. Intent smoke
bash scripts/sonar-care.sh traige 2>&1 | grep -E 'exact:|did you mean'

# 4. Determinism smoke
SOURCE_DATE_EPOCH=0 SONAR_GRAPHQL_URL=http://127.0.0.1:9 SONAR_CARE_PROBE_TIMEOUT=1 \
  bash scripts/sonar-care.sh triage --json | tee /tmp/a.json >/dev/null
SOURCE_DATE_EPOCH=0 SONAR_GRAPHQL_URL=http://127.0.0.1:9 SONAR_CARE_PROBE_TIMEOUT=1 \
  bash scripts/sonar-care.sh triage --json | tee /tmp/b.json >/dev/null
diff -u /tmp/a.json /tmp/b.json
```

If any R-00x fails or a surface drops > 50 pts on re-score, **hard stop** (skill Phase 6) before applying more.
