#!/usr/bin/env bats
# Regression for #1227: transport success is not epistemic participation.

setup() {
    PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    ORCH="$PROJECT_ROOT/.claude/scripts/flatline-orchestrator.sh"
    SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/flatline-qualified-quorum.XXXXXX")"
    chmod 700 "$SCRATCH"

    # shellcheck disable=SC1090
    source "$ORCH"
    export TEMP_DIR="$SCRATCH"
    log() { :; }
    log_trajectory() { :; }
}

teardown() {
    rm -f "$PROJECT_ROOT/grimoires/loa/a2a/flatline/sprint-final_consensus.json"
    [[ -n "${SCRATCH:-}" && -d "$SCRATCH" ]] && rm -rf "$SCRATCH"
}

write_voice() {
    local file="$1"
    local voice="$2"
    local content="$3"
    jq -n \
        --arg content "$content" \
        --arg voice "$voice" \
        '{
          content: $content,
          verdict_quality: {
            status: "APPROVED",
            consensus_outcome: "consensus",
            truncation_waiver_applied: false,
            voices_planned: 1,
            voices_succeeded: 1,
            voices_succeeded_ids: [$voice],
            voices_dropped: [],
            chain_health: "ok",
            confidence_floor: "high",
            rationale: "single voice completed",
            single_voice_call: true
          }
        }' > "$file"
}

@test "CQ-1: schema-invalid exit-0 prose cannot produce APPROVED 3-of-3 quorum" {
    local first="$SCRATCH/first.json"
    local cursor="$SCRATCH/cursor.json"
    local third="$SCRATCH/third.json"
    write_voice "$first" "claude-headless" '{"improvements":[]}'
    write_voice "$cursor" "cursor-headless" \
        'Reviewing the sprint plan. Delivering the Flatline review as required.'
    write_voice "$third" "codex-headless" '{"improvements":[]}'

    local -a qualified=()
    local spec label file
    for spec in "first:$first" "cursor:$cursor" "third:$third"; do
        label="${spec%%:*}"
        file="${spec#*:}"
        if qualify_flatline_content "$file" "flatline-reviewer" "$label" "sprint"; then
            qualified+=("$file")
        fi
    done

    [ "${#qualified[@]}" -eq 2 ]
    aggregate_and_write_final_consensus "sprint" 3 "${qualified[@]}"

    local consensus="$PROJECT_ROOT/grimoires/loa/a2a/flatline/sprint-final_consensus.json"
    [ "$(jq -r '.voices_planned' "$consensus")" -eq 3 ]
    [ "$(jq -r '.voices_succeeded' "$consensus")" -eq 2 ]
    [ "$(jq -r '.chain_health' "$consensus")" = "degraded" ]
    [ "$(jq -r '.status' "$consensus")" != "APPROVED" ]
}

@test "CQ-2: three schema-valid voices retain APPROVED 3-of-3 quorum" {
    local first="$SCRATCH/first.json"
    local second="$SCRATCH/second.json"
    local third="$SCRATCH/third.json"
    write_voice "$first" "claude-headless" '{"improvements":[]}'
    write_voice "$second" "cursor-headless" '{"improvements":[]}'
    write_voice "$third" "codex-headless" '{"improvements":[]}'

    local file
    for file in "$first" "$second" "$third"; do
        qualify_flatline_content "$file" "flatline-reviewer" "voice" "sprint"
    done
    aggregate_and_write_final_consensus "sprint" 3 "$first" "$second" "$third"

    local consensus="$PROJECT_ROOT/grimoires/loa/a2a/flatline/sprint-final_consensus.json"
    [ "$(jq -r '.voices_planned' "$consensus")" -eq 3 ]
    [ "$(jq -r '.voices_succeeded' "$consensus")" -eq 3 ]
    [ "$(jq -r '.chain_health' "$consensus")" = "ok" ]
    [ "$(jq -r '.status' "$consensus")" = "APPROVED" ]
}

@test "CQ-3: a run with no qualified voices removes stale APPROVED consensus" {
    local consensus="$PROJECT_ROOT/grimoires/loa/a2a/flatline/sprint-final_consensus.json"
    mkdir -p "$(dirname "$consensus")"
    printf '%s\n' '{"status":"APPROVED","voices_planned":3,"voices_succeeded":3}' > "$consensus"

    aggregate_and_write_final_consensus "sprint" 3

    [ ! -e "$consensus" ]
}
