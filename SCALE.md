# SCALE.md — Indexer Operator Playbook

> Operational guardrails for managing `0xHoneyJar/thj-envio` (alias: freeside-sonar) so contract additions don't take prod offline for hours.

**Audience**: zerker (primary maintainer), and anyone proposing config changes.
**Last updated**: 2026-05-04
**Last reviewed**: 2026-05-04 (3-model adversarial via Flatline Protocol — claude-opus-4-8 + gpt-5.4-codex + gemini-3.0-pro; 6 HIGH_CONSENSUS + 6 blockers folded into the guardrails below)
**Companion docs**: [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md), [FAST_TESTING_GUIDE.md](./FAST_TESTING_GUIDE.md)
**Owner**: zerker. Review cadence: re-validate after any cycle that ratifies a Decision Log item, or quarterly minimum.

---

## Why This Doc Exists

When a new contract source is added to `config.yaml`, **the entire indexer must be reset and reindex from each chain's `start_block`**. With 6 chains and ~5M events on Berachain alone, this can take 30 minutes to several hours. During the reindex, consumers (`apdao-auction-house`, `score-mibera`, `mibera-codex`, `dimensions`) see stale or missing data.

This playbook captures the 5 guardrails that prevent the most common failure modes.

### Why config-tightening alone won't save you

This is the bottom-line empirical lesson from multiple optimization cycles: **per-source `start_block` tightening, HyperSync coverage, V3 migration — all done — produced negligible UX improvements in backfill time.** The bottleneck is architectural: a single deployment indexing 6 chains means *any* contract addition forces a full reindex of *all* chains. The playbook below mitigates the operational pain, but the structural fix is in [Decision Log D4](#decision-log-operator-pair-points) (per-chain deployment split). Treat the guardrails as harm-reduction, not throughput improvement.

### Authoritative Production Deployment

Until the Decision Log resolves D1, **`b5da47c` is the authoritative production deployment ID** for all consumers and all monitoring/alerting. `914708e` is a parallel mirror with identical sync state (verified 2026-05-04) and is treated as a hot standby — not a deploy target — until D1 is decided.

---

## Current Sync Posture (probe yourself before each cycle)

```bash
for did in b5da47c 914708e; do
  echo "=== deployment $did ==="
  curl -s -X POST "https://indexer.hyperindex.xyz/$did/v1/graphql" \
    -H "Content-Type: application/json" \
    -d '{"query":"{ chain_metadata(order_by: {chain_id: asc}) { chain_id is_hyper_sync start_block latest_processed_block block_height num_events_processed timestamp_caught_up_to_head_or_endblock } }"}' \
    | jq -c '.data.chain_metadata[] | {chain_id, is_hyper_sync, start: .start_block, processed: .latest_processed_block, head: .block_height, events: .num_events_processed, caught_up: .timestamp_caught_up_to_head_or_endblock}'
done
```

**Note (schema drift)**: HyperIndex v3 renamed `is_hyper_sync_indexer` → `is_hyper_sync`. Older docs/probes may use the old name and return null. Use the schema introspection above if a field returns null.

---

## Guardrail 1 — Blue-Green Schema Rollout

**Rule**: When adding a new contract source, deploy to a fresh deployment ID first. Watch backfill complete. **Then** swap consumer endpoints. Do NOT redeploy in place if backfill estimate exceeds 30 minutes.

### When to use blue-green

- Adding any new `contracts:` block to `config.yaml`
- Adding any new address to an existing `contracts:` block whose `start_block` predates the new address (= would re-scan history)
- Schema (`schema.graphql`) changes that affect indexed entities
- Handler logic changes that produce different aggregates from the same events

### When in-place is acceptable

> **VERIFIED (S0 / D6, 2026-05-21)**: Envio's reset semantics are now code-confirmed — see `grimoires/loa/runbooks/belt-reinit.md`. `isInitialized()` is a table-existence check (not config-hash); resume restarts each chain from its `chain_metadata` `progressBlockNumber`, not from config `start_block`. **In-place is safe ONLY when the new address's deployment block is *after* `latest_processed_block` for every chain it appears on** (case below). If the new address has history *before* the chain head, plain resume silently misses it and a full belt `--restart` is required (which re-seeds all of that belt's chains — but never sibling belts). Schema changes still default to blue-green.

- Adding a new address whose deployment block is *after* the deployment's `latest_processed_block` for *every* chain it appears on (verified per chain — not assumed cross-chain)
- Bug fixes in handler logic that don't change aggregate shape (read-side patches)
- Doc-only changes

### Pre-flight: RPC capacity check

> **Flatline review SKP-003** — A blue-green deployment triggers full reindex from `start_block` across 6 chains *simultaneously*. Without dedicated high-throughput RPC capacity, the new deployment is likely to hit `429 Too Many Requests`, stalling indefinitely and burning the project's RPC allocation.

Before launching a blue-green:
- Verify your Envio deployment is configured with a high-throughput RPC tier (paid Alchemy/Infura/QuickNode endpoint, NOT free tier).
- If using a fallback RPC chain, ensure the fallbacks have separate rate limits.
- Estimate cumulative RPC RPS: `(events_to_index / events_per_block_avg) × parallel_chains × chunking_factor`.
- If estimate >50% of RPC tier capacity, request a temporary tier upgrade or stagger blue-green by chain.

### Blue-green steps

> **Flatline review SKP-001 (CRITICAL — split-brain risk)**: Manual env-var swap across 4+ consumers cannot be perfectly synchronized. For the duration of the swap window, different consumers will read from different deployments at different block heights, producing user-visible inconsistencies. The structural fix is **Guardrail 5 (stable consumer alias)**, which is **a precondition for safe blue-green** — see "Coordinating consumer cutover" below.

1. Open PR with config change.
2. Run estimate (Guardrail 3 step 4) — confirm backfill >30 min, including the cumulative-across-affected-chains total.
3. **Page consumer maintainers** before cutover begins. Required confirmations from owners of `apdao-auction-house`, `score-mibera`, `mibera-codex`, `dimensions` that they're available for the cutover window.
4. Operator (zerker) at `hosted.envio.dev`:
   - Click "Deploy from branch" — produces a NEW deployment ID (e.g., `abc1234`).
   - DO NOT swap the existing prod deployment.
5. Wait for `chain_metadata.timestamp_caught_up_to_head_or_endblock` on the new deployment to populate for all 6 chains.
6. **Schema-diff verification**: Run consumer GraphQL queries against new deployment ID. Verify:
   - All fields consumers depend on are present and non-null.
   - Aggregate counts (TrackedHolder, CollectionStat, etc.) match old deployment within ±1% for any pre-existing collection.
   - Per-source health probe (Guardrail 4) returns rows for the newly-added source.
7. **Coordinating consumer cutover** — see ordered sequence below.
8. Verify each consumer renders correctly in production after its swap.
9. Keep old deployment hot for **MUST 7 days minimum** (was: "may delete after 7" — promoted to mandatory). The retention window is the rollback grace period.

#### Coordinating consumer cutover (split-brain mitigation)

Until Guardrail 5 (stable alias) lands, do an ordered sequence rather than a flag-day flip:

1. **Lowest-traffic consumer first** (e.g., `mibera-codex`): swap env, deploy, verify.
2. **Read-only consumers next** (`dimensions` viewer surfaces): swap, deploy, verify.
3. **Write/governance consumers last** (`apdao-auction-house`): swap during a low-traffic window, deploy, verify.
4. **Score consumer at the trailing edge** (`score-mibera`): swap when the others are stable.

Expected drift window per consumer: minutes (not seconds). During the sequence, surface a "syncing — data may show inconsistency for ~10 minutes" banner in dapps if technically feasible.

**Rollback trigger criteria**: if ANY of:
- New deployment query returns wrong aggregate count (off by >5% on a stable collection)
- Consumer renders with missing entity fields after swap
- Per-source health probe returns empty after deployment claims caught-up
- Operator detects user-reported data inconsistency within first 1 hour of cutover
- Schema diff reveals removed/renamed indexed fields without prior consumer migration

#### Rollback procedure

If rollback trigger fires:

1. Revert all consumer env vars to OLD deployment ID. Use the same ordered sequence from cutover (lowest-traffic first), unless the failure is global enough to warrant simultaneous emergency revert.
2. Verify each consumer's queries succeed against OLD deployment.
3. **Keep new deployment running** in operator dashboard — it's now the "broken" side. Don't delete; preserve for post-incident analysis.
4. Diagnose root cause:
   - Schema regression? Check `schema.graphql` diff for renamed/removed fields.
   - Handler regression? Compare aggregate counts new vs old, identify the divergent entity.
   - Backfill incomplete? Check `chain_metadata.timestamp_caught_up_to_head_or_endblock` on the affected chain.
5. Open a postmortem PR. Document root cause + add a regression test or pre-flight check that would have caught it.
6. Plan corrective deployment as a fresh blue-green cycle (don't try to "fix in place" the broken new deployment).

### Why not auto-swap

Envio managed deployments don't have built-in alias swap. Until a stable consumer alias is wired up (Guardrail 5), env-var swap is the operator-controlled cutover. **Guardrail 5 is a precondition for safe blue-green at scale.** See [Decision Log D2](#decision-log-operator-pair-points).

---

## Guardrail 6 — Kitchen durable store ≠ belt wipe target

**Rule**: Sonar kitchen job identity / prep state must never share the Postgres
schema that Envio `--restart` / `ENVIO_RESTART=1` wipes. Shared co-location is an
ops invariant failure (sonar-api#236), not a recoverable Kitchen bug.

### Required

- `kitchen-api` production: `KITCHEN_DATABASE_URL` → dedicated Postgres (or wipe-exempt service).
- Production refuses silent `ENVIO_PG_*` fallback (code gate).
- KF-013 sequence: run `node scripts/kitchen-survival-check.mjs` before and after wipe — see `grimoires/loa/runbooks/belt-reinit.md` §Kitchen survival.

### Forbidden

- Pointing Kitchen at the monobelt / sidecar wipe database “for convenience.”
- Re-applying `migrations/kitchen/*` after every belt wipe as the steady-state recovery path.

---

## Guardrail 2 — Sync-Lag SLO

**Rule**: Per-chain block-lag must stay below the SLO threshold. Operator alert fires when threshold exceeded.

### SLO Targets

> **Status: PROPOSED, not yet enforced (Flatline review IMP-004)**. The numbers below are educated initial estimates pending one week of baseline lag observation. Once observed P95 lag is collected, ratify or adjust each row, then move from "Proposed" to "Active" via a follow-up PR. Until then, do NOT page on these values — only collect observations.

| Chain | Block time | Lag SLO (proposed) | Reasoning |
|---|---|---|---|
| ETH (1) | ~12s | < 50 blocks (~10 min) | Settled chain, low velocity |
| Optimism (10) | ~2s | < 600 blocks (~20 min) | OP rollup, moderate event rate |
| Arbitrum (42161) | ~0.25s | < 2,400 blocks (~10 min) | High block rate, low event count for THJ |
| Base (8453) | ~2s | < 600 blocks (~20 min) | OP rollup |
| **Berachain (80094)** | ~2s | < 300 blocks (~10 min) | Primary chain — strictest SLO |
| Zora (7777777) | ~2s | < 1,800 blocks (~60 min) | Low velocity, less critical |

### Lag check command

```bash
DEPLOYMENT_ID=b5da47c  # or current prod alias
curl -s -X POST "https://indexer.hyperindex.xyz/$DEPLOYMENT_ID/v1/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ chain_metadata(order_by: {chain_id: asc}) { chain_id latest_processed_block block_height } }"}' \
  | jq '.data.chain_metadata | map({chain_id, lag: (.block_height - .latest_processed_block)})'
```

### Alert wiring

> **Flatline review (CRITICAL SKP-001)**: Production alerting MUST NOT run on a developer laptop. A laptop sleeps, loses internet, or goes on vacation, and silent monitoring failure is worse than no monitoring at all (you stop checking because you assume "the monitor would tell me").

**Run the lag-check from a managed environment.** Pick one:

| Option | Trade-offs | Recommended for |
|---|---|---|
| **GitHub Actions scheduled workflow** | Free, lives next to repo, fires on `schedule:` cron. Output to issue/Slack via webhook. | Lowest-friction starting point. |
| **Railway scheduled service** | Operator already uses Railway for prod ops. ~$5/mo. Logs centralized. | If alerting becomes critical and PagerDuty is overkill. |
| **Cloudflare Worker cron** | Free tier, edge-fast, fires every 1 min (CF cron limitation: 5min minimum on free, 1min on paid). | If composing with Guardrail 5 (Worker-based alias). |
| **AWS EventBridge + Lambda** | Full enterprise, costs ~$0/mo at this volume. | Only if THJ already has AWS infra. |

The script itself stays simple — it's the lag-check command from above wrapped in a webhook/issue dispatcher when any chain breaches its SLO for two consecutive checks. Sample logic:

```bash
#!/bin/bash
# lag-check.sh — runs in managed environment (GitHub Actions / Railway / etc.)
DEPLOYMENT_ID=b5da47c
LAG_DATA=$(curl -s -X POST "https://indexer.hyperindex.xyz/$DEPLOYMENT_ID/v1/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ chain_metadata { chain_id latest_processed_block block_height } }"}')

# Compare against SLO_TARGETS (proposed values from this doc, parsed from a sibling JSON file)
# Page via Discord webhook / GitHub issue / Slack on breach for 2 consecutive checks
```

Until a managed runner is wired up, the SLO is in "observation only" mode (per Guardrail 2 above) — collect data, don't page.

---

## Guardrail 3 — Source-Addition Checklist

**Rule**: Before opening a PR that adds or modifies `config.yaml` contract sources, the author must complete this checklist in the PR description.

### Checklist

```markdown
- [ ] **Contract creation block looked up** via the chain's official explorer
      Source: <explorer URL>
      Creation block: <number>
      Creation tx: <hash>
- [ ] **`start_block:` ≥ creation block** (verify in diff)
- [ ] **Local 5-min smoke test** ran via FAST_TESTING_GUIDE pattern; handler fires on at least one event
- [ ] **Per-source backfill estimate computed** (use formula below):
      Blocks since deployment: <number>
      Events expected: <number>
      Estimated reindex time: <minutes>
- [ ] **CUMULATIVE backfill estimate across all affected chains/sources**:
      <list each chain × source × estimated minutes>
      Total: <minutes>
      Method: blue-green (Guardrail 1) OR in-place (only if cumulative <30 min AND in-place safety verified per Guardrail 1 warning)
- [ ] **Per-source health probe** template prepared (Guardrail 4):
      Pass criteria: TrackedHolder OR CollectionStat returns a row within 1000 blocks of first event
- [ ] **Downstream consumers identified**: <list of repos>
- [ ] **Consumer migration plan**: see Guardrail 1 ordered cutover sequence; specify which consumer flips when
- [ ] **RPC capacity pre-flight**: confirm tier and headroom (Guardrail 1 pre-flight section)
```

### Backfill estimate formula

> **Flatline review IMP-002 / SKP-003**: The blue-green decision depends on a 30-minute threshold; without a deterministic estimation method authors will produce optimistic numbers and bad rollout decisions follow.

```
events_expected ≈ (current_block - start_block) × historical_event_rate_per_block_for_source
estimated_seconds = events_expected / 25_000   # V3 chunking: ~25k events/sec sustained
estimated_minutes = ceil(estimated_seconds / 60)
```

To get `historical_event_rate_per_block_for_source`:
- Query the live deployment for events on a similar/related source over a known block window (e.g., 100k blocks).
- `rate = events_in_window / 100000`.
- For brand-new sources with no comparable, use the highest event-rate source on that chain as a conservative ceiling.

For cumulative (multi-chain or multi-source) cycles:
```
cumulative_estimate = max(per_chain_estimates)  # chains parallelize
                    + sum(per_source_estimates_on_same_chain)  # sources on same chain serialize
```

Always add a 30% confidence margin on top — RPC variance, deployment provisioning, and indexer warmup all add real time.

Worked example for adding a new Berachain source:
```
current_berachain_block ≈ 25,000,000
new_source_start_block = 5,000,000
delta = 20,000,000 blocks
rate (similar source) = 0.25 events/block (typical NFT collection)
events_expected = 5,000,000
estimated_seconds = 5,000,000 / 25,000 = 200s
estimated_minutes = 4 min
+ 30% margin = ~5 min
```

Note: this only models event-processing time. Deployment provisioning + chain catch-up beyond the new source's range still adds ~5–15 min on top. The threshold check should compare `(estimated_minutes + 15) > 30 min` for blue-green decision.

### Block-lookup commands

For Berachain (chain_id 80094):
```bash
ADDRESS=0xFc2D7eBFEB2714fCE13CaF234A95dB129ecC43Da
curl "https://api.routescan.io/v2/network/mainnet/evm/80094/etherscan/api?module=contract&action=getcontractcreation&contractaddresses=$ADDRESS" | jq '.result[0]'
```

For ETH/Optimism/Base/Arbitrum: use the corresponding chain's Etherscan-family API. The `getcontractcreation` action is consistent across them.

### Why this exists

PR #5 (apdao_seat, merged 2026-05-05) blocked governance restoration in `apdao-auction-house` for ~2 hours because the reindex hadn't been planned. The checklist forces the time estimate up-front so operators can choose blue-green vs in-place with eyes open.

---

## Guardrail 4 — Per-Source Health Probe

**Rule**: Every newly added contract source must produce a `CollectionStat` (or equivalent aggregate) row within N blocks of its first event. Probe must be runnable locally.

### Probe template

```bash
# Replace SOURCE_KEY with the new collection key (e.g., "apdao_seat")
SOURCE_KEY="apdao_seat"
DEPLOYMENT_ID=b5da47c

curl -s -X POST "https://indexer.hyperindex.xyz/$DEPLOYMENT_ID/v1/graphql" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"{ TrackedHolder(where: {collectionKey: {_eq: \\\"$SOURCE_KEY\\\"}}, limit: 1) { address tokenCount } CollectionStat(where: {collectionKey: {_eq: \\\"$SOURCE_KEY\\\"}}, limit: 1) { holderCount totalSupply } }\"}" \
  | jq
```

### Pass criteria

- `TrackedHolder` returns at least one row OR
- `CollectionStat` returns one row with `holderCount > 0` and `totalSupply > 0`

If both are empty after the deployment has caught up to head, the handler is not firing for this source. Diagnose:

1. Verify address is lowercase in `tracked-erc721/constants.ts` collection-key map (handler matches lowercase).
2. Verify event signature matches the contract's actual ABI.
3. Verify deployment caught up past the contract's creation block.
4. Run local FAST_TESTING_GUIDE pattern with a known event to isolate.

---

## Guardrail 5 — Stable Consumer Alias

**Rule**: Consumers should never hardcode `https://indexer.hyperindex.xyz/<DID>/...`. Use a stable alias the operator controls.

### Current state (2026-05-04)

Consumers hardcode `b5da47c` or `914708e`:
- `apdao-auction-house` — `b5da47c` (verified — Slice A retro)
- `score-mibera` — `b5da47c` (likely; verify in their repo)
- `mibera-codex` — `b5da47c` (likely)
- `dimensions` — `b5da47c` (likely)

When operator wants to swap to a new deployment ID, every consumer must be redeployed with new env vars in lockstep. **This is the root cause of "blue-green is hard."**

### Proposed fix

Operator-controlled DNS alias:
- `indexer.honeyjar.xyz` → CNAME → `indexer.hyperindex.xyz/<active-DID>` (path rewrite via Cloudflare Worker)
- Or: subdomain per environment: `indexer-prod.honeyjar.xyz`, `indexer-staging.honeyjar.xyz`

When operator swaps the active deployment, only the DNS/Worker config changes — consumers don't redeploy.

### Alternative (lower-effort)

Consumers read the active deployment ID from a small JSON file the operator publishes:
```bash
# At https://indexer.honeyjar.xyz/active.json
{ "deployment_id": "b5da47c", "endpoint": "https://indexer.hyperindex.xyz/b5da47c/v1/graphql", "as_of": "2026-05-04T..." }
```
Each consumer fetches this on boot (or every N minutes) and uses the resulting endpoint. Operator updates `active.json` to flip.

> **Flatline review SKP-002 (HIGH) and SKP-001 (CRITICAL split-brain)**: This is no longer a "deferred to a separate cycle" item. **Guardrail 5 is a precondition for safe blue-green deployments.** Manual env-var swap across 4+ consumers will produce user-visible split-brain inconsistencies for the duration of the swap window. Until at least the lower-effort `active.json` approach lands, blue-green deployments must follow the ordered-cutover sequence in Guardrail 1, and the operator must accept the drift-window risk.

---

## Decision Log (operator pair-points)

These need explicit operator answers before they're closed:

- [ ] **D1**: Should `914708e` be formally deprecated, kept as blue-green pair, or unified with `b5da47c`? *Until decided, `b5da47c` is authoritative production per the Authoritative Production Deployment note above.*
- [ ] **D2 (HIGH PRIORITY — flatline-flagged)**: Implement Guardrail 5 (stable consumer alias). The `active.json` file approach is a low-effort starting point that mitigates split-brain risk before the next blue-green cycle. Choose: DNS+CNAME, Cloudflare Worker, or `active.json`.
- [ ] **D3**: Wire alert channel for Guardrail 2 SLO breaches — Discord webhook / GitHub Action issue / Slack? **MUST** run from a managed environment (NOT a developer laptop — see Guardrail 2 alert wiring).
- [ ] **D4 (RECOMMENDED — multiple optimization cycles converge here)**: Per-chain deployment split is the **structural fix** for the indexer's bottleneck. Cumulative evidence: V3 migration, HyperSync, per-source `start_block` tightening, and other config-side optimizations have all produced negligible UX improvements. The single deployment indexing 6 chains is the architecture that forces full reindex on every contract addition. Tradeoff: operational complexity (6 deployments instead of 1, multiple GraphQL endpoints to manage) vs blast-radius reduction (Berachain contract addition only triggers Berachain reindex). **This deserves its own kickoff cycle.**
- [ ] **D5**: Should `CODEOWNERS` enforce zerker review on `config.yaml` and `schema.graphql`? Without enforcement the source-addition checklist will drift into convention rather than gate.
- [x] **D6 (CLOSED — S0 2026-05-21, code-confirmed)**: Envio reset behavior verified per mutation type — see `grimoires/loa/runbooks/belt-reinit.md` §D6 table. Answer to the specific question: adding a new `address` to an existing chain does **NOT** trigger a full reindex and does **NOT** scan from the new contract's `start_block` — plain resume continues the chain from its current `progressBlockNumber` (DB `chain_metadata`), so a new address with history *before* head is silently missed. In-place is safe only when the new address deploys *after* head on every chain; otherwise `--restart` the belt (full belt-chain reindex). Empirical re-confirmation = S2-T3 blast-radius CI probe. Guardrail 1's in-place exception is now verified, not Warning-labeled.

---

## Related Cycles

- **`grimoires/loa/freeside-sonar-perf-cycle.md`** — design memo for this playbook + the per-source `start_block` tightening that ships in the same PR.
- **`perf/sync-optimization` branch** — sf-vaults RPC removal + parallel await (3 commits, separate PR candidate).
- **Future kickoff: per-chain deployment split** — Guardrail 5's architectural sibling.
