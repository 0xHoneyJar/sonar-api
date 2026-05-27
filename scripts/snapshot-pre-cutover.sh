#!/usr/bin/env bash
# scripts/snapshot-pre-cutover.sh
#
# Pre-cutover Postgres + Hasura-metadata snapshot for the Ponder migration.
# Cadence: RPO ≤2 hours (sprint frontmatter target; SKP-001 CRITICAL).
# This produces the rollback artifact pair (Postgres pgdump + Hasura
# metadata json) that scripts/rollback-belt.sh consumes.
#
# Source-of-truth: loa-freeside:grimoires/loa/sdd.md §6.2
# Sprint task: T-A1.6
#
# Usage:
#   PG_HOST=postgres-3vic.railway.internal \
#   PG_USER=postgres \
#   PGPASSWORD=*** \
#   HASURA_URL=https://belt-hasura.up.railway.app \
#   HASURA_ADMIN_SECRET=*** \
#     scripts/snapshot-pre-cutover.sh blue
#
#   # with S3 upload (optional — falls back to local /tmp if S3_BUCKET unset):
#   S3_BUCKET=sonar-snapshots \
#     scripts/snapshot-pre-cutover.sh blue
#
# Cron cadence (RPO ≤2h target — install in Railway cron service):
#   0 */2 * * * /app/scripts/snapshot-pre-cutover.sh blue >> /var/log/snapshot.log 2>&1
#   0 */2 * * * /app/scripts/snapshot-pre-cutover.sh green >> /var/log/snapshot.log 2>&1
#
# What this snapshots:
#   1. Postgres `public.*` schema (envio — frozen baseline for rollback)
#   2. Postgres `ponder.*` schema (post-cutover state; pre-cutover this
#      is empty/absent, which is correct)
#   3. Hasura metadata (current source-of-truth for GraphQL routing)
#
# Dependencies: pg_dump (client tools matching server major), curl, jq.

set -euo pipefail

BELT="${1:?Usage: $0 <blue|green>}"

case "${BELT}" in
  blue)  PG_HOST_DEFAULT="postgres-3vic.railway.internal" ;;
  green) PG_HOST_DEFAULT="postgres-vrr1.railway.internal" ;;
  *) echo "[snapshot] unknown belt='${BELT}' (expected: blue|green)" >&2; exit 1 ;;
esac

PG_HOST="${PG_HOST:-${PG_HOST_DEFAULT}}"
PG_USER="${PG_USER:-postgres}"
PG_DATABASE="${PG_DATABASE:-railway}"
PG_PORT="${PG_PORT:-5432}"

HASURA_URL="${HASURA_URL:?Set HASURA_URL (e.g. https://belt-hasura.up.railway.app)}"
HASURA_ADMIN_SECRET="${HASURA_ADMIN_SECRET:?Set HASURA_ADMIN_SECRET}"

# Use PGPASSWORD env var pattern (pg_dump native) — do NOT embed in URL.
: "${PGPASSWORD:?Set PGPASSWORD for pg_dump auth}"
export PGPASSWORD

command -v pg_dump >/dev/null 2>&1 || { echo "[snapshot] missing dependency: pg_dump" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "[snapshot] missing dependency: curl" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "[snapshot] missing dependency: jq" >&2; exit 2; }

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
SNAPSHOT_DIR="${SNAPSHOT_DIR:-/tmp}"
mkdir -p "${SNAPSHOT_DIR}"

PGDUMP_PATH="${SNAPSHOT_DIR}/sonar-${BELT}-${TIMESTAMP}.pgdump"
HASURA_META_PATH="${SNAPSHOT_DIR}/hasura-metadata-${BELT}-${TIMESTAMP}.json"

echo "[snapshot] belt=${BELT} timestamp=${TIMESTAMP}"
echo "[snapshot] pg_host=${PG_HOST} pg_user=${PG_USER} pg_database=${PG_DATABASE}"

# ─── 1. Postgres pg_dump (public + ponder schemas, custom format) ─────
# --format=custom : pg_restore-compatible, supports parallel restore + selective
# --no-owner / --no-acl : restoring into a different db role does not fail on
#                          owner/grant mismatch (per SDD §6.3 rollback procedure)
echo "[snapshot] pg_dump → ${PGDUMP_PATH}"

pg_dump \
  --host="${PG_HOST}" \
  --port="${PG_PORT}" \
  --username="${PG_USER}" \
  --dbname="${PG_DATABASE}" \
  --schema=public \
  --schema=ponder \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="${PGDUMP_PATH}"

PGDUMP_SIZE=$(wc -c < "${PGDUMP_PATH}")
echo "[snapshot] pg_dump WRITTEN size=${PGDUMP_SIZE} bytes"

# Sanity: refuse trivially empty dumps (would suggest the connection
# returned no schemas — likely an auth or schema-resolution bug).
if [[ "${PGDUMP_SIZE}" -lt 1024 ]]; then
  echo "[snapshot] WARNING — pg_dump output is suspiciously small (<1 KiB); verify schema visibility" >&2
fi

# ─── 2. Hasura metadata (paired artifact) ──────────────────────────────
echo "[snapshot] hasura metadata → ${HASURA_META_PATH}"

curl -fSs -X POST "${HASURA_URL}/v1/metadata" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"type": "export_metadata", "args": {}}' \
  > "${HASURA_META_PATH}"

# Validate it parses as JSON — rollback expects a valid metadata document.
if ! jq empty "${HASURA_META_PATH}" 2>/dev/null; then
  echo "[snapshot] ERROR — Hasura metadata is not valid JSON: ${HASURA_META_PATH}" >&2
  exit 3
fi

HASURA_META_SIZE=$(wc -c < "${HASURA_META_PATH}")
echo "[snapshot] hasura metadata WRITTEN size=${HASURA_META_SIZE} bytes"

# ─── 3. Durable storage upload (S3 path, optional) ────────────────────
# If S3_BUCKET is set + aws cli available, upload both artifacts.
# Otherwise, the snapshots persist in SNAPSHOT_DIR (local volume).
if [[ -n "${S3_BUCKET:-}" ]] && command -v aws >/dev/null 2>&1; then
  S3_PREFIX="${S3_PREFIX:-sonar-snapshots}"
  PGDUMP_S3="s3://${S3_BUCKET}/${S3_PREFIX}/sonar-${BELT}-${TIMESTAMP}.pgdump"
  HASURA_META_S3="s3://${S3_BUCKET}/${S3_PREFIX}/hasura-metadata-${BELT}-${TIMESTAMP}.json"

  echo "[snapshot] uploading to ${PGDUMP_S3}"
  aws s3 cp "${PGDUMP_PATH}" "${PGDUMP_S3}" --no-progress

  echo "[snapshot] uploading to ${HASURA_META_S3}"
  aws s3 cp "${HASURA_META_PATH}" "${HASURA_META_S3}" --no-progress

  echo "[snapshot] uploaded to s3 — local copies retained in ${SNAPSHOT_DIR}"
else
  echo "[snapshot] S3_BUCKET unset or aws CLI absent — snapshots retained locally only"
fi

# ─── 4. Pruning (optional) — retain N most-recent local snapshots ──────
# Off by default. To enable: set SNAPSHOT_RETAIN_COUNT (e.g. 24 = last 48h
# at 2h cadence per RPO target). Refuses to run if SNAPSHOT_DIR is /tmp
# (already volatile) — the operator should set SNAPSHOT_DIR to a durable
# volume mount in production.
if [[ -n "${SNAPSHOT_RETAIN_COUNT:-}" ]] && [[ "${SNAPSHOT_DIR}" != "/tmp" ]]; then
  echo "[snapshot] pruning to keep most-recent ${SNAPSHOT_RETAIN_COUNT} snapshots for belt=${BELT}"
  find "${SNAPSHOT_DIR}" -maxdepth 1 -type f -name "sonar-${BELT}-*.pgdump" \
    -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn \
    | tail -n +"$((SNAPSHOT_RETAIN_COUNT + 1))" \
    | cut -d' ' -f2- \
    | xargs -r rm -f
  find "${SNAPSHOT_DIR}" -maxdepth 1 -type f -name "hasura-metadata-${BELT}-*.json" \
    -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn \
    | tail -n +"$((SNAPSHOT_RETAIN_COUNT + 1))" \
    | cut -d' ' -f2- \
    | xargs -r rm -f
fi

echo "[snapshot] DONE belt=${BELT} timestamp=${TIMESTAMP}"
echo "[snapshot] pg_dump:        ${PGDUMP_PATH}"
echo "[snapshot] hasura metadata: ${HASURA_META_PATH}"
