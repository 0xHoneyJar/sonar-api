---
title: "PRD — honest frontier Flatline bootstrap"
status: active
trust_tier: ai-derived
read_state: read
confidence: 0.9
decay_class: working
last_confirmed: 2026-07-18
operator_signed: false
---

# PRD — Honest frontier Flatline bootstrap

## Problem

The configured Flatline council reports `DEGRADED` even though the intended
subscription transports work:

- Fable responds through Claude CLI.
- Cursor Grok 4.5 responds through Cursor Agent.
- Codex headless responds through Codex CLI.

Readiness currently maps `claude-headless` to `ANTHROPIC_API_KEY`, retains
Gemini as the tertiary voice, and validates only the frozen default alias
registry. The council therefore misreports available transports and cannot
truthfully approve the Sonar/Score plan.

## Outcome

Flatline runs three independent, honestly identified voices:

1. Fable via Claude CLI
2. Cursor Grok 4.5 via Cursor Agent
3. Codex headless via Codex CLI

No Gemini route is selected. The delivery is split into two truths:

1. **Operational closure in Sonar**: all three intended subscription transports
   dispatch and return qualifying, non-empty review envelopes.
2. **Sensor/identity closure in upstream Loa**: readiness reads effective
   headless configuration, and MODELINV binds the resolved alias to the actual
   CLI model argument.

The Sonar cycle must not relabel the first as the second.

## Acceptance

- Sonar is updated from Loa v1.180.0 to the current governed release/main
  before configuring new model overlays.
- A three-voice Flatline probe returns three non-empty, schema-valid verdicts
  from Fable, Cursor Grok 4.5, and Codex.
- The temporary alias/payload workaround is explicitly marked as such and a
  side receipt binds `cursor-headless` to the actual
  `cursor-grok-4.5-high` CLI argument. It is not treated as identity closure.
- The upstream Loa plan requires `flatline-readiness.sh --json` to become
  headless-aware and requires MODELINV to record the actual CLI model.
- Until that upstream change lands, Simstim's readiness warning is
  **advisory but unresolved**; any Flatline result with fewer than three
  qualifying voices is degraded and cannot approve.
- No files under `.claude/` are edited directly outside the governed
  `/update-loa` merge.
- Gemini CLI and Gemini Flatline routing are absent.

## Non-goals

- No Sonar application code.
- No production or database mutation.
- No hidden replacement of the estate-wide Loa registry in Sonar.
