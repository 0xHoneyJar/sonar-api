#!/usr/bin/env bats

setup() {
  export PROJECT_ROOT="$BATS_TEST_DIRNAME/../.."
  export CHECKER="$PROJECT_ROOT/scripts/check-simstim-admission.mjs"
  export RECEIPT="$BATS_TEST_TMPDIR/receipt.json"
  cd "$PROJECT_ROOT"

  cat >"$RECEIPT" <<'JSON'
{
  "schema_version": "1.0.0",
  "stage": "pre_dispatch",
  "purpose": "OBSERVATIONAL_PLANNING",
  "classification": "NON_AUTHORITATIVE",
  "readiness": {"status": "NON_READY"},
  "identity": {"provider_served_verified": false},
  "score": {
    "artifact_emission_allowed": false,
    "consumption_ready": false
  },
  "graduation": {
    "dependencies": ["bd-v54z.4", "bd-v54z.5", "bd-v54z.6"]
  },
  "campaign": {
    "prior_result": "BLOCKED_EXHAUSTED",
    "current_attempt_budget": 1,
    "prior_findings_carried": true
  },
  "upstream_pin": {
    "pr": 1228,
    "status": "CI_GREEN_PENDING_MERGE"
  },
  "artifact_manifest": {
    "complete": true,
    "artifacts": [
      {
        "path": "grimoires/loa/prd.md",
        "consumer": "planning",
        "classification": "NON_AUTHORITATIVE"
      }
    ]
  },
  "production_invariants": {
    "ethereum_start_block": 12287507,
    "envio_restart": "UNSET",
    "mutations_allowed": false
  }
}
JSON
}

@test "admits a complete observational-only receipt" {
  run node "$CHECKER" "$RECEIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"ADMITTED_OBSERVATIONAL_ONLY"* ]]
}

@test "rejects readiness promotion" {
  jq '.readiness.status = "READY"' "$RECEIPT" >"$RECEIPT.tmp"
  mv "$RECEIPT.tmp" "$RECEIPT"

  run node "$CHECKER" "$RECEIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"readiness.status"* ]]
}

@test "rejects a missing graduation dependency" {
  jq 'del(.graduation.dependencies[1])' "$RECEIPT" >"$RECEIPT.tmp"
  mv "$RECEIPT.tmp" "$RECEIPT"

  run node "$CHECKER" "$RECEIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bd-v54z.5"* ]]
}

@test "rejects Score-facing artifact emission" {
  jq '.artifact_manifest.artifacts[0].consumer = "score"' "$RECEIPT" >"$RECEIPT.tmp"
  mv "$RECEIPT.tmp" "$RECEIPT"

  run node "$CHECKER" "$RECEIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"consumer cannot be score"* ]]
}

@test "rejects identity verification without authoritative evidence" {
  jq '.identity.provider_served_verified = true' "$RECEIPT" >"$RECEIPT.tmp"
  mv "$RECEIPT.tmp" "$RECEIPT"

  run node "$CHECKER" "$RECEIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"provider_served_verified"* ]]
}

@test "rejects an unbound post-dispatch artifact" {
  jq '.stage = "post_dispatch"' "$RECEIPT" >"$RECEIPT.tmp"
  mv "$RECEIPT.tmp" "$RECEIPT"

  run node "$CHECKER" "$RECEIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"sha256 must bind post-dispatch output"* ]]
}

@test "rejects execution when ENVIO_RESTART is present" {
  run env ENVIO_RESTART=false node "$CHECKER" "$RECEIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"ENVIO_RESTART must be unset"* ]]
}
