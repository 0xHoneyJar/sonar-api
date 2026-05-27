# A-4 Production Cutover Runbook

**Cycle**: `sonar-ponder-migration-v1`
**Authority**: ADR-010 (operator-signed 2026-05-27, `loa-freeside/decisions/010-sonar-ponder-migration-rpo-rto-sign-off.md`)
**Execution mode**: operator-led — the agent wrote the scripts; the operator runs them in the chosen low-traffic window.
**Predecessors**: A-0..A-3 + A-3.5 + A-3.6 all merged on `origin/main` @ `bc15f46`.

> RPO target: **≤ 2h** · RTO target: **≤ 30 min** (per ADR-010; empirically Hasura rollback measured at 716ms–1.27s during A-3 staging dry-run).

## Scope

This runbook covers the **blue belt (Mibera-scope) production cutover** ONLY. The green-belt subset (HoneyJar / Crayons / ApDAO / Apiculture / Aquabera-wall / Badge1155 / BGT / Fatbera) is scoped to Sprint B-1 and is NOT in this runbook.

## Pre-flight (T-30 minutes)

Confirm BEFORE entering the cutover window.

### Operator checklist (do this first)

- [ ] Low-traffic window confirmed (no scheduled mints / on-chain events / consumer launches in the next 2h)
- [ ] On-call coverage: at least one operator awake + reachable; rollback authority understood
- [ ] Open items from ADR-010 closed:
  - [ ] sietch-discord query fixtures replaced (or formally accepted as the synthesized set)
  - [ ] Consumer reconnect drill validated against real clients (or operator accepts mock-subscriber evidence)
  - [ ] Railway alerting webhook URLs known
- [ ] Branch `feat/a-4-deploy-scripts` reviewed + merged to `main` (this runbook + the 5 scripts)
- [ ] `git checkout` the exact deploy SHA on the deploy host

### Snapshot pre-cutover state

```bash
# 1. Pre-cutover Postgres + Hasura metadata snapshot
PG_HOST=postgres-3vic.railway.internal \
PG_USER=postgres \
PGPASSWORD=*** \
HASURA_URL=https://belt-hasura.up.railway.app \
HASURA_ADMIN_SECRET=*** \
SNAPSHOT_DIR=/tmp/a-4-snapshots \
  scripts/snapshot-pre-cutover.sh blue
```

Output: `sonar-blue-<TIMESTAMP>.pgdump` + `hasura-metadata-blue-<TIMESTAMP>.json`. **Save these paths** — they are the rollback artifact pair.

### Abort-threshold check (pre-cutover)

```bash
DATABASE_URL=postgresql://... \
HASURA_URL=https://belt-hasura.up.railway.app \
HASURA_ADMIN_SECRET=*** \
CHAIN_IDS="1,10,42161,7777777,8453,80094" \
PONDER_HEAD_URL_1=https://erpc.example.com/1 \
PONDER_HEAD_URL_10=https://erpc.example.com/10 \
PONDER_HEAD_URL_42161=https://erpc.example.com/42161 \
PONDER_HEAD_URL_7777777=https://erpc.example.com/7777777 \
PONDER_HEAD_URL_8453=https://erpc.example.com/8453 \
PONDER_HEAD_URL_80094=https://erpc.example.com/80094 \
ENVIO_HEALTH_URL=https://belt-indexer.up.railway.app/healthz \
  scripts/abort-threshold-check.sh
```

Verdict must be `"verdict": "GO"`. Any check `passed: false` is an **abort** — do NOT proceed.

### Reconciliation script ready

Verify the 24h NATS reconciliation script can connect (dry-run):

```bash
NATS_URL=nats://nats.example.com:4222 \
NATS_AUTH_TOKEN=*** \
  scripts/nats-reconciliation-24h.sh --dry-run
```

### Alerting wired

```bash
RAILWAY_API_TOKEN=*** \
RAILWAY_PROJECT_ID=e240cdf0-1a93-475b-88e2-c7ec570eb9ae \
RAILWAY_ENVIRONMENT_ID=14424076-195e-46b7-8977-3a025360d60a \
BLUE_SERVICE_ID=915bcd34-3223-43c3-ab24-fca91a0180b0 \
OUTBOX_DLQ_WEBHOOK=https://hooks.slack.com/... \
NATS_DOUBLE_EMIT_WEBHOOK=https://hooks.slack.com/... \
COLD_SYNC_STALL_WEBHOOK=https://hooks.slack.com/... \
  scripts/railway-alerting-setup.sh --apply
```

Output `applied_count` should equal `rule_count`. Any `failed_count > 0` means alerting is degraded — fix or accept before proceeding.

## Cutover sequence (T+0)

### Step 1 — Deploy Ponder to blue belt

```bash
RAILWAY_API_TOKEN=*** \
RAILWAY_PROJECT_ID=e240cdf0-1a93-475b-88e2-c7ec570eb9ae \
RAILWAY_ENVIRONMENT_ID=14424076-195e-46b7-8977-3a025360d60a \
BLUE_SERVICE_ID=915bcd34-3223-43c3-ab24-fca91a0180b0 \
DATABASE_URL=postgresql://... \
DEPLOY_TIMEOUT_SECONDS=900 \
  scripts/deploy-blue.sh --commit bc15f46 --apply
```

Expected: JSON record with `"status": "SUCCESS"` within 15 minutes. The `log_path` is the build-log file; keep it for the postmortem record.

**Abort if**: `"status": "FAILED"` or `"status": "TIMEOUT"` → no Hasura cutover; revert by redeploying the prior envio image.

### Step 2 — Cold-sync wait + abort threshold

After deploy, Ponder begins cold-sync from chain start_block. Per ADR-010 / sprint A-4 T-A4.3: if at 12h chain 1 is < 50% complete, ABORT before Hasura cutover.

Operator monitors `/ready` endpoint until it returns 200, then re-runs the abort-threshold check:

```bash
# Loop until /ready 200 (or operator aborts manually if exceeds budget):
until curl -fSs https://belt-indexer-green.up.railway.app/ready >/dev/null 2>&1; do
  sleep 60
  echo "waiting for /ready 200 ... $(date -u +%H:%M:%SZ)"
done

# Final pre-cutover gate
scripts/abort-threshold-check.sh
```

**Abort if**: cold-sync exceeds **4 hours** (per ADR-010 RPO budget reasoning + sprint frontmatter) → script logs duration; operator escalates.

### Step 3 — Hasura cutover (the load-bearing call)

```bash
HASURA_URL=https://belt-hasura.up.railway.app \
HASURA_ADMIN_SECRET=*** \
STAGING_DB_URL=postgresql://... \
  scripts/cutover-hasura-tracking.sh cutover
```

Expected: `[cutover] DONE — direction=cutover schema=ponder unprefixed-root-fields=OK`. Empirical: 716ms–1.27s during A-3 staging.

**Capture switchover epoch**: `SWITCHOVER_EPOCH=$(date +%s)` — feed to the reconciliation script.

### Step 4 — Immediate AC validation (T+0 to T+5 min)

```bash
DATABASE_URL=postgresql://... \
HASURA_URL=https://belt-hasura.up.railway.app \
HASURA_ADMIN_SECRET=*** \
NATS_CAPTURE_DIR=/tmp/nats-capture \
  scripts/ac-validate.sh 2   # envelope byte-parity LIVE
scripts/ac-validate.sh 3   # outbox alive
scripts/ac-validate.sh 4   # consumer queries succeed
scripts/ac-validate.sh 6   # no DLQ build-up (60s observation)
```

All four must return `"passed": true`. If any fails → **rollback path** (below).

### Step 5 — Start 24h reconciliation

```bash
SWITCHOVER_EPOCH=$SWITCHOVER_EPOCH \
NATS_URL=nats://nats.example.com:4222 \
NATS_AUTH_TOKEN=*** \
DURATION_SECONDS=86400 \
  scripts/nats-reconciliation-24h.sh > /tmp/nats-recon.log 2>&1 &
echo $! > /tmp/nats-recon.pid
```

The script runs for 24h, logs `[NATS-DOUBLE-EMIT]` lines on detection (caught by the Railway alert rule from pre-flight), and writes a final summary JSON to `/tmp/nats-recon-<DRILL_ID>.summary.json`.

## Post-cutover observation

### T+1h

- [ ] Re-run AC-3, AC-4, AC-6
- [ ] Check Railway dashboard: zero `[OUTBOX-DLQ-ALERT]` fires
- [ ] Check NATS reconciliation log: zero unexpected duplicates outside the 60s switchover window

### T+6h

- [ ] Re-run AC-3, AC-4, AC-6
- [ ] Spot-check consumer-side state (mediums / freeside-score / sietch-discord): no anomalies
- [ ] Cold-sync `/ready` still 200; max chain lag < 100 blocks

### T+24h — declare stable

```bash
# Wait for the reconciliation script to exit
wait "$(cat /tmp/nats-recon.pid)"

# Inspect the final summary
jq . /tmp/nats-recon-*.summary.json
```

Must show `"reconciliation_pass": true` AND `"unexpected_dupe_groups": 0`.

If clean:
- [ ] Update beads: `br close <A-4-bead>`
- [ ] Archive cycle: `cycles/archive-cycle.sh` for `sonar-ponder-migration-v1`
- [ ] Capture the run artifacts (deploy log, snapshot paths, AC JSONs, reconciliation summary) under `cycles/sonar-ponder-migration-v1/run-artifacts/<date>/`

## Rollback procedure

Per loa-freeside SDD §6 ("Snapshot-Only Rollback"): rollback is **data hygiene only**, NOT service recovery. The cluster was already broken on envio (gate error); rollback restores that same broken state. The path to working service is forward.

### Rollback decision triggers

| Trigger | Detected by | Action | Authority |
|---|---|---|---|
| Cold-sync exceeds 4h budget | manual monitoring + abort-threshold-check | abort cutover (do NOT run cutover-hasura-tracking.sh cutover) | script auto + operator |
| AC-2 envelope byte-parity fails post-cutover | `ac-validate.sh 2` | rollback | script + operator |
| AC-4 consumer query failure rate > 5% (e.g., 1 of 5 fails twice in a row) | `ac-validate.sh 4` | rollback | operator |
| DLQ grows > 10 rows in any 5-min window | Railway alert hook + `ac-validate.sh 6` | rollback | operator |
| Unexpected NATS double-emit outside 60s switchover window | nats-reconciliation-24h.sh + alert hook | rollback OR consumer-side reconciliation | operator |
| RTO budget breach mid-rollback (> 30 min wall clock) | manual timer | escalate (page) | operator |

### Rollback steps

#### Fast path — Hasura-only rollback (≤ 1.27s empirically; <30 min budget)

If the Postgres state is unchanged (cutover happened but the operator caught a defect within minutes), revert ONLY the Hasura tracking. Envio resumes serving from `public.*`.

```bash
HASURA_URL=https://belt-hasura.up.railway.app \
HASURA_ADMIN_SECRET=*** \
  scripts/cutover-hasura-tracking.sh rollback
```

Verify:
- consumer queries against `MintEvent` resolve again (envio public.*)
- `scripts/ac-validate.sh 4` passes

#### Full path — Postgres + Hasura snapshot restore

If Postgres state has diverged (e.g., outbox has unpublished rows for a state the operator wants to discard), restore the pre-cutover snapshot pair. **This is the snapshot-only path per SDD §6.3**:

```bash
# 1. Stop Ponder
railway service stop --service belt-indexer-green

# 2. Restore Postgres
PGPASSWORD=*** pg_restore \
  --host=postgres-3vic.railway.internal --username=postgres \
  --clean --if-exists --no-owner \
  /tmp/a-4-snapshots/sonar-blue-<TIMESTAMP>.pgdump

# 3. Restore Hasura metadata
curl -fSs -X POST "${HASURA_URL}/v1/metadata" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -d "$(jq -c '{type:"replace_metadata", version:2, args:{allow_inconsistent_metadata:false, metadata:.}}' /tmp/a-4-snapshots/hasura-metadata-blue-<TIMESTAMP>.json)"

# 4. Redeploy prior envio image (operator supplies SHA from Railway deployment history)
PRIOR_ENVIO_IMAGE=<sha> railway redeploy --service belt-indexer
```

Envio is expected to crash with the gate error (this is the same degraded state as pre-cutover — SDD §6.1).

#### Postmortem capture

Collect all script outputs into `cycles/sonar-ponder-migration-v1/postmortem-<date>.md`:
- deploy-blue.sh log
- abort-threshold-check.sh JSON (pre-cutover + post-event)
- ac-validate.sh JSONs (all 5 calls)
- cutover-hasura-tracking.sh transcript
- nats-reconciliation-24h.sh summary (if running)
- railway service log excerpts around the trigger event

## Abort criteria summary table

| Trigger | Action | Authority |
|---|---|---|
| Cold-sync >4h | Abort cutover (do NOT call cutover-hasura-tracking.sh cutover) | Script auto + operator |
| AC-2 envelope parity fails post-cutover | Rollback (Hasura fast path first) | Script + Operator |
| AC-4 consumer query failure >5% | Rollback | Operator |
| DLQ >10 rows in 5 min | Rollback | Operator |
| Unexpected NATS double-emit | Rollback OR consumer-side reconcile (operator judgment) | Operator |
| RTO budget breach mid-rollback | Escalate (page) | Operator |
| Reconciliation script crash | Restart (not a cutover-abort signal) | Operator |

## On-call escalation

Per ADR-010, **operator-led execution**. If the operator is unreachable mid-cutover:
1. Default to **rollback fast path** (Hasura-only) — least-risk path that restores the prior known-broken state without Postgres mutation
2. If rollback fast path itself fails → halt; do NOT escalate to the full-path Postgres restore without operator confirmation
3. Document the halt + rollback attempt in `cycles/sonar-ponder-migration-v1/postmortem-<date>.md`

## Sign-off

Operator signs A-4 complete by:
- [ ] Reconciliation script exited `reconciliation_pass: true`
- [ ] All AC validations green at T+1h, T+6h, T+24h
- [ ] Postmortem-or-completion record written to cycles directory
- [ ] beads task closed
- [ ] Cycle archived

After A-4 completion, sprint **B-1** unlocks (full 6-chain config + non-Mibera handler port).

## References

- ADR-010: `loa-freeside/decisions/010-sonar-ponder-migration-rpo-rto-sign-off.md`
- SDD: `loa-freeside/grimoires/loa/sdd.md` §6 (rollback), §7 (deployment), §8 (testing), §10 (observability)
- Sprint plan: `sonar-ponder-coordinator/grimoires/loa/sprint.md` Sprint A-4
- Cutover script: `scripts/cutover-hasura-tracking.sh` (A-3.6 hardened — introspection-based root-field mapping)
- Reorg drill: `scripts/reorg-drill.sh`
- Snapshot script: `scripts/snapshot-pre-cutover.sh`
- This sprint's scripts: `scripts/deploy-blue.sh`, `scripts/abort-threshold-check.sh`, `scripts/ac-validate.sh`, `scripts/nats-reconciliation-24h.sh`, `scripts/railway-alerting-setup.sh`
