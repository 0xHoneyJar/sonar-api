#!/usr/bin/env bats

setup() {
  export PROJECT_ROOT="$BATS_TEST_DIRNAME/../.."
  export WRAPPER="$PROJECT_ROOT/scripts/with-flatline-env.sh"
}

@test "review command receives safe process variables" {
  run env -i \
    HOME="$HOME" \
    PATH="$PATH" \
    USER="${USER:-tester}" \
    LANG="C" \
    "$WRAPPER" sh -c 'printf "%s|%s|%s" "$HOME" "$USER" "$LANG"'

  [ "$status" -eq 0 ]
  [ "$output" = "$HOME|${USER:-tester}|C" ]
}

@test "review command does not inherit provider or application secrets" {
  run env \
    ANTHROPIC_API_KEY="do-not-forward" \
    DATABASE_URL="do-not-forward" \
    RAILWAY_TOKEN="do-not-forward" \
    RANDOM_PRIVATE_SECRET="do-not-forward" \
    "$WRAPPER" sh -c '
      test -z "${ANTHROPIC_API_KEY+x}"
      test -z "${DATABASE_URL+x}"
      test -z "${RAILWAY_TOKEN+x}"
      test -z "${RANDOM_PRIVATE_SECRET+x}"
    '

  [ "$status" -eq 0 ]
}

@test "review command preserves arguments exactly" {
  run "$WRAPPER" printf '%s\n' 'argument with spaces'

  [ "$status" -eq 0 ]
  [ "$output" = "argument with spaces" ]
}

@test "wrapper fails closed when no command is supplied" {
  run "$WRAPPER"

  [ "$status" -eq 64 ]
  [[ "$output" == usage:* ]]
}
