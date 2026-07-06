# SQD Live-Tail Lane — Rollout Runbook

Cycle: svm-sqd-substrate · spiral-001 · T-9

---

## §1 Activation

1. Merge `feat/svm-sqd-substrate` branch to main.
2. Verify `SQD_LIVE_TAIL_ENABLED` is unset or `true` in the deployment environment (default: enabled).
3. Confirm no `SQD_API_KEY` is set — the SQD lane is unauthenticated by design (NFR-1).
4. Deploy. The lane activates automatically on next collection scan.
5. Monitor the first 30 minutes via `[sqd-loader]` log lines for `eventsUpserted`, `rejectedRows`, and `ambiguousGroups`.

---

## §2 Content Audit

Run immediately after the first successful SQD lane pass:

```bash
# Compare event count between SQD and Helius for the same collection
psql $DATABASE_URL -c "
  SELECT source, count(*) as events
  FROM svm.collection_event
  WHERE collection_key = 'pythians'
  GROUP BY source
  ORDER BY source;
"
```

Expected: `sqd-stream` rows appear alongside existing `helius-backfill`/`helius-webhook` rows.
Verify: `ON CONFLICT DO NOTHING` means no existing Helius rows were overwritten (check `source` on a known PK).

---

## §3 Kill Switch

To disable the SQD live-tail lane without code deploy:

```bash
# Disable immediately (environment variable; takes effect on next call to runSqdLoader)
export SQD_LIVE_TAIL_ENABLED=false

# Verify kill switch is active:
# Logs will show: [SQD] Live-tail disabled via SQD_LIVE_TAIL_ENABLED=false
```

The kill switch is checked at the start of `runSqdLoader` — no streaming is initiated.
The Helius lane continues unaffected; there is no shared state between the two lanes.

---

## §4 Recovery

### Stream stall (SqdLivenessError)

```
[SQD STALL] No blocks received for Ns — reconnecting
[SQD HALT] Liveness check failed after 5 reconnects — manual intervention required
```

1. Check SQD Portal status: `curl -s https://portal.sqd.dev/datasets/solana-mainnet/finalized-stream/height`
2. If portal is down, set `SQD_LIVE_TAIL_ENABLED=false` until portal recovers.
3. Once portal recovers, unset the kill switch and restart the process.
4. SQD events for the down period will not be backfilled automatically — run `sqd-loader.ts --from-slot <gap_start>` if gap coverage is needed.

### Chain lag warning

```
[SQD LAG] NNN slots behind chain tip
```

1. This is advisory — the lane continues streaming.
2. If lag exceeds 5000 slots and persists, check the SQD Portal feed health.
3. The independent reference RPC is `SQD_REFERENCE_RPC_URL` (default: mainnet-beta.solana.com).

### Gap detection

```
[SQD GAP] blocks NNN-MMM skipped
```

1. SQD Portal may deliver blocks in valid batches — a small gap (< 100 blocks) is advisory.
2. Persistent large gaps indicate a stream restart occurred mid-batch; check SQD Portal.

---

## §5 Alerting Requirements

Wire the following log patterns to your alerting system (Datadog/Grafana/etc.):

| Pattern | Severity | Action |
|---------|----------|--------|
| `[SQD HALT]` | CRITICAL | Page on-call — SQD lane is halted |
| `[SQD STALL]` × 3 in 10m | WARNING | Notify team — stream stalling |
| `[SQD LAG]` × 5 in 10m | WARNING | Notify team — chain lag |
| `[SQD MALFORMED]` | ERROR | Notify team — possible protocol change |
| `[SQD GAP]` > 1000 blocks | WARNING | Notify team — large block gap |

Critical alert: `SqdLivenessError` thrown = manual intervention required (kill switch active until resolved).

---

## §6 Helius Retirement

The SQD lane does NOT replace the Helius lane immediately. Retirement is a separate decision gate:

**Pre-conditions for Helius retirement:**
- [ ] §4.5 gate passes with the 30,006-event fixture (`match_rate >= 0.99`, `divergence_count == 0`)
- [ ] SQD lane has run continuously for ≥ 30 days without a KF-018-class silent outage
- [ ] `[SQD MALFORMED]` rate < 0.1% over the 30-day window
- [ ] Liveness monitor alerting is wired up and tested (§5)
- [ ] On-call runbook has been reviewed by the team

**Do NOT retire Helius** until all pre-conditions are met. The two lanes are designed to coexist via `ON CONFLICT DO NOTHING` (first-writer-wins).
