# Implementation Report: sprint-bug-227

## Executive Summary

Flatline now qualifies each Phase 1 review against the `flatline-reviewer` content contract before the voice can contribute to verdict-quality quorum. The planned cohort size remains independent of the qualified input count, stale consensus evidence is cleared before fail-soft exits, and Cursor structured inference uses read-only `ask` mode while retaining its sandbox boundaries.

## AC Verification

**AC-1**: Bug is no longer reproducible.
- Status: ✓ Met
- Evidence: tests/integration/flatline-content-qualified-quorum.bats:47
- Verification: The captured exit-0 prose response is rejected and the resulting planned three-voice cohort is degraded 2/3, never APPROVED.

**AC-2**: Failing test proves the fix.
- Status: ✓ Met
- Evidence: tests/integration/flatline-content-qualified-quorum.bats:47
- Verification: CQ-1 failed before `qualify_flatline_content` existed and passes after the production qualification path was added.

**AC-3**: Planned quorum never shrinks because content is invalid.
- Status: ✓ Met
- Evidence: .claude/scripts/flatline-orchestrator.sh:2338
- Verification: The configured cohort determines `expected_review_voices`; only qualified files enter aggregation, and the explicit planned count is passed separately.

**AC-4**: No APPROVED result is possible when any planned voice lacks valid review content.
- Status: ✓ Met
- Evidence: .claude/scripts/flatline-orchestrator.sh:2341
- Verification: Schema-invalid content is excluded while the denominator remains three; CQ-1 proves the aggregate is degraded and non-APPROVED. CQ-3 also proves a prior APPROVED artifact cannot survive an all-invalid rerun.

**AC-5**: Cursor safety boundaries remain intact.
- Status: ✓ Met
- Evidence: .claude/adapters/tests/test_cursor_headless_adapter.py:103
- Verification: Command construction pins read-only `--mode ask`, `--sandbox enabled`, and `--trust`, while prohibiting `-f`, `--force`, and `--yolo`.

## Tasks Completed

- Added a hermetic false-green reproduction using the exact exit-0 prose failure shape observed downstream.
- Added pre-aggregation content normalization and schema qualification with bounded rejection trajectory events.
- Preserved the planned cohort denominator when invalid responses are excluded.
- Cleared stale final-consensus output before every aggregation attempt.
- Switched Cursor from planning narration mode to read-only Q&A mode and pinned the safety flags in tests.
- Registered KF-023 with the downstream reproduction, workaround, and repair evidence.

## Technical Highlights

- Transport success and epistemic participation are now separate states.
- The existing canonical Python verdict aggregator remains the sole merge implementation.
- A rejected voice is auditable as `consensus.voice_rejected` with voice, reason, agent, and phase.
- Zero qualified voices fail closed with exit 3 after stale consensus evidence is removed.

## Testing Summary

- `bats tests/integration/flatline-content-qualified-quorum.bats tests/integration/flatline-orchestrator-voice-drop.bats tests/unit/verdict-quality-aggregate-cli.bats`: 17 passed.
- `bats tests/unit/cycle-109-t3-3-flatline-extract-json-content.bats`: 8 passed.
- Cursor adapter and verdict aggregation Python suites: 77 passed, 1 skipped.
- `bash -n .claude/scripts/flatline-orchestrator.sh`: passed.
- `git diff --check`: passed.
- Live Cursor Grok 4.5 `ask`-mode probe returned schema-valid `improvements` JSON under session `23f4abf9-d41e-48a0-97f5-f6de7d7ccb06`.

## Known Limitations

- Content qualification is scoped to Flatline Phase 1 review voices. Other consumers of headless adapter envelopes require their own contract boundary.
- Verdict aggregation remains intentionally fail-soft for infrastructure errors, but prior consensus is removed first so failure cannot inherit an APPROVED artifact.
- Independent Fable, Cursor, and Codex patch review remains the next gate before audit.

## Verification Steps

1. Run the focused Bats suites listed above.
2. Run the Cursor adapter and verdict aggregation Python suites with `PYTHONDONTWRITEBYTECODE=1`.
3. Inspect CQ-1 and confirm `voices_planned=3`, `voices_succeeded=2`, `chain_health=degraded`, and `status!=APPROVED`.
4. Inspect CQ-2 and confirm all-valid behavior remains APPROVED 3/3.
5. Inspect CQ-3 and confirm an all-invalid rerun leaves no stale consensus artifact.

## Feedback Addressed

No external review findings have been received yet. The implementation self-review added CQ-3 after identifying stale prior consensus as a second false-green path in the same boundary.
