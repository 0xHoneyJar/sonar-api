---
title: "SDD — honest frontier Flatline bootstrap"
status: active
trust_tier: ai-derived
read_state: read
confidence: 0.88
decay_class: working
last_confirmed: 2026-07-18
operator_signed: false
---

# SDD — Honest frontier Flatline bootstrap

## Stage A — consume the recent Loa update

Update the isolated Sonar planning branch from Loa v1.180.0 to the current
governed Loa head using `/update-loa` safeguards. This supplies the newer
model-overlay machinery and `/loa-aleph` intake without hand-copying System
Zone files.

## Stage B — prove the intended transports in Sonar

Use the project override surface in `.loa.config.yaml`; the framework-managed
`.claude/` System Zone remains untouched.

1. Configure Flatline roles as `claude-headless`, `cursor-headless`, and
   `codex-headless`.
2. In the project Hounfour overlay, bind the Cursor provider payload to the
   current exact Cursor Agent model ID `cursor-grok-4.5-high`.
3. Preserve Fable through the existing Claude headless payload binding.
4. Emit a Sonar-side invocation receipt that records the effective alias,
   provider, adapter, and actual `cli_model` argument for each voice.
5. Run a deterministic three-voice Flatline probe. Non-empty output and
   schema validity are mandatory; an empty Cursor success does not qualify.
6. Record the remaining upstream defects separately:
   - project alias overlays excluded from pre-runtime validation
   - headless readiness conflated with HTTP API-key readiness
   - missing honest Cursor Grok 4.5 registry identity
   - MODELINV records the registry target but not the actual CLI payload

## Stage C — upstream Loa repair

The durable fix belongs in `0xHoneyJar/loa`, not a Sonar wrapper:

1. Flatline pre-validation consumes the effective merged alias set.
2. Readiness resolves `kind/auth_type` and checks CLI subscription state for
   headless models.
3. MODELINV adds the dispatched CLI model identity.
4. Cursor empty output fails qualification.
5. Tests cover Fable + Cursor Grok 4.5 + Codex with Gemini absent.

Cross-repo mutation or a Loa PR remains a coordinator action and requires its
own authorization/room. Sonar records the upstream handoff without claiming
that the upstream defect is already fixed.

## Bootstrap caveat

Flatline cannot approve the repair that makes its own identity/readiness
sensors truthful. This sprint therefore uses independent manual runtime
receipts only to authorize the temporary Sonar overlay. It does not approve
the upstream Loa repair; that needs a separately governed Loa cycle.

## Verification

- Static config parse and model-resolution tests.
- Direct, minimal round trip through each runtime.
- Fresh readiness probe, preserved honestly even if it remains advisory
  `DEGRADED`.
- Fresh Flatline review over a small deterministic artifact with 3/3
  qualifying voices.
- Side receipt verifies actual runtime/model arguments; MODELINV mismatch stays
  an open defect until upstream closure.
