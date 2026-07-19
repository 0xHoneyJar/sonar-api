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
readiness or model-identity sensors to healthy. The separate operator receipt
is `.run/evidence/sonar-score-agent-dream-outcome/operator-approval-receipt.json`.

## Sprint 0: Restore an operational council without overstating its sensors

### Sprint Goal

Restore a three-runtime observational planning council whose participation,
evidence boundaries, and unresolved sensor debt are explicit enough to run a
Sonar producer-contract Simstim cycle without implying identity-verified
readiness or unblocking Score consumption.

### Scope

**MEDIUM — 5 tasks.** This sprint changes planning/runtime configuration and
governance evidence only; it exercises no production indexing lever.

### Deliverables

- [x] Governed Loa v1.198.7 update and strict integrity repair.
- [x] Fable, Cursor Grok 4.5, and Codex project routing with no Gemini role.
- [x] Content-qualified 3/3 mechanical Flatline participation proof.
- [x] Hash-bound run receipt plus explicit readiness/identity limitations.
- [ ] Re-reviewed canonical sprint plan ready for observational Simstim only.

### Acceptance Criteria

- [x] The deterministic sprint artifact validator passes.
- [x] Effective council config resolves exactly the three approved runtimes and
      no Gemini role or fallback.
- [x] Flatline Phase 1 records three planned, three schema-qualified successful,
      and zero dropped voices.
- [ ] The final plan review has no unadjudicated blocker for observational
      planning; every graduation blocker names an owner and dependency.
- [x] Ethereum `start_block` is `12287507`, `ENVIO_RESTART` is unset, and no
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
remains unverified sensor debt. CLI version, executable hash, local alias
mapping, and returned metadata are frozen in `runtime-alias-attestation.json`;
this permits observational planning but cannot satisfy the Score graduation
gate.

### T0.3 Bootstrap and mechanical proof

Review the sprint diff manually through Fable, Cursor Grok 4.5, and Codex, then
run a fresh mechanical Flatline probe after T0.1–T0.2.

**AC:** three independent runtime receipts are preserved; all three reviewers
return an explicit `verdict: PASS` with no blocking finding; the mechanical
probe returns 3/3 non-empty review contents that validate against the active
agent response schema, plus verdict-quality envelopes that validate against
`.claude/data/schemas/verdict-quality.schema.json`. One attempt per runtime is
declared before dispatch. There are no replacement attempts inside that
declared run: timeout, non-zero exit, auth/network error, schema-invalid
content, refusal, truncation, or an unfavorable finding all invalidate the
run. A later run requires a new pre-dispatch declaration and preserves the
prior receipt. Transport-level success cannot substitute an empty/default
response. The stale readiness/MODELINV identity gaps remain explicitly
unresolved rather than being normalized away.

### T0.4 Upstream handoff and Simstim gate

Prepare the upstream Loa defect packet and record issue #1199 linkage without
opening, commenting, or pushing cross-repo changes unless separately
authorized.

**AC:** issue registry and Sonar/Score lineage packet are the source inputs to
a fresh `/simstim`. Observational Simstim planning may proceed after 3/3
non-empty, schema-valid, argument-bound voices are present in
`sprint-final_consensus.json` with no dropped voice. That cohort is not an
identity-verified admission quorum and its output cannot unblock Score
consumption. A normalization fallback such as `{"improvements":[]}` does not
qualify when raw content failed schema validation. The remaining
schema-valid-but-hollow loophole is owned by `bd-v54z.5` /
`0xHoneyJar/loa#1231`; Score consumption additionally depends on
`bd-v54z.6`, the complete, redacted, identity-bound receipt gate. Simstim must
carry those two open dependencies plus readiness/MODELINV NON-READY status in
its input and output receipts.

### T0.E2E End-to-end bootstrap validation

Validate the entire handoff from effective config through content-qualified
Flatline review and the Simstim admission decision.

**AC:** the deterministic artifact validator and strict Loa integrity check
pass; the declared attempt is hash-bound; the bead graph keeps Score
consumption blocked behind `bd-v54z.2`, `bd-v54z.5`, and `bd-v54z.6`;
production invariants are sampled before and after review; observational
Simstim output is labeled non-authoritative until its graduation dependencies
close.

### Dependencies

- `0xHoneyJar/loa#1228` — content-qualified quorum repair; consumed
  functionally from `79d12db5` at Sonar commit `13403ee3`; upstream PR head
  `8dbac852` differs only by CI index/map repair. The fork pin is owned by
  `bd-v54z.4` and expires before Score consumption: merge or replace it first.
- `0xHoneyJar/loa#1231` / `bd-v54z.5` — reasoned no-findings contract; carried
  as explicit semantic debt, not silently treated as fixed.
- `bd-v54z.6` — identity-bound, complete, redacted council receipt gate.
- `bd-v54z.2` — Sonar producer-contract Simstim, blocked until Sprint 0 closes.
- `bd-v54z.1` — Score consumption/policy closure, blocked behind Simstim.
- Dated Sonar/Score issue registry and lineage packet under
  `grimoires/loa/context/`.

### Risks & Mitigation

| Risk | Mitigation |
|---|---|
| CLI alias differs from the model actually served | Freeze version/hash/alias evidence, classify it as observational, and block Score on `bd-v54z.6`; fail on authoritative returned-ID mismatch. |
| A hollow but schema-valid response counts as a voice | Treat observational Simstim as non-authoritative and block Score on `bd-v54z.5` / Loa #1231. |
| Repeated runs select only unanimous attempts | Permit no replacement inside a declared run; every later run gets a new declaration and retains prior receipts. |
| Readiness warning is laundered into READY | Simstim input must carry the NON-READY exception; no consumer may infer readiness from a 3/3 review quorum. |
| Framework rollback leaves mixed versions | Revert the ordered tail commit, then rerun strict integrity and effective-config assertions. |

### Success Metrics

- Deterministic sprint validation: exit 0.
- Strict Loa integrity: exit 0.
- Flatline content-qualified participation: 3/3, zero dropped.
- Effective council composition: exactly 3 approved runtimes, 0 Gemini roles.
- Unowned review blockers: 0; graduation debt may remain open only when owned
  and dependency-blocking.
- Production mutations: 0.

### Security Considerations

- Fable runs in safe mode; Cursor and Codex run read-only/sandboxed for review.
- No raw secrets or provider credentials are copied into evidence.
- Review subprocesses receive no environment variables whose names match
  `DATABASE*`, `PG*`, `POSTGRES*`, `RAILWAY*`, `ENVIO*`, `PONDER*`, or
  `REDIS*`; values are neither inspected nor recorded.
- Raw provider/schema rejection values remain a separate redaction issue
  (`0xHoneyJar/loa#1230`).
- Raw orchestration outputs remain outside the handoff directory; the
  allowlist scan and live-reference checks are recorded in
  `evidence-handoff-receipt.json`.
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
- `bash .claude/scripts/check-loa.sh --quiet` exits 0.
- `.claude/scripts/validate-artifact.sh --type sprint --file
  grimoires/loa/sprint.md` exits 0.
- `jq -e .` validates every JSON receipt in the evidence directory, and the
  handoff secret-like scan returns no findings.
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
- Any replacement attempt within a predeclared run.
- Any claim that the current hardcoded readiness script is fixed by a
  repo-local wrapper.
- Any attempted edit in `.claude/` outside the governed `/update-loa` merge.
- Any production, database, floor, or restart mutation.
