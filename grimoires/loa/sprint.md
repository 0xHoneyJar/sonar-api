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
v1.180.0 to the current Loa head/release with collateral safeguards.

**AC:** version markers agree; project identity/application files are
preserved; update diff is committed separately; current `/loa-aleph` and model
overlay machinery are present.

### T0.2 Effective transport configuration

Configure the Sonar project overlay for Fable, Cursor Grok 4.5, and Codex
using exact live model IDs and no Gemini role/fallback.

**AC:** effective config resolves three roles; direct minimal calls return
non-empty outputs; a side receipt binds alias to actual CLI model arguments.

### T0.3 Bootstrap and mechanical proof

Review the sprint diff manually through Fable, Cursor Grok 4.5, and Codex, then
run a fresh mechanical Flatline probe after T0.1–T0.2.

**AC:** three independent runtime receipts are preserved; all three reviewers
PASS the revised overlay; the mechanical probe returns 3/3 non-empty,
schema-valid verdicts. The stale readiness/MODELINV identity gaps remain
explicitly unresolved rather than being normalized away.

### T0.4 Upstream handoff and Simstim gate

Prepare the upstream Loa defect packet and record issue #1199 linkage without
opening, commenting, or pushing cross-repo changes unless separately
authorized.

**AC:** issue registry and Sonar/Score lineage packet are the `--from` inputs
to a fresh `/simstim`; Simstim may proceed only with 3/3 qualifying Flatline
voices. A readiness warning is recorded as sensor debt, never as READY.

## Verification

- Loa version markers resolve to `1.198.7`, and the governed framework update
  remains a separate commit.
- Direct Fable, Cursor Grok 4.5, and Codex calls each return a non-empty
  response, with evidence binding the configured role to the actual CLI model
  argument.
- No Gemini role, fallback, or receipt is present in the effective council.
- A fresh Flatline probe returns three schema-valid, non-empty verdicts.
- The existing Flatline readiness result remains `DEGRADED` until its
  headless-auth and model-identity defects are fixed upstream; operational
  transport proof must not relabel that sensor as ready.
- No post-update `.claude/` changes are introduced by this sprint.
- Ethereum `start_block` remains `12287507`, `ENVIO_RESTART` remains unset,
  and no database wipe, restart, or production indexing lever is exercised.

## Stop conditions

- Any runtime/model identity mismatch.
- Fewer than three valid voices.
- Any claim that the current hardcoded readiness script is fixed by a
  repo-local wrapper.
- Any attempted edit in `.claude/` outside the governed `/update-loa` merge.
- Any production, database, floor, or restart mutation.
