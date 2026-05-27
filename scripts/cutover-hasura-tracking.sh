#!/usr/bin/env bash
# scripts/cutover-hasura-tracking.sh
#
# Atomic Hasura metadata swap for the Ponder migration cutover.
# - cutover : replace_metadata flips schema "public" → "ponder" AND bakes in
#             per-table custom_root_fields so consumer queries against
#             unprefixed names (`token` not `ponder_token`) keep resolving.
# - rollback: replace_metadata flips schema "ponder" → "public" AND strips
#             the customization we added on cutover.
#
# Single transaction via Hasura's `replace_metadata`. This avoids the
# non-transactional sequential untrack/track API calls that would drop
# relationships + permissions (SDD §4.3, BLOCKER SKP-001/002 CRITICAL).
#
# Source-of-truth: loa-freeside:grimoires/loa/sdd.md §4.3
# Cookbook: loa-freeside:grimoires/loa/spikes/ponder-api-verification/COOKBOOK.md §C-6
# Sprint task: T-A1.5
#
# Usage:
#   HASURA_URL=https://belt-hasura.up.railway.app \
#   HASURA_ADMIN_SECRET=*** \
#     scripts/cutover-hasura-tracking.sh cutover
#
#   HASURA_URL=https://belt-hasura.up.railway.app \
#   HASURA_ADMIN_SECRET=*** \
#     scripts/cutover-hasura-tracking.sh rollback
#
# Dependencies: bash >=4, curl, jq (>= 1.6). NO sed/awk — payload
# transformation is jq-based per IMP-001 + cookbook §C-6.

set -euo pipefail

HASURA_URL="${HASURA_URL:?Set HASURA_URL (e.g. https://belt-hasura.up.railway.app)}"
HASURA_ADMIN_SECRET="${HASURA_ADMIN_SECRET:?Set HASURA_ADMIN_SECRET}"
DIRECTION="${1:?Usage: $0 <cutover|rollback>}"

case "${DIRECTION}" in
  cutover|rollback) ;;
  *) echo "[cutover] unknown DIRECTION='${DIRECTION}' (expected: cutover|rollback)" >&2; exit 1 ;;
esac

command -v jq >/dev/null 2>&1 || { echo "[cutover] missing dependency: jq" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "[cutover] missing dependency: curl" >&2; exit 2; }

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
SNAPSHOT_PATH="/tmp/hasura-metadata-${TIMESTAMP}.json"
TRANSFORMED_PATH="/tmp/hasura-metadata-${TIMESTAMP}-transformed.json"

# ─── 1. Export current metadata as snapshot (rollback artifact) ────────
echo "[cutover] direction=${DIRECTION} timestamp=${TIMESTAMP}"
echo "[cutover] exporting current metadata → ${SNAPSHOT_PATH}"

curl -fSs -X POST "${HASURA_URL}/v1/metadata" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"type": "export_metadata", "args": {}}' \
  > "${SNAPSHOT_PATH}"

echo "[cutover] metadata snapshot WRITTEN (size=$(wc -c < "${SNAPSHOT_PATH}") bytes)"

# ─── 2. Transform: schema swap + custom_root_fields bake (jq portable form) ───
# The portable form tolerates objects without a "schema" key (jq 1.6+ tested
# via cookbook §T-A0.5). Critical: customization is baked INTO the
# replace_metadata payload so the schema swap AND root-field remap are
# atomic — no window where consumers see prefixed `ponder_*` names (C-6).
if [[ "${DIRECTION}" == "cutover" ]]; then
  echo "[cutover] transforming metadata: schema public → ponder + custom_root_fields bake"
  # snake_to_pascal: maps Ponder's snake_case Postgres table names
  # (`mint_event`, `badge_holder`) to PascalCase GraphQL root fields
  # (`MintEvent`, `BadgeHolder`). Required because envio's consumer queries
  # use PascalCase entity names — see runbook §Flag 1 (CRITICAL load-bearing).
  # NB: explicit parens around `(.[0:1] | ascii_upcase)` matter — without them
  # jq parses `[.[0:1] | ascii_upcase, .[1:]]` as `[.[0:1] | (ascii_upcase, .[1:])]`
  # and the slice `.[1:]` gets applied to the single uppercased char (empty).
  jq '
    def snake_to_pascal:
      split("_") | map([(.[0:1] | ascii_upcase), .[1:]] | add) | join("");
    (.. | objects | select((.schema // null) == "public")) |= (.schema = "ponder")
    | (.. | objects | select(.table? | (.schema // null) == "ponder" and (.name // null) != null))
      |= (
        .configuration = (
          (.configuration // {}) + {
            custom_root_fields: (
              ((.configuration // {}).custom_root_fields // {}) + {
                select: (.table.name | snake_to_pascal),
                select_by_pk: ((.table.name | snake_to_pascal) + "_by_pk"),
                select_aggregate: ((.table.name | snake_to_pascal) + "_aggregate"),
                insert: ("insert_" + (.table.name | snake_to_pascal)),
                insert_one: ("insert_" + (.table.name | snake_to_pascal) + "_one"),
                update: ("update_" + (.table.name | snake_to_pascal)),
                update_by_pk: ("update_" + (.table.name | snake_to_pascal) + "_by_pk"),
                delete: ("delete_" + (.table.name | snake_to_pascal)),
                delete_by_pk: ("delete_" + (.table.name | snake_to_pascal) + "_by_pk")
              }
            ),
            custom_name: (.table.name | snake_to_pascal)
          }
        )
      )
  ' "${SNAPSHOT_PATH}" > "${TRANSFORMED_PATH}"
else
  # rollback: schema ponder → public + strip customization we added on cutover.
  echo "[cutover] transforming metadata: schema ponder → public + strip custom_root_fields"
  jq '
    (.. | objects | select((.schema // null) == "ponder")) |= (.schema = "public")
    | (.. | objects | select(.table? | (.schema // null) == "public" and (.name // null) != null))
      |= (
        if (.configuration // {}) | has("custom_root_fields")
        then .configuration |= (del(.custom_root_fields) | del(.custom_name))
        else .
        end
      )
  ' "${SNAPSHOT_PATH}" > "${TRANSFORMED_PATH}"
fi

echo "[cutover] transform WRITTEN (size=$(wc -c < "${TRANSFORMED_PATH}") bytes)"

# ─── 3. Atomic apply via replace_metadata (single Hasura transaction) ───
# Atomically applies BOTH the schema swap AND the root-field remap — no
# window where consumers see prefixed `ponder_token` names (cookbook §C-6).
echo "[cutover] applying replace_metadata via ${HASURA_URL}/v1/metadata"

APPLY_RESPONSE=$(
  curl -fSs -X POST "${HASURA_URL}/v1/metadata" \
    -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
    -H "Content-Type: application/json" \
    -d "$(jq -c '{type: "replace_metadata", args: .}' "${TRANSFORMED_PATH}")"
)

# Hasura returns {"message":"success"} on OK; anything else is a failure.
APPLY_MSG=$(echo "${APPLY_RESPONSE}" | jq -r '.message // .error // "unknown"')
if [[ "${APPLY_MSG}" != "success" ]]; then
  echo "[cutover] replace_metadata FAILED: ${APPLY_RESPONSE}" >&2
  exit 3
fi

echo "[cutover] replace_metadata APPLIED: ${APPLY_MSG}"

# ─── 4. Post-swap validation (per SDD §4.3 — verify root-field unprefixed) ───
EXPECTED_SCHEMA="ponder"
[[ "${DIRECTION}" == "rollback" ]] && EXPECTED_SCHEMA="public"

echo "[cutover] introspecting GraphQL root fields (expecting unprefixed names)"
INTROSPECTION=$(
  curl -fSs -X POST "${HASURA_URL}/v1/graphql" \
    -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
    -H "Content-Type: application/json" \
    -d '{"query": "{ __schema { queryType { fields { name } } } }"}'
)

# Sanity: queryType.fields[].name MUST NOT include any `ponder_*` prefixed name
# (post-cutover) or `public_*` prefixed name (defensive — public is the default
# Hasura behavior so this should never appear). Full assertion lives in
# scripts/verify-hasura-tracking.sh (out of A-1 scope; A-3 contract suite).
LEAKED=$(echo "${INTROSPECTION}" | jq -r '
  .data.__schema.queryType.fields[]
  | select(.name | test("^ponder_"; "i"))
  | .name
' | head -5)

if [[ -n "${LEAKED}" ]]; then
  echo "[cutover] WARNING — prefixed root fields detected (custom_root_fields bake may have missed tables):" >&2
  while IFS= read -r line; do
    echo "[cutover]   ${line}" >&2
  done <<< "${LEAKED}"
  echo "[cutover] DOES NOT auto-rollback; operator must verify before declaring cutover complete." >&2
  exit 4
fi

echo "[cutover] DONE — direction=${DIRECTION} schema=${EXPECTED_SCHEMA} unprefixed-root-fields=OK"
echo "[cutover] snapshot: ${SNAPSHOT_PATH}"
echo "[cutover] transform: ${TRANSFORMED_PATH}"
