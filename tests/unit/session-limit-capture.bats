#!/usr/bin/env bats
# =============================================================================
# tests/unit/session-limit-capture.bats
#
# cycle-117 item A — session-limit-capture.sh
# (bd-c117-a-session-cap-x04j, issue #1177 A).
#
# Each test runs in a clean tmp PROJECT_ROOT so the repo's own .run/ state is
# never read or written.
# =============================================================================

# session-limit-capture.sh parses reset times through session-limit-lib.sh,
# which requires GNU `date -d` and lives in System Zone. Tests that drive a real
# capture skip cleanly where GNU date is absent (BSD/darwin) and run in full on
# GNU platforms (Linux CI). TC-005 (PR #221).
_require_gnu_date() {
    date --version >/dev/null 2>&1 || \
        skip "session-limit-capture.sh requires GNU date -d (System Zone); unavailable on this platform"
}

# Portable datetime→epoch (GNU auto-parse / BSD `date -j -f`). TC-005.
_epoch() {
    local fmt="$1" val="$2"
    if date --version >/dev/null 2>&1; then
        date -d "$val" +%s
    else
        case "$fmt" in
            *%z) val="$(printf '%s' "$val" | sed -E 's/([+-][0-9]{2}):([0-9]{2})$/\1\2/')" ;;
        esac
        date -j -f "$fmt" "$val" +%s
    fi
}

setup() {
    SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
    REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
    CAP="$REPO_ROOT/.claude/scripts/session-limit-capture.sh"
    PR="$BATS_TEST_TMPDIR/proj"
    mkdir -p "$PR/.run"
    STATE="$PR/.run/session-limit-state.json"
    export PROJECT_ROOT="$PR"
}

_seed_sprint() {
    printf '%s' "$1" > "$PR/.run/sprint-plan-state.json"
}

@test "capture: writes state with correct reset fields + embedded scalars" {
    _require_gnu_date
    _seed_sprint '{"state":"RUNNING","cycle":"cycle-117","plan_id":"plan-x","sprints":{"current":"sprint-9"}}'
    run "$CAP" --raw "You've hit your session limit · resets 3pm (Australia/Melbourne)"
    [ "$status" -eq 0 ]
    [ -f "$STATE" ]
    [ "$(jq -r '.reset_at' "$STATE")" != "null" ]
    # Year-agnostic (TC-004): capture uses the real wall clock, so assert the
    # ISO-8601 shape + Melbourne offset without pinning the year.
    [[ "$(jq -r '.reset_at' "$STATE")" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\+10:00|\+11:00)$ ]]
    [[ "$(jq -r '.reset_at_epoch' "$STATE")" =~ ^[0-9]+$ ]]
    [ "$(jq -r '.hit_at' "$STATE")" != "null" ]
    # Embedded scalars, not bare path references.
    [ "$(jq -r '.active_run_state_snapshot.sprint_plan.state' "$STATE")" = "RUNNING" ]
    [ "$(jq -r '.active_run_state_snapshot.sprint_plan.current' "$STATE")" = "sprint-9" ]
    [ "$(jq -r '.active_run_state_snapshot.sprint_plan.cycle' "$STATE")" = "cycle-117" ]
    [ "$(jq -r '.active_run_state_snapshot.sprint_plan.plan_id' "$STATE")" = "plan-x" ]
    # No invented 'phase' field on sprint_plan.
    [ "$(jq -r '.active_run_state_snapshot.sprint_plan.phase' "$STATE")" = "null" ]
}

@test "capture: no bare path references embedded in the snapshot" {
    _require_gnu_date
    _seed_sprint '{"state":"RUNNING","sprints":{"current":"sprint-1"}}'
    run "$CAP" --raw "out of extra usage · resets 9:50pm (Australia/Melbourne)"
    [ "$status" -eq 0 ]
    # The literal path string must not appear anywhere in the snapshot.
    run grep -c "sprint-plan-state.json" "$STATE"
    [ "$output" = "0" ]
}

@test "capture: reset_at_epoch matches reset_at instant" {
    _require_gnu_date
    _seed_sprint '{"state":"RUNNING","sprints":{"current":"s1"}}'
    run "$CAP" --raw "hit your session limit · resets 3pm (Australia/Melbourne)"
    [ "$status" -eq 0 ]
    local iso epoch
    iso="$(jq -r '.reset_at' "$STATE")"
    epoch="$(jq -r '.reset_at_epoch' "$STATE")"
    [ "$epoch" = "$(_epoch '%Y-%m-%dT%H:%M:%S%z' "$iso")" ]
}

@test "capture: no active run state → snapshot uses defaults, still writes" {
    _require_gnu_date
    run "$CAP" --raw "out of extra usage · resets 3pm (Australia/Melbourne)"
    [ "$status" -eq 0 ]
    [ -f "$STATE" ]
    [ "$(jq -r '.active_run_state_snapshot.sprint_plan.state' "$STATE")" = "unknown" ]
    [ "$(jq -r '.active_run_state_snapshot.sprint_plan.current' "$STATE")" = "null" ]
}

@test "capture: leaves no stray .tmp file behind on success" {
    _require_gnu_date
    _seed_sprint '{"state":"RUNNING","sprints":{"current":"s1"}}'
    run "$CAP" --raw "hit your session limit · resets 3pm (Australia/Melbourne)"
    [ "$status" -eq 0 ]
    run bash -c "ls -a '$PR/.run' | grep -c '\\.tmp'"
    [ "$output" = "0" ]
}

@test "capture: non-cap input → exit 1, no state file written" {
    run "$CAP" --raw "just some unrelated text"
    [ "$status" -eq 1 ]
    [ ! -f "$STATE" ]
}

@test "capture: missing --raw → exit 1" {
    run "$CAP"
    [ "$status" -eq 1 ]
    [ ! -f "$STATE" ]
}

@test "capture: does not clobber a pre-existing state file on non-match" {
    printf '%s' '{"sentinel":true}' > "$STATE"
    run "$CAP" --raw "not a cap string"
    [ "$status" -eq 1 ]
    [ "$(jq -r '.sentinel' "$STATE")" = "true" ]
}
