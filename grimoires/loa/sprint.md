---
title: "Sprint Plan — honest frontier Flatline bootstrap"
status: active
trust_tier: ai-derived
read_state: read
confidence: 0.88
decay_class: working
last_confirmed: 2026-07-18
operator_signed: false
---

# Sprint Plan — Honest frontier Flatline bootstrap

## Sprint 0: Restore an operational council without overstating its sensors

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
non-empty outputs; a side receipt binds alias to actual CLI model arguments.

### T0.3 Bootstrap and mechanical proof

Review the sprint diff manually through Fable, Cursor Grok 4.5, and Codex, then
run a fresh mechanical Flatline probe after T0.1–T0.2.

**AC:** three independent runtime receipts are preserved; all three reviewers
return an explicit `verdict: PASS` with no blocking finding; the mechanical
probe returns 3/3 non-empty review contents that validate against the active
agent response schema, plus verdict-quality envelopes that validate against
`.claude/data/schemas/verdict-quality.schema.json`. Transport-level success
cannot substitute an empty/default response. The stale readiness/MODELINV
identity gaps remain explicitly unresolved rather than being normalized away.

### T0.4 Upstream handoff and Simstim gate

Prepare the upstream Loa defect packet and record issue #1199 linkage without
opening, commenting, or pushing cross-repo changes unless separately
authorized.

**AC:** issue registry and Sonar/Score lineage packet are the source inputs to
a fresh `/simstim`; Simstim may proceed only with 3/3 qualifying Flatline
voices. A qualifying voice is non-empty, schema-valid, runtime-identity-bound,
and present in `sprint-final_consensus.json` with no dropped voice; a
normalization fallback such as `{"improvements":[]}` does not qualify when the
raw model content failed schema validation. A readiness warning is recorded as
sensor debt, never as READY.

## Evidence

All runtime, routing, council, readiness, and updater receipts live under
`.run/evidence/sonar-score-agent-dream-outcome/`. The machine-readable
mechanical council receipt lives at
`grimoires/loa/a2a/flatline/sprint-final_consensus.json`.

## Verification

- Loa version markers resolve to `1.198.7`, and the governed framework update
  remains a separate commit.
- Direct Fable, Cursor Grok 4.5, and Codex calls each return a non-empty
  response, with evidence binding the configured role to the actual CLI model
  argument.
- No Gemini role, fallback, or receipt is present in the effective council.
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

If a model identity, integrity, or production invariant fails, halt the run
and revert only the isolated pass commit that introduced the failing change.
The governed Loa update, checksum repair, planning changes, and model overlay
are separate commits so rollback does not require a database, indexer, or
production operation.

## Stop conditions

- Any runtime/model identity mismatch.
- Fewer than three valid voices.
- Any claim that the current hardcoded readiness script is fixed by a
  repo-local wrapper.
- Any attempted edit in `.claude/` outside the governed `/update-loa` merge.
- Any production, database, floor, or restart mutation.
