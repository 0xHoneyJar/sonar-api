#!/usr/bin/env bash
# Mission 1 — sample Envio chain_metadata via psql (preferred when DATABASE_URL is available).
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL to the active Belt PostgreSQL URL}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-10}"
SAMPLES="${SAMPLES:-180}"

if ! psql "$DATABASE_URL" -X -Atqc "SELECT to_regclass('public.chain_metadata') IS NOT NULL" | grep -qx t; then
  echo "chain_metadata unavailable in this database." >&2
  exit 2
fi

query=$(cat <<'SQL'
SELECT json_build_object(
  'observed_at', clock_timestamp(),
  'stats_reset', (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()),
  'chain_id', chain_id,
  'start_block', start_block,
  'head', block_height,
  'processed', latest_processed_block,
  'fetched', latest_fetched_block_number,
  'events', num_events_processed,
  'hypersync', is_hyper_sync,
  'caught_up', timestamp_caught_up_to_head_or_endblock
)::text
FROM chain_metadata
ORDER BY chain_id;
SQL
)

for ((i=0; i<SAMPLES; i++)); do
  psql "$DATABASE_URL" -X -Atq -v ON_ERROR_STOP=1 -c "$query"
  sleep "$INTERVAL_SECONDS"
done
