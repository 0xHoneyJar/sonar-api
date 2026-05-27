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
#   STAGING_DB_URL=postgresql://user:pass@host:port/db \
#     scripts/cutover-hasura-tracking.sh cutover
#
#   HASURA_URL=https://belt-hasura.up.railway.app \
#   HASURA_ADMIN_SECRET=*** \
#     scripts/cutover-hasura-tracking.sh rollback
#
# Dependencies: bash >=4, curl, jq (>= 1.6). NO sed/awk — payload
# transformation is jq-based per IMP-001 + cookbook §C-6.
#
# Cutover additionally requires `psql` OR `docker` (postgres:16 image) on PATH
# to derive the belt-scope allowlist from `ponder.*`. Set STAGING_DB_URL to a
# publicly-reachable Postgres URL.
#
# A-3.5 patch (4 defects caught by live A-3 dry-run, 2026-05-27):
#  1. v3 metadata + v1 API mismatch — Hasura v2.40+ exports `version: 3`; the
#     v1 `replace_metadata` form errored "expected 1 or 2, encountered 3".
#     Fix: emit v2 form `{type, version:2, args:{allow_inconsistent_metadata, metadata}}`.
#  2. snake_case root fields (already fixed in PR #44 / 91d47bd) — kept; composes
#     with defect 3 since pascal_to_snake feeds snake_to_pascal cleanly.
#  3. PascalCase Postgres table names — envio metadata has `table.name = "MintEvent"`
#     (envio uses PascalCase Postgres tables). Ponder's tables are snake_case
#     (`ponder.mint_event`). Cutover must flip table.name to snake_case while
#     preserving the original PascalCase for `custom_root_fields.{select, …}`
#     (consumer queries use `{ MintEvent { … } }`). Symmetric for rollback.
#  4. No belt-scope filter — envio tracks 94 tables across ALL belts; A-2 only
#     ported the Mibera-belt 40-table subset to ponder.*. Flipping all 94 caused
#     ~54 inconsistencies. Fix: query information_schema.tables WHERE
#     table_schema='ponder' against STAGING_DB_URL and filter the metadata to
#     only the tables that actually exist in ponder.* (option A — most rigorous,
#     keeps script self-contained, single new psql call).

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

# Cutover (only) needs DB access to derive the belt-scope allowlist (defect 4).
# Prefer `psql` if present; fall back to `docker run --rm postgres:16 psql`.
PSQL_RUNNER=""
if [[ "${DIRECTION}" == "cutover" ]]; then
  : "${STAGING_DB_URL:?Set STAGING_DB_URL (publicly-reachable Postgres URL with ponder.* schema) for cutover. Required for belt-scope allowlist (defect 4 fix).}"
  if command -v psql >/dev/null 2>&1; then
    PSQL_RUNNER="psql"
  elif command -v docker >/dev/null 2>&1; then
    PSQL_RUNNER="docker run --rm -i postgres:16 psql"
  else
    echo "[cutover] missing dependency: need either psql OR docker (postgres:16) to read ponder.* allowlist" >&2
    exit 2
  fi
fi

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
SNAPSHOT_PATH="/tmp/hasura-metadata-${TIMESTAMP}.json"
TRANSFORMED_PATH="/tmp/hasura-metadata-${TIMESTAMP}-transformed.json"
PONDER_TABLES_PATH="/tmp/ponder-tables-${TIMESTAMP}.txt"

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
#
# jq defs (used by both directions):
#   snake_to_pascal — "mint_event" → "MintEvent". Existing def from PR #44.
#     The explicit parens around `(.[0:1] | ascii_upcase)` matter — without them
#     jq parses `[.[0:1] | ascii_upcase, .[1:]]` as `[.[0:1] | (ascii_upcase, .[1:])]`
#     and the slice `.[1:]` gets applied to the single uppercased char (empty).
#   pascal_to_snake — "MintEvent" → "mint_event". NEW (A-3.5 defect 3 fix).
#     Splits on lookahead-for-uppercase, drops empty leading segment, lowercases
#     each, joins with `_`. Composes with snake_to_pascal via round-trip
#     (verified smoke test: MintEvent → mint_event → MintEvent).
if [[ "${DIRECTION}" == "cutover" ]]; then
  echo "[cutover] transforming metadata: schema public → ponder + custom_root_fields bake + table-name PascalCase → snake_case"

  # Derive belt-scope allowlist from ponder.* (defect 4 fix). Strip Ponder's
  # internal `_reorg__*` mirror tables; we only want the user-facing tables that
  # A-2 ported. Materialize as JSON array for jq --argjson consumption.
  echo "[cutover] reading ponder.* allowlist from STAGING_DB_URL"
  ${PSQL_RUNNER} "${STAGING_DB_URL}" -tA \
    -c "SELECT table_name FROM information_schema.tables WHERE table_schema='ponder' AND table_name NOT LIKE '\_%' ESCAPE '\' ORDER BY table_name;" \
    > "${PONDER_TABLES_PATH}"

  PONDER_TABLES_COUNT=$(grep -c . "${PONDER_TABLES_PATH}" || true)
  if [[ "${PONDER_TABLES_COUNT}" -lt 1 ]]; then
    echo "[cutover] FAILED — no user tables found in ponder.* schema. Did A-1/A-2 bootstrap complete?" >&2
    exit 5
  fi
  echo "[cutover] ponder.* allowlist: ${PONDER_TABLES_COUNT} user tables"

  PONDER_TABLES_JSON=$(jq -R . "${PONDER_TABLES_PATH}" | jq -s 'map(select(length > 0))')

  jq --argjson ponder "${PONDER_TABLES_JSON}" '
    def snake_to_pascal:
      split("_") | map([(.[0:1] | ascii_upcase), .[1:]] | add) | join("");
    def pascal_to_snake:
      [splits("(?=[A-Z])") | select(length > 0) | ascii_downcase] | join("_");

    # Belt-scope filter (defect 4): keep only tables whose snake_case form
    # exists in ponder.*. Drops the ~54 out-of-belt envio tables (apdao_*,
    # candies_trade, chain_metadata, HoneyJar_*, …) that A-2 did not port.
    .sources |= map(
      .tables |= map(select(
        (.table.name | pascal_to_snake) as $snake
        | $ponder | index($snake)
      ))
    )
    # Schema flip + table.name PascalCase → snake_case (defect 3) + bake
    # custom_root_fields (PR #44 / defect 2) using the ORIGINAL PascalCase
    # because consumer queries use `{ MintEvent { … } }`.
    | (.. | objects | select((.schema // null) == "public")) |= (.schema = "ponder")
    | (.. | objects | select(.table? | (.schema // null) == "ponder" and (.name // null) != null))
      |= (
        .table.name as $original_pascal
        | .table.name = ($original_pascal | pascal_to_snake)
        | .configuration = (
            (.configuration // {}) + {
              custom_root_fields: (
                ((.configuration // {}).custom_root_fields // {}) + {
                  select: $original_pascal,
                  select_by_pk: ($original_pascal + "_by_pk"),
                  select_aggregate: ($original_pascal + "_aggregate"),
                  insert: ("insert_" + $original_pascal),
                  insert_one: ("insert_" + $original_pascal + "_one"),
                  update: ("update_" + $original_pascal),
                  update_by_pk: ("update_" + $original_pascal + "_by_pk"),
                  delete: ("delete_" + $original_pascal),
                  delete_by_pk: ("delete_" + $original_pascal + "_by_pk")
                }
              ),
              custom_name: $original_pascal
            }
          )
      )
  ' "${SNAPSHOT_PATH}" > "${TRANSFORMED_PATH}"
else
  # Rollback: schema ponder → public + strip customization we added on cutover
  # + table.name snake_case → PascalCase (inverse of defect 3 fix). The public
  # schema's tables are PascalCase (envio convention), so the rollback must
  # restore that shape.
  echo "[cutover] transforming metadata: schema ponder → public + strip custom_root_fields + table-name snake_case → PascalCase"
  jq '
    def snake_to_pascal:
      split("_") | map([(.[0:1] | ascii_upcase), .[1:]] | add) | join("");

    (.. | objects | select((.schema // null) == "ponder")) |= (.schema = "public")
    | (.. | objects | select(.table? | (.schema // null) == "public" and (.name // null) != null))
      |= (
        .table.name |= snake_to_pascal
        | (
            if (.configuration // {}) | has("custom_root_fields")
            then .configuration |= (del(.custom_root_fields) | del(.custom_name))
            else .
            end
          )
      )
  ' "${SNAPSHOT_PATH}" > "${TRANSFORMED_PATH}"
fi

echo "[cutover] transform WRITTEN (size=$(wc -c < "${TRANSFORMED_PATH}") bytes)"

# ─── 3. Atomic apply via replace_metadata (single Hasura transaction) ───
# Atomically applies BOTH the schema swap AND the root-field remap — no
# window where consumers see prefixed `ponder_token` names (cookbook §C-6).
#
# Defect 1 fix (A-3.5): Hasura v2.40+ exports metadata at `version: 3`. The
# legacy v1 `replace_metadata` form (`{type, args: <metadata-document>}`)
# rejects it with `expected 1 or 2, encountered 3`. Use the v2 form:
#   {type: "replace_metadata", version: 2, args: {allow_inconsistent_metadata, metadata}}
# `allow_inconsistent_metadata: false` keeps the original invariant — we want
# the cutover to FAIL LOUDLY if any belt-scope filter slip leaves dangling
# references rather than silently land in an inconsistent state.
echo "[cutover] applying replace_metadata via ${HASURA_URL}/v1/metadata (v2 envelope)"

APPLY_RESPONSE=$(
  curl -fSs -X POST "${HASURA_URL}/v1/metadata" \
    -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
    -H "Content-Type: application/json" \
    -d "$(jq -c '{type: "replace_metadata", version: 2, args: {allow_inconsistent_metadata: false, metadata: .}}' "${TRANSFORMED_PATH}")"
)

# Hasura v2 envelope returns {"is_consistent": true, "inconsistent_objects": []}
# on OK; on failure returns {"code", "error", "path"} OR a 4xx/5xx (curl -fSs
# would already exit). The v1 `message: success` shape no longer applies.
APPLY_CONSISTENT=$(echo "${APPLY_RESPONSE}" | jq -r '.is_consistent // false')
APPLY_ERROR=$(echo "${APPLY_RESPONSE}" | jq -r '.error // empty')
APPLY_INCONSISTENT_COUNT=$(echo "${APPLY_RESPONSE}" | jq -r '(.inconsistent_objects // []) | length')

if [[ -n "${APPLY_ERROR}" ]]; then
  echo "[cutover] replace_metadata FAILED: ${APPLY_RESPONSE}" >&2
  exit 3
fi

if [[ "${APPLY_CONSISTENT}" != "true" ]]; then
  echo "[cutover] replace_metadata returned inconsistent state (${APPLY_INCONSISTENT_COUNT} objects):" >&2
  echo "${APPLY_RESPONSE}" | jq '.inconsistent_objects' >&2
  exit 3
fi

echo "[cutover] replace_metadata APPLIED: is_consistent=true inconsistent_objects=${APPLY_INCONSISTENT_COUNT}"

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
