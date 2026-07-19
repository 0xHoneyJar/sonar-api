#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 CONFIG BENCH_SCHEMA EVIDENCE_PREFIX" >&2
  exit 64
fi

config=$1
schema=$2
prefix=$3

if [[ ! "$schema" =~ ^bench_[a-z0-9_]+$ ]]; then
  echo "unsafe benchmark schema: $schema" >&2
  exit 64
fi
if [[ -z "${BENCH_DATABASE_URL:-}" || -z "${ENVIO_API_TOKEN:-}" ]]; then
  echo "BENCH_DATABASE_URL and ENVIO_API_TOKEN are required" >&2
  exit 64
fi
for name in ENVIO_PG_HOST ENVIO_PG_PORT ENVIO_PG_USER ENVIO_PG_PASSWORD ENVIO_PG_DATABASE; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required" >&2
    exit 64
  fi
done

export ENVIO_PG_SCHEMA=$schema
export ENVIO_PG_SSL_MODE=require
export ENVIO_HASURA=false
export TUI_OFF=true
export LOG_STRATEGY=console-raw
unset ENVIO_RESTART

node scripts/profiling/bench-postgres.mjs wal > "${prefix}-wal-before.json"
before_lsn=$(jq -r .lsn "${prefix}-wal-before.json")

/usr/bin/time -lp pnpm exec envio start --config "$config" \
  > "${prefix}.log" \
  2> "${prefix}.time"

node scripts/profiling/bench-postgres.mjs wal-diff "$before_lsn" \
  > "${prefix}-wal-after.json"
node scripts/profiling/bench-postgres.mjs metrics "$schema" \
  > "${prefix}-metrics.json"
node scripts/profiling/bench-postgres.mjs progress "$schema" \
  > "${prefix}-progress.json"

jq -n \
  --arg schema "$schema" \
  --arg config "$config" \
  --slurpfile wal "${prefix}-wal-after.json" \
  --slurpfile metrics "${prefix}-metrics.json" \
  --slurpfile progress "${prefix}-progress.json" \
  '{schema: $schema, config: $config, wal: $wal[0], metrics: $metrics[0], progress: $progress[0]}'
