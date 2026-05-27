#!/usr/bin/env bash
# T-A0.5 verification — Hasura replace_metadata atomic swap public → ponder
#
# Steps:
#   1. Bootstrap two schemas (public + ponder) with the same table shape
#   2. Seed each with a marker row
#   3. Track public.token in Hasura
#   4. Snapshot metadata
#   5. jq-transform schema "public" → "ponder"
#   6. replace_metadata atomic swap
#   7. Verify GraphQL queries return the ponder marker
#   8. Roll back to public via the same mechanism
set -euo pipefail

HASURA_URL="${HASURA_URL:-http://localhost:8085}"
HASURA_ADMIN_SECRET="${HASURA_ADMIN_SECRET:-spike_admin_secret}"
PG_CONN="${PG_CONN:-postgresql://ponder:ponder@127.0.0.1:5444/ponder}"

echo "[T-A0.5] === bootstrap schemas =================="
psql_cmd() {
  docker exec -i spike-ponder-a0-postgres psql -U ponder -d ponder -v ON_ERROR_STOP=1 "$@"
}

psql_cmd <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
DROP SCHEMA IF EXISTS ponder CASCADE;
CREATE SCHEMA public;
CREATE SCHEMA ponder;

CREATE TABLE public.token (
  id text PRIMARY KEY,
  owner text NOT NULL,
  source text NOT NULL
);

CREATE TABLE ponder.token (
  id text PRIMARY KEY,
  owner text NOT NULL,
  source text NOT NULL
);

INSERT INTO public.token (id, owner, source) VALUES ('t1', '0xenvio', 'public');
INSERT INTO ponder.token (id, owner, source) VALUES ('t1', '0xponder', 'ponder');
SQL

echo "[T-A0.5] === clear Hasura metadata =========="
# Idempotency: ensure clean slate so re-runs work
curl -fSs -X POST "${HASURA_URL}/v1/metadata" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"type":"clear_metadata","args":{}}' >/dev/null

echo "[T-A0.5] === connect Hasura to the postgres ===="
# Hasura needs a source pointing at the same DB. Use 'default' source name.
curl -fSs -X POST "${HASURA_URL}/v1/metadata" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "pg_add_source",
    "args": {
      "name": "default",
      "configuration": {
        "connection_info": {
          "database_url": "postgres://ponder:ponder@postgres:5432/ponder",
          "isolation_level": "read-committed",
          "use_prepared_statements": false
        }
      },
      "replace_configuration": true
    }
  }' >/dev/null

echo "[T-A0.5] === track public.token ================"
curl -fSs -X POST "${HASURA_URL}/v1/metadata" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "pg_track_table",
    "args": { "source": "default", "table": { "schema": "public", "name": "token" } }
  }' >/dev/null

# Permission for anonymous role so the smoke query works
curl -fSs -X POST "${HASURA_URL}/v1/metadata" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "pg_create_select_permission",
    "args": {
      "source": "default",
      "table": { "schema": "public", "name": "token" },
      "role": "anonymous",
      "permission": { "columns": ["id","owner","source"], "filter": {} }
    }
  }' >/dev/null

echo "[T-A0.5] === query BEFORE cutover ==============="
BEFORE=$(curl -fSs -X POST "${HASURA_URL}/v1/graphql" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ token(where: {id: {_eq: \"t1\"}}) { source owner } }"}')
echo "[T-A0.5] BEFORE: ${BEFORE}"
if ! echo "${BEFORE}" | grep -q '"source":"public"'; then
  echo "[T-A0.5] EXPECTED source=public BEFORE cutover, got: ${BEFORE}" >&2
  exit 1
fi

echo "[T-A0.5] === snapshot metadata =================="
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
SNAPSHOT="/tmp/hasura-meta-${TIMESTAMP}.json"
curl -fSs -X POST "${HASURA_URL}/v1/metadata" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"type":"export_metadata","args":{}}' > "${SNAPSHOT}"
wc -c "${SNAPSHOT}"

echo "[T-A0.5] === jq-transform public → ponder ======="
TRANSFORMED="/tmp/hasura-meta-${TIMESTAMP}-ponder.json"
jq '(.. | objects | select((.schema // null) == "public")) |= (.schema = "ponder")' \
  "${SNAPSHOT}" > "${TRANSFORMED}"

echo "[T-A0.5] === replace_metadata (atomic swap) ===="
PAYLOAD=$(jq -c '{type:"replace_metadata",args:.}' "${TRANSFORMED}")
curl -fSs -X POST "${HASURA_URL}/v1/metadata" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}" >/dev/null

echo "[T-A0.5] === query AFTER cutover ==============="
# IMPORTANT FINDING: Hasura prefixes non-`public` schemas in the GraphQL root
# field name by default. `ponder.token` exposes as `ponder_token`, not `token`.
# This BREAKS query-shape compatibility for consumers unless explicitly
# remapped via custom_root_fields per table. Test both forms; document the
# fix path in the COOKBOOK.
AFTER_PREFIXED=$(curl -fSs -X POST "${HASURA_URL}/v1/graphql" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ ponder_token(where: {id: {_eq: \"t1\"}}) { source owner } }"}')
echo "[T-A0.5] AFTER (prefixed): ${AFTER_PREFIXED}"
if ! echo "${AFTER_PREFIXED}" | grep -q '"source":"ponder"'; then
  echo "[T-A0.5] EXPECTED source=ponder for prefixed query, got: ${AFTER_PREFIXED}" >&2
  exit 1
fi

echo "[T-A0.5] === apply custom_root_fields to drop prefix =="
# This is what cutover-hasura-tracking.sh MUST do in production: per-table
# customization that re-aliases `ponder_token` → `token`.
curl -fSs -X POST "${HASURA_URL}/v1/metadata" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "pg_set_table_customization",
    "args": {
      "source": "default",
      "table": { "schema": "ponder", "name": "token" },
      "configuration": {
        "custom_root_fields": {
          "select": "token",
          "select_by_pk": "token_by_pk",
          "select_aggregate": "token_aggregate"
        },
        "custom_name": "token"
      }
    }
  }' >/dev/null

AFTER_REMAPPED=$(curl -fSs -X POST "${HASURA_URL}/v1/graphql" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ token(where: {id: {_eq: \"t1\"}}) { source owner } }"}')
echo "[T-A0.5] AFTER (remapped): ${AFTER_REMAPPED}"
if ! echo "${AFTER_REMAPPED}" | grep -q '"source":"ponder"'; then
  echo "[T-A0.5] EXPECTED source=ponder for remapped query, got: ${AFTER_REMAPPED}" >&2
  exit 1
fi

echo "[T-A0.5] === rollback (ponder → public) ========"
ROLLED="/tmp/hasura-meta-${TIMESTAMP}-rollback.json"
jq '(.. | objects | select((.schema // null) == "ponder")) |= (.schema = "public")' \
  "${TRANSFORMED}" > "${ROLLED}"
PAYLOAD=$(jq -c '{type:"replace_metadata",args:.}' "${ROLLED}")
curl -fSs -X POST "${HASURA_URL}/v1/metadata" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}" >/dev/null

POST_ROLLBACK=$(curl -fSs -X POST "${HASURA_URL}/v1/graphql" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ token(where: {id: {_eq: \"t1\"}}) { source owner } }"}')
echo "[T-A0.5] POST-RB: ${POST_ROLLBACK}"
if ! echo "${POST_ROLLBACK}" | grep -q '"source":"public"'; then
  echo "[T-A0.5] EXPECTED source=public after rollback, got: ${POST_ROLLBACK}" >&2
  exit 1
fi

echo "[T-A0.5] PASS — cutover + rollback atomic swap works via replace_metadata"
echo "[T-A0.5] NOTE on subscription continuity: this script does not exercise"
echo "[T-A0.5]   websocket subscriptions. Hasura v2.43.0 documents that"
echo "[T-A0.5]   replace_metadata drops existing subscriptions; clients MUST"
echo "[T-A0.5]   reconnect. See T-A3.11 consumer reconnect drill."
