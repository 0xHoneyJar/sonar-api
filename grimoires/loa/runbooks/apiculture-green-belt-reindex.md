---
title: Apiculture green-belt reindex + #62 repoint signal (operator-led)
issue: 0xHoneyJar/sonar-api#62
pr: 0xHoneyJar/sonar-api#64 (merged 2026-06-04)
authority: ADR-010 (operator-signed) — cutover is operator-led
blocked_by: bd-umw.4 (green-build dry-run promotion not yet executed)
status: ready-to-run pending the bd-umw prerequisite
date: 2026-06-04
---

# Apiculture green-belt reindex (operator-led)

PR #64 merged `trackedHolder1155` (per-`{contract,chain,tokenId,wallet}` balance)
into `ponder.schema.ts` + the `puru-apiculture1155` Ponder handler. A new Ponder
entity gets **no historical backfill**, so the table is empty in production until
the green belt reindexes from genesis. score-api is holding its repoint on the
#62 signal until then.

> **Why operator-led:** ADR-010 (operator-signed) makes belt cutover operator-run
> in a chosen low-traffic window. It needs operator-held secrets (PG passwords,
> Hasura admin secret) and rollback authority. The agent prepares; the operator
> fires.

## Prerequisite (do this FIRST)

**bd-umw.4 — execute the green-build dry-run promotion end-to-end** (green = copy
of current → S1 gate PASS → swap → rollback), capturing G4 backfill wall-time +
promotion-window cost. The green-belt subset (apiculture is in it) is **Sprint B-1**
and is explicitly **out of scope of the A-4 (blue/Mibera) runbook**. Do not run a
first-ever green-belt production reindex before the dry-run validates the
procedure. Reference: `grimoires/loa/specs/green-v2-boot-spec.md`,
`grimoires/loa/runbooks/belt-reinit.md` (Envio reference; the green belt is Ponder),
`docs/A-4-cutover-runbook.md` (blue reference for the cutover shape + rollback).

## Reindex shape (once bd-umw.4 has validated the procedure)

1. **Stand up green-v2** from `main` (now carries `tracked_holder_1155` in the
   ponder schema) on its own Railway service + own Postgres (the wipe-blue guard:
   green's PG vars MUST reference Postgres-green, never the live DB). Per the
   green-build procedure (bd-umw.1).
2. **Reindex from genesis.** apiculture startBlock = **13,803,165** (Base 8453).
   The other 3 puru contracts emit ~block 20,521,993. Whole-chain Base is ~8.4M
   events (~6 min backfill cold; real-world 30 min to 2 h with provisioning).
3. **Verify `trackedHolder1155` populated** before any cutover (queries below).
4. **Hasura auto-tracks** the new table at cutover: `scripts/cutover-hasura-tracking.sh`
   derives its allowlist from `information_schema.tables WHERE table_schema='ponder'`.
   No manual metadata edit. Regenerate the `test/hasura-contract/metadata-diff.test.ts`
   snapshot to include `tracked_holder_1155`.
5. **Cutover** (BELT_UPSTREAM swap, per A-4 shape). RTO target ≤ 30 min;
   Hasura rollback measured 716ms–1.27s in A-3 staging.
6. **Post-verify** on `belt-gateway-production`, then **signal #62** (comment:
   "trackedHolder1155 live + populated; repoint clear").

> **Companion #63 (PR #65, addressType) rides this SAME reindex.** The
> `AddressResolveBase` block-handler enqueues a `pending` row per address seen and
> drains via `eth_getCode` once the belt is at head. Also auto-tracked at cutover.
> Verify + signal **#63** alongside #62:
> ```sql
> -- The rank-#3 router should resolve to a contract (NOT a human eoa).
> SELECT type FROM address_type
> WHERE chain_id = 8453
>   AND address = '0x777777794a6e310f2a55da6f157b16ed28fa5d91';   -- expect 'contract'
> -- No addresses should be stuck pending long after catch-up:
> SELECT count(*) FROM address_type WHERE chain_id = 8453 AND type = 'pending';
> ```

## Verification queries (the fix is correct iff these hold)

The bug: the apiculture token-4 distortion. Ground-truth spot-checks from #62:

```sql
-- A wallet on-chain holding 2,575 of token-4 should read balance = 2575
-- (it was scoring 12,993 under gross-inflow).
SELECT address, balance FROM tracked_holder_1155
WHERE contract = '0x6cfb9280767a3596ee6af887d900014a755ffc75'
  AND chain_id = 8453 AND token_id = 4
ORDER BY balance DESC LIMIT 20;

-- The router that holds 0 should have NO row (delete-on-empty), not balance 8404.
SELECT count(*) FROM tracked_holder_1155
WHERE contract = '0x6cfb9280767a3596ee6af887d900014a755ffc75'
  AND chain_id = 8453 AND token_id = 4 AND balance <= 0;   -- expect 0

-- Coverage: only puru collectionKeys should appear.
SELECT DISTINCT collection_key FROM tracked_holder_1155;

-- Cross-check: whole-collection SUM(per-edition) ~ trackedHolder.tokenCount
-- for an apiculture holder (modulo editions the holder has in trackedHolder).
```

GraphQL spot-check on `belt-gateway-production` (root-field name confirmed at
cutover; new ponder-only table → default `trackedHolder1155` form):
filter `contract=0x6cfb92…`, `chainId=8453`, `tokenId=4`; expect `balance` per `address`.

## Rollback

Per A-4: BELT_UPSTREAM swap back + Hasura metadata restore from the pre-cutover
snapshot. green-v2 stays hot. The code is additive (new table only), so a rollback
to the pre-#64 belt simply drops the per-edition table; score keeps its current
gross-inflow fallback (no consumer breakage because score holds its repoint on the
#62 signal).
