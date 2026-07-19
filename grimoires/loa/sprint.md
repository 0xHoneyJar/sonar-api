---
title: "Sprint Plan — honest frontier Flatline bootstrap"
status: active
trust_tier: ai-derived
read_state: read
confidence: 0.88
decay_class: working
last_confirmed: 2026-07-18
operator_signed: true
---

# Sprint Plan — Honest frontier Flatline bootstrap

Operator approval was given in-session on 2026-07-18. This attests the bounded
Sprint 0 execution and its stop conditions; it does not promote unresolved
readiness or model-identity sensors to healthy.

## Sprint 0: Restore an operational council without overstating its sensors

### Sprint Goal

Restore a three-runtime planning council whose participation, evidence
boundaries, and unresolved sensor debt are explicit enough to gate the
Sonar-to-Score Simstim cycle without implying production readiness.

### Scope

**MEDIUM — 5 tasks.** This sprint changes planning/runtime configuration and
governance evidence only; it exercises no production indexing lever.

### Deliverables

- [x] Governed Loa v1.198.7 update and strict integrity repair.
- [x] Fable, Cursor Grok 4.5, and Codex project routing with no Gemini role.
- [x] Content-qualified 3/3 mechanical Flatline participation proof.
- [x] Hash-bound run receipt plus explicit readiness/identity limitations.
- [ ] Re-reviewed canonical sprint plan ready to hand into Simstim.

### Acceptance Criteria

- [ ] The deterministic sprint artifact validator passes.
- [ ] Effective council config resolves exactly the three approved runtimes and
      no Gemini role or fallback.
- [ ] Flatline Phase 1 records three planned, three schema-qualified successful,
      and zero dropped voices.
- [ ] The final plan review has no unadjudicated blocker; carried debt names an
      owner, upstream issue, and consumer-visible exception.
- [ ] Ethereum `start_block` is `12287507`, `ENVIO_RESTART` is unset, and no
      production indexing, database, floor, restart, wipe, or KF-013 replay
      operation occurs.

### Technical Tasks

### T0.1 Update the Loa harness

Run the governed `/update-loa` flow on the isolated branch, moving from
v1.180.0 to Loa v1.198.7 with collateral safeguards.

**AC:** version markers agree; project identity/application files are
preserved; update diff is committed separately; current `/loa-aleph` and model
overlay machinery are present.

### T0.2 Effective transport configuration

Configure `.loa.config.yaml`—not the managed `.claude/` System Zone—for Fable
(`fable`), Cursor Grok 4.5 (`cursor-grok-4.5-high`), and Codex
(`gpt-5.6-sol`), with no Gemini role/fallback.

**AC:** effective config resolves three roles; direct minimal calls return
non-empty outputs; a side receipt binds each alias to the actual CLI model
argument. Provider-served identity is captured when the runtime exposes it;
otherwise the receipt is explicitly `argument-bound` and the served identity
remains unverified sensor debt.

### T0.3 Bootstrap and mechanical proof

Review the sprint diff manually through Fable, Cursor Grok 4.5, and Codex, then
run a fresh mechanical Flatline probe after T0.1–T0.2.

**AC:** three independent runtime receipts are preserved; all three reviewers
return an explicit `verdict: PASS` with no blocking finding; the mechanical
probe returns 3/3 non-empty review contents that validate against the active
agent response schema, plus verdict-quality envelopes that validate against
`.claude/data/schemas/verdict-quality.schema.json`. One qualifying attempt per
runtime is declared before dispatch; every attempt is preserved, and a
replacement attempt is allowed only for a recorded transport failure using the
same configured model argument. Transport-level success cannot substitute an
empty/default response. The stale readiness/MODELINV identity gaps remain
explicitly unresolved rather than being normalized away.

### T0.4 Upstream handoff and Simstim gate

Prepare the upstream Loa defect packet and record issue #1199 linkage without
opening, commenting, or pushing cross-repo changes unless separately
authorized.

**AC:** issue registry and Sonar/Score lineage packet are the source inputs to
a fresh `/simstim`; Simstim may proceed only with 3/3 qualifying Flatline
voices. A qualifying voice is non-empty, schema-valid, argument-bound to the
configured CLI model, and present in `sprint-final_consensus.json` with no
dropped voice. A normalization fallback such as `{"improvements":[]}` does not
qualify when the raw model content failed schema validation. The remaining
schema-valid-but-hollow response loophole is owned by `bd-v54z.5` /
`0xHoneyJar/loa#1231`; the current probe is accepted only because it produced
substantive downstream findings, not because an empty response is trustworthy.
Simstim must acknowledge this exception and the readiness/MODELINV debt in its
input receipt. A readiness warning is sensor debt, never READY.

### T0.E2E End-to-end bootstrap validation

Validate the entire handoff from effective config through content-qualified
Flatline review and the Simstim admission decision.

**AC:** the deterministic artifact validator passes; strict Loa integrity
passes; the run receipt verifies all hashes available after orchestration; the
bead graph keeps Score consumption blocked behind the producer-contract
Simstim task; production invariants are re-sampled immediately before resume.

### Dependencies

- `0xHoneyJar/loa#1228` — content-qualified quorum repair; consumed
  functionally at `13403ee3`, upstream CI/merge tracked by `bd-v54z.4`.
- `0xHoneyJar/loa#1231` / `bd-v54z.5` — reasoned no-findings contract; carried
  as explicit semantic debt, not silently treated as fixed.
- `bd-v54z.2` — Sonar producer-contract Simstim, blocked until Sprint 0 closes.
- `bd-v54z.1` — Score consumption/policy closure, blocked behind Simstim.
- Dated Sonar/Score issue registry and lineage packet under
  `grimoires/loa/context/`.

### Risks & Mitigation

| Risk | Mitigation |
|---|---|
| CLI alias differs from the model actually served | Classify current evidence as argument-bound; fail on authoritative returned-ID mismatch; retain MODELINV debt. |
| A hollow but schema-valid response counts as a voice | Require substantive findings for this probe; track reasoned-empty enforcement in `bd-v54z.5` / Loa #1231. |
| Repeated runs select only unanimous attempts | Predeclare one attempt per runtime; preserve failed attempts; permit replacement only for a recorded same-model transport failure. |
| Readiness warning is laundered into READY | Simstim input must carry the NON-READY exception; no consumer may infer readiness from a 3/3 review quorum. |
| Framework rollback leaves mixed versions | Revert the ordered tail commit, then rerun strict integrity and effective-config assertions. |

### Success Metrics

- Deterministic sprint validation: exit 0.
- Strict Loa integrity: exit 0.
- Flatline content-qualified participation: 3/3, zero dropped.
- Effective council composition: exactly 3 approved runtimes, 0 Gemini roles.
- Unowned review blockers: 0.
- Production mutations: 0.

### Security Considerations

- Fable runs in safe mode; Cursor and Codex run read-only/sandboxed for review.
- No raw secrets or provider credentials are copied into evidence.
- Raw provider/schema rejection values remain a separate redaction issue
  (`0xHoneyJar/loa#1230`).
- GitHub changes remain draft/review-gated; no auto-merge is authorized.

## Evidence

All runtime, routing, council, readiness, and updater receipts live under
`.run/evidence/sonar-score-agent-dream-outcome/`. The machine-readable
mechanical council receipt lives at
`grimoires/loa/a2a/flatline/sprint-final_consensus.json`; the run-bound hash
receipt lives at
`.run/evidence/sonar-score-agent-dream-outcome/flatline-run-receipt.json`.

## Verification

- Loa version markers resolve to `1.198.7`, and the governed framework update
  remains a separate commit.
- Direct Fable, Cursor Grok 4.5, and Codex calls each return a non-empty
  response, with evidence binding the configured role to the actual CLI model
  argument.
- No Gemini role, fallback, or receipt is present in the effective council.
- A machine-readable effective-config assertion confirms the exact three-role
  cohort before the probe.
- A fresh Flatline probe returns three schema-valid, non-empty verdicts.
- The v1.198.7 Flatline readiness result remains non-ready (`NO_API_KEYS`,
  previously `DEGRADED`) until its headless-auth and model-identity defects are
  fixed upstream; operational transport proof must not relabel that sensor as
  ready.
- No post-update `.claude/` changes are introduced by this sprint.
- Ethereum `start_block` remains `12287507` in `config.yaml`;
  `ENVIO_RESTART` remains absent from the execution environment, and no
  database wipe, restart, or production indexing lever is exercised.

## Rollback

If a configured model argument, integrity, or production invariant fails, halt
the run and revert only the isolated pass commit that introduced the failing
change. The ordered bootstrap commit chain is:

1. `b6fb9ece` — governed Loa v1.198.7 update;
2. `4b1152f9` — sprint activation;
3. `ea1ee234` — runnable bootstrap;
4. `9510b73c` — strict integrity manifest repair;
5. `fb656fd9` — frontier council overlay;
6. `13403ee3` — content-qualified quorum repair consumption.

Revert from the tail and re-run strict integrity plus effective-config checks
after each rollback. No rollback requires a database, indexer, restart, floor,
or production operation.

## Stop conditions

- Any configured CLI model argument mismatch or authoritative provider-returned
  identity mismatch.
- Fewer than three valid voices.
- Any replacement attempt without a recorded same-model transport failure.
- Any claim that the current hardcoded readiness script is fixed by a
  repo-local wrapper.
- Any attempted edit in `.claude/` outside the governed `/update-loa` merge.
- Any production, database, floor, or restart mutation.
