# A-3 Staging Dry-Run Runbook (T-A3.8)

This runbook walks the operator through the **A-3 staging dry-run**: 35 Hasura contract tests + 3 drill scripts. Run it BEFORE A-4 (production cutover). If any phase fails, escalate and reassess A-4 timing.

## Prerequisites

- Staging Postgres has the Ponder schema deployed (A-1 outputs) AND Ponder has been running long enough on staging to have populated entities (otherwise query-snapshot tests will skip empty-row assertions, masking real shape errors).
- Staging Hasura at `${HASURA_URL}` is currently tracking envio's `public.*` schema (pre-cutover state).
- The `scripts/cutover-hasura-tracking.sh` script is verified working on staging (A-1 sprint output).
- Operator has admin access to staging Hasura via `${HASURA_ADMIN_SECRET}`.

## Env var matrix

| Variable | Required for | Notes |
|----------|--------------|-------|
| `HASURA_URL` | All Hasura tests + drills | e.g. `https://belt-hasura-staging.up.railway.app` |
| `HASURA_ADMIN_SECRET` | All Hasura tests + drills | From Railway secrets |
| `STAGING_DB_URL` | reorg-drill.sh | Postgres connection string with write access to `ponder.pending_emits` |
| `HASURA_BEFORE_METADATA_PATH` | metadata-diff.test.ts | Snapshot path BEFORE cutover (`/tmp/hasura-before.json`) |
| `HASURA_AFTER_METADATA_PATH` | metadata-diff.test.ts | Snapshot path AFTER cutover (`/tmp/hasura-after.json`) |
| `ENVIO_BASELINE_PATH` | aggregates.test.ts | Optional. JSON file with envio aggregate counts for drift comparison. |
| `SCORE_ROLE_TOKEN` / `MEDIUMS_ROLE_TOKEN` / `SIETCH_ROLE_TOKEN` | permissions.test.ts (optional) | Role-impersonation JWTs. If unset, falls back to admin-secret + `x-hasura-role` impersonation. |
| `RTO_BUDGET_SECONDS` | hasura-rollback-drill.sh | Default 1800 (30 min). Per SDD §10. |
| `RECONNECT_SLA_SECONDS` | consumer-reconnect-drill.sh | Default 60. |

## Phase 1 — Pre-cutover snapshots (operator)

Capture the envio-side metadata baseline + (optionally) the aggregate baseline.

```bash
# 1.1 Capture metadata baseline (envio public.* schema).
curl -fSs -X POST "${HASURA_URL}/v1/metadata" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -d '{"type":"export_metadata","args":{}}' \
  > /tmp/hasura-before.json

# 1.2 (Optional) Snapshot a few aggregate counts for drift comparison.
cat > /tmp/envio-baseline.json <<JSON
{
  "MintEvent_aggregate": $(curl -fSs -X POST "${HASURA_URL}/v1/graphql" \
    -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
    -d '{"query":"{ MintEvent_aggregate { aggregate { count } } }"}' \
    | jq '.data.MintEvent_aggregate.aggregate.count'),
  "BgtBoostEvent_aggregate": $(curl -fSs -X POST "${HASURA_URL}/v1/graphql" \
    -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
    -d '{"query":"{ BgtBoostEvent_aggregate { aggregate { count } } }"}' \
    | jq '.data.BgtBoostEvent_aggregate.aggregate.count')
}
JSON
```

## Phase 2 — Cutover dry-run (operator)

```bash
HASURA_URL="..." HASURA_ADMIN_SECRET="..." \
  bash scripts/cutover-hasura-tracking.sh cutover
```

Expected: `[cutover] DONE — direction=cutover schema=ponder unprefixed-root-fields=OK`.

Capture post-cutover metadata:
```bash
curl -fSs -X POST "${HASURA_URL}/v1/metadata" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -d '{"type":"export_metadata","args":{}}' \
  > /tmp/hasura-after.json
```

## Phase 3 — 35-test Hasura suite (T-A3.2..7)

```bash
HASURA_URL="..." \
HASURA_ADMIN_SECRET="..." \
HASURA_BEFORE_METADATA_PATH=/tmp/hasura-before.json \
HASURA_AFTER_METADATA_PATH=/tmp/hasura-after.json \
ENVIO_BASELINE_PATH=/tmp/envio-baseline.json \
  pnpm test:hasura
```

Expected wall-clock: ~2-5 minutes (subscription tests are the long pole at 30s each × 3 = up to 90s).

Test counts:
- T-A3.2 query-snapshot: 15 tests
- T-A3.3 metadata-diff: 5 tests
- T-A3.4 permissions: 9 tests (3 roles × 3 assertions)
- T-A3.5 relationships: 3 tests
- T-A3.6 aggregates: 2 tests
- T-A3.7 subscriptions: 3 tests
- **Total: 37 tests** (the sprint AC says ~35; the metadata-diff suite has 5 distinct assertions which we count as 5 not 1).

**Abort criteria**:
- ANY query-snapshot test fails with `field 'X' not found in type: 'query_root'` → cookbook §C-6 customization didn't bake correctly. STOP. The cutover script must be re-validated.
- ANY metadata-diff test asserts permission/relationship drift → cutover dropped state. STOP.
- ANY subscription test times out at 30s → Hasura subscription path broken. STOP.

## Phase 4 — Reorg drill (T-A3.9 · SKP-002 CRITICAL)

```bash
STAGING_DB_URL="postgres://..." \
N_EVENTS=20 CHAIN_ID=1 \
  bash scripts/reorg-drill.sh > /tmp/reorg-drill.json

cat /tmp/reorg-drill.json | jq .
```

Expected: `{"idempotency_pass": true, "duplicate_count": 0, ...}`.

If `idempotency_pass: false` → **PRODUCTION BLOCKER**. The deterministic-id idempotency property does NOT hold in this environment. Do NOT proceed to A-4. Escalate per SKP-002 CRITICAL.

Optional cleanup of drill rows:
```bash
CLEANUP=1 STAGING_DB_URL="..." N_EVENTS=20 CHAIN_ID=1 \
  bash scripts/reorg-drill.sh
```

## Phase 5 — Hasura rollback drill (T-A3.10 · SKP-002 HIGH)

This drill is destructive to Hasura state (cuts over → rolls back). Run in a maintenance window OR against a staging-only Hasura.

```bash
HASURA_URL="..." HASURA_ADMIN_SECRET="..." \
  bash scripts/hasura-rollback-drill.sh > /tmp/rollback-drill.json

cat /tmp/rollback-drill.json | jq .
```

Expected: `{"pass": true, "rto_seconds": <small>, "permissions_intact": true}`.

If `pass: false` and `exit_reason: "rto-exceeded"` → escalate. Per SDD §10, RTO MUST be < 30 min for A-4 to proceed.

## Phase 6 — Consumer reconnect drill (T-A3.11 · SKP-005 HIGH)

```bash
HASURA_URL="..." HASURA_ADMIN_SECRET="..." DIRECTION=cutover \
  bash scripts/consumer-reconnect-drill.sh > /tmp/reconnect-drill.json

cat /tmp/reconnect-drill.json | jq .
```

Expected: `{"pass": true, "all_reconnected": true, "consumers": [{...reconnect_seconds: <60}, ...]}`.

Then run with `DIRECTION=rollback` to verify reverse direction.

If `pre_swap_healthy: false` → staging probably has no live data for the subscription queries; this is a soft-fail. Operator decides whether to provision test data or accept the limitation.

If any `consumers[*].resumed: false` → that consumer's WebSocket reconnect path is broken. STOP. Escalate.

## Final aggregation

Combine all 3 drill JSONs into a single status doc:

```bash
jq -s '{
  reorg_drill: .[0],
  rollback_drill: .[1],
  reconnect_drill: .[2],
  overall_pass: (.[0].idempotency_pass and .[1].pass and .[2].pass)
}' /tmp/reorg-drill.json /tmp/rollback-drill.json /tmp/reconnect-drill.json \
  > /tmp/a3-final-status.json
```

If `overall_pass: true` AND the 37-test suite green → **A-3 gate passes; A-4 is unblocked**.

## Substantive flags (must read before running)

### Flag 1 — Schema-prefix root field naming (CRITICAL load-bearing — PATCHED in this PR)

The consumer queries inventoried in `test/hasura-contract/fixtures/queries.json` use **PascalCase** entity names (`MintEvent`, `MiberaTransfer`, `BadgeHolder`). envio's Hasura exposes them at PascalCase because envio's RescriptSchema entity-name → PostgreSQL table mapping preserves case.

Ponder's `ponder.schema.ts` defines tables with **snake_case** Postgres names (`mint_event`, `mibera_transfer`, `badge_holder`). The cutover script's jq transform PREVIOUSLY baked `custom_root_fields.select = .table.name` — the **literal Postgres table name** = snake_case for Ponder — which would have broken every consumer query post-cutover.

**Patched in this PR**: `scripts/cutover-hasura-tracking.sh` now defines a `snake_to_pascal` jq helper and applies it to all 9 customization fields (`select`, `select_by_pk`, `select_aggregate`, `insert`, `insert_one`, `update`, `update_by_pk`, `delete`, `delete_by_pk`, `custom_name`). Net effect: after cutover, `{ MintEvent { ... } }` resolves correctly because `mint_event` is remapped to `MintEvent` at the Hasura customization layer. The metadata-diff test (T-A3.3) was simultaneously tightened to refuse to pass unless every tracked ponder table's `custom_root_fields` matches the PascalCase form for all 8 root fields + `custom_name` — this is the feedback loop that would have caught the original miss before staging.

Staging dry-run validates the patch end-to-end via T-A3.3 (Phase 3) and the consumer-reconnect drill (Phase 6). If T-A3.3 fails with `mismatched custom_root_fields` lines, the patch regressed — DO NOT proceed to A-4.

### Flag 2 — sietch-discord consumer queries are synthesized

5 of the 15 query fixtures (all sietch-discord) are SYNTHESIZED — sietch-discord's consumer code was not found in any local checkout. Operator MUST validate the synthesized shapes against actual sietch-discord prod query logs before A-4. The synthesized queries are flagged `"synthesized": true` in `fixtures/queries.json`.

### Flag 3 — Empty-staging false negatives

The query-snapshot tests assert shape only if rows exist. On an empty staging Hasura, the tests pass even if the shape would be wrong on real data. Operator should seed staging with a representative event sample before running Phase 3, OR re-run Phase 3 in shadow against production-mirror data.

## Escalation path

| Failure | Owner | Action |
|---------|-------|--------|
| Reorg drill `duplicate_count > 0` | sonar-ponder | SKP-002 reopens; reorg-safe-emit lib's deterministic-id logic has a bug. Block A-4. |
| Rollback drill `rto_seconds > 1800` | sonar-ponder + ops | Optimize cutover script OR raise RTO budget for A-4 (per SDD §10 — operator-confirmed adjustment). |
| Consumer reconnect drill any `resumed: false` | sonar-ponder + consumer team | Identify which consumer + their WebSocket reconnect strategy. Likely a client-side fix; block A-4 cutover until consumer ships fix. |
| Query-snapshot test fails with `field 'X' not found` | sonar-ponder | Flag 1 above (PascalCase ↔ snake_case). Patch shipped; verify `snake_to_pascal` jq def is intact in `cutover-hasura-tracking.sh` and that T-A3.3 metadata-diff asserts the PascalCase remap. |
