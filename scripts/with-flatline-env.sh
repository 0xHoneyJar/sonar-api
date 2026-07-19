#!/usr/bin/env bash
# Run a Flatline review command with an explicit, path-only environment.
# Subscription CLIs recover their auth state from HOME/CODEX_HOME rather than
# inheriting provider keys or application/database credentials.

set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 64
fi

allowlist=()

copy_if_set() {
  local name="$1"
  if [[ -n "${!name:-}" ]]; then
    allowlist+=("${name}=${!name}")
  fi
}

# Process and locale basics.
for name in HOME PATH TMPDIR USER LOGNAME SHELL LANG LC_ALL TERM COLORTERM; do
  copy_if_set "$name"
done

# Configuration/cache locations and certificate paths. These variables carry
# locations, not credential values.
for name in XDG_CONFIG_HOME XDG_CACHE_HOME CODEX_HOME CLAUDE_CONFIG_DIR \
  SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS; do
  copy_if_set "$name"
done

# Output behavior only.
for name in NO_COLOR FORCE_COLOR; do
  copy_if_set "$name"
done

exec env -i "${allowlist[@]}" "$@"
