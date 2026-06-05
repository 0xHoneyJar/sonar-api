# Cron Refresh Configuration — `mv_holder_1155`

**Sprint**: spiral-pertoken-projection-1 · Task T5
**SDD ref**: §3.4 (Refresh Mechanism)

## Overview

`mv_holder_1155` must be refreshed at ≤ 5-minute intervals to maintain freshness (FR-07).
The refresh driver is `scripts/refresh-mv-1155.sh`.

**The operator deploys this configuration. The agent does not execute it.**

---

## Railway Cron Service Setup

### Service name

```
mv-refresh-cron
```

### Schedule

```
*/5 * * * *
```
(Every 5 minutes, UTC)

### Required environment variable

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Postgres connection string to the belt DB (same as the indexer) |

The refresh script uses no other external dependencies — no Hasura, no NATS, no npm.

### Command

```bash
scripts/refresh-mv-1155.sh
```

Or with an explicit timeout guard (recommended as belt-and-suspenders even though
the script wraps internally with `timeout 360`):

```bash
timeout 380 scripts/refresh-mv-1155.sh
```

### Docker entrypoint (if running in existing belt container)

```dockerfile
CMD ["bash", "-c", "while true; do scripts/refresh-mv-1155.sh; sleep 300; done"]
```

---

## Failure Behavior

| Scenario | Script exit | MV state | Recovery |
|----------|------------|---------|---------|
| I2 pre-check finds negative balances | 1 | Prior state (unchanged) | Investigate action ledger; cron retries next interval |
| Postgres unavailable | 1 | Prior state (unchanged) | Cron retries next interval |
| REFRESH timeout (> 360s) | 124 | Prior state (unchanged) | Investigate `idx_action_type_collection_numeric2`; raise `REFRESH_TIMEOUT_SECONDS` if action table has grown |
| REFRESH succeeds | 0 | Updated | Audit log entry written to `.run/audit.jsonl` |

A failed refresh leaves the MV readable — consumers continue to read the last clean snapshot.
Repeated failures surface via Railway service health monitoring.

---

## Staleness Detection

After a successful migration, the runtime health check function exposes staleness indirectly.
If new mint/burn events have not been folded in, the I1 check may report a non-zero delta:

```sql
SELECT * FROM fn_1155_invariant_check('puru_apiculture', 8453);
```

If `I1_mint_burn_supply` status = `FAIL`, the MV is either stale or the action ledger has
a conservation error. Investigate by comparing the action-table event timestamp with the
last refresh time.

---

## Audit Log

Every refresh attempt writes a JSON line to `.run/audit.jsonl`:

```json
{"ts":"2026-06-04T12:00:00Z","primitive":"refresh-mv-1155","outcome":"success","row_count":89123,"elapsed_seconds":42,"detail":"pre_count=89100 post_count=89123 elapsed=42s"}
```

Possible `outcome` values: `success`, `i2_violation_skipped`, `error`, `timeout`.

---

## First Operator Refresh After Migration

After applying `migrations/add-mv-holder-1155.sql`, run the first refresh manually
to confirm AC-04 (< 5 minutes):

```bash
time DATABASE_URL="$DATABASE_URL" scripts/refresh-mv-1155.sh
```

Record the elapsed time in `grimoires/loa/a2a/sprint-pertoken-1/pre-deploy-audit.md`
under a new "Phase 3 refresh timing" section.
