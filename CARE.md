# CARE — what sonar stakes attention on

> The gaze, not the surveillance dump.  
> Machine twin: `pnpm care` / `pnpm care --json` (`scripts/sonar-care.sh`).  
> Door: [`grimoires/loa/ARRIVAL.md`](grimoires/loa/ARRIVAL.md). Identity: [`SOUL.md`](SOUL.md).

**Schema:** `sonar.care.v1` · **Alias:** `https://sonar.0xhoneyjar.xyz`

If an agent has 30 seconds: run `pnpm care triage --json` and stop expanding context.

---

## Philosophy (load-bearing)

1. **Self-host the indexer; don’t rent the reads.**
2. **One SoT** — every consumer at the same block height.
3. **I see; I do not judge** — Score ranks; Sonar indexes.
4. **Truth first; telemetry fail-soft.**
5. **Compress the scan-set; never drop floors; renvoi is visible.**

---

## SLOs (S1–S5)

| ID | Name | Status | SLI | Target / note |
|----|------|--------|-----|----------------|
| **S1** | Freshness | proposed | `block_height − latest_processed_block` | 80094 &lt;300 blk (~10m) strictest; others in SCALE Guardrail 2 |
| **S2** | Completeness | aspirational | entity counts vs getLogs sample | Never trust “synced to head” alone (KF-012) |
| **S3** | Contract stability | active-discipline | GraphQL + consumer queries post-promote | Gate PASS; additive schema preferred |
| **S4** | Onboarding latency | proposed | `queued→indexed` p50/p95 **or** explicit deferred | No black-hole queue |
| **S5** | Promote safety | **active** | `BELT_UPSTREAM` only via `promote.sh` | Dry-run always; retain old belt ≥7d |

**Alert rule (S1):** managed runner only (not a laptop). Two consecutive breaches before page. Until baseline exists → **observe, don’t page**.

### Probes

```bash
pnpm care triage --json             # mega + .live (S1 lag or offline reason)
pnpm care slo --json                # SLOs + .live
pnpm pulse                          # coherence (0/1/2)
# live lag: GraphQL chain_metadata on sonar.0xhoneyjar.xyz (fail-soft; never blocks care)
# override: SONAR_GRAPHQL_URL · SONAR_CARE_PROBE_TIMEOUT (default 2s)
bash scripts/promote.sh --dry-run
pnpm verify:belt-contract
```

`.live.status` is `ok` | `offline` | `error`. Offline never fails the care exit code — truth first; telemetry fail-soft.

---

## Floors (non-compensatory)

These are **not** weighted soft preferences. Compensatory ranking must not bury them.

| ID | Floor |
|----|--------|
| F1 | Berachain (80094) primary freshness |
| F2 | Score / consumer-critical collections — not renvoied by taste alone |
| F3 | Promote never skips the gate |
| F4 | Honest-green: absence → UNKNOWN/DRIFT, never silent PASS |

---

## Onboarding — batch out of taste × demand

Kitchen already queues (`queued → indexing → completed | failed`).  
**Policy upgrade:** do not FIFO-reindex the world on every POST.

```
produce   → accept orders freely (cheap write)
systemize → batch by chain · depth · shared reindex window · estimate minutes
clarify   → rank demand ∧ taste; renvoi with reason; floors stay lit
drain     → only under S1 error budget
```

| Signal | Demand | Taste |
|--------|--------|-------|
| Strong | real `order_id`, multi-product pull, repeats | Tracked* lane, ecosystem fit, tight `start_block` |
| Weak | anonymous spam, one-off curiosity | custom handler explosion, genesis vanity |

**Renvoi reasons (name them):** `out_of_scope` · `spam_nft` · `depth_too_expensive` · `awaiting_batch_window` · `duplicate`

---

## Renvoi (what we released — on purpose)

| Released | Because |
|----------|---------|
| Managed Envio deployment IDs as authority | Superseded by operator alias |
| Ponder / inverted ponder-ci gate | Ghost limb; Envio only |
| Immediate reindex per Kitchen POST | Reindex-all coupling; batch instead |
| Laptop-as-production-alerter | Sleeps; silent failure worse than no monitor |

---

## Dream ritual (ops consolidation)

When a sitting closes or before a promote/onboarding wave:

1. **Produce** — ≤5 bullets that changed (lag, queue, schema, scar).
2. **Systemize** — map each to S/F or file a gap; name CHRONOS vs KAIROS.
3. **Clarify** — tense fix · supersede · renvoi-with-reason · floor check.
4. **Stop** — no silent promotion of unread sludge to “truth.”

```bash
pnpm care dream
```

---

## Agent first-try

| Intent | Command |
|--------|---------|
| Everything in one call | `pnpm care` / `pnpm care --json` |
| Contract | `pnpm care capabilities --json` |
| Handbook | `pnpm care robot-docs` |
| Live coherence | `pnpm pulse` |
| Safe promote rehearsal | `bash scripts/promote.sh --dry-run` |

Exit codes for `sonar-care`: **0** ok · **1** bad input (stderr teaches exact fix) · **3** environment.

---

## Still true / still open

- **True:** self-hosted belt + stable alias is the sovereignty posture we chose.
- **Open:** S1 enforcement, S2 continuous completeness, S4 `deferred` job state, D4 per-chain split.

Update this file when a care status flips `proposed → active` or a floor is ratified. Prefer editing the model in `scripts/sonar-care.sh` (`emit_care_json`) and reflecting prose here — agents trust the command; humans trust this card.
