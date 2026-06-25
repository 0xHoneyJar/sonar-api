---
title: Candies per-holder balance reindex + inventory-api CandiesHolderBalance signal (operator-led)
consumer: 0xHoneyJar/inventory-api (src/live-sonar.ts — fetchCandiesBalances)
authority: ADR-010 (operator-signed) — belt cutover is operator-led
status: ready-to-run pending an operator-chosen reindex window
date: 2026-06-07
---

# Candies per-holder balance reindex (operator-led)

This branch (`feat/candies-holder-balance`) adds the `candiesHolderBalance`
(`candies_holder_balance`) Ponder entity + per-holder credit/debit writes in the
`CandiesMarket1155` handler (TransferSingle + TransferBatch). It makes a wallet's
current Candy (mibera_drugs) holdings queryable — they were NOT before (the handler
tracked aggregate inventory/backing/mints but no per-holder balance).

A new Ponder entity gets **no historical backfill**, so `candies_holder_balance`
is EMPTY in production until the belt reindexes from genesis. inventory-api's
`CandiesHolderBalance` query returns `[]` until then.

> **Why operator-led:** ADR-010 (operator-signed) makes belt cutover operator-run
> in a chosen low-traffic window — operator-held secrets (PG passwords, Hasura
> admin secret) + rollback authority. The agent prepares; the operator fires.
> Do NOT run a live reindex from an agent session.

## Consumer contract (do not break)

inventory-api `src/live-sonar.ts` already queries:

```graphql
CandiesHolderBalance(where: { holder_id: {_eq: <addrLower>}, amount: {_gt: "0"} })
  { contract tokenId amount }
```

- **Table root field** `CandiesHolderBalance` — produced by the cutover script's
  `custom_root_fields` bake: snake table `candies_holder_balance` → `snake_to_pascal`
  → `CandiesHolderBalance`. No manual metadata edit.
- **Holder filter field** `holder_id` — the Ponder column KEY is literally
  `holder_id` (snake-case on purpose), so Postgres column = `holder_id` and Hasura
  exposes the field `holder_id`. (Ponder/Drizzle preserves the column key verbatim;
  Hasura exposes the column by its literal name — proven by the live contract
  fixtures querying `tokenId`/`collectionKey` camelCase directly.)
- `contract` (hex, lowercased), `tokenId` (numeric string), `amount` (numeric
  string) — all match the schema column keys verbatim.

## Reindex shape (once the green-build dry-run has validated the procedure)

Identical shape to `apiculture-green-belt-reindex.md` (additive new per-holder
balance table → from-genesis reindex → auto-track at cutover).

1. **Stand up green** from this branch merged to `main` (carries
   `candies_holder_balance`) on its own Railway service + own Postgres (wipe-blue
   guard: green PG vars MUST reference Postgres-green, never the live DB).
2. **Reindex from genesis.** CandiesMarket1155 = Berachain 80094, 2 addresses
   (`0x80283fbf2b8e50f6ddf9bfc4a90a8336bc90e38f` SilkRoad + secondary
   `0xeca03517c5195f1edd634da6d690d6c72407c40c`). The balance is rebuilt from the
   full TransferSingle/TransferBatch history (mints credit, trades debit+credit,
   burns debit) — backfill MUST start from each contract's deploy block so no
   transfer history is missed.
3. **Verify `candies_holder_balance` populated** before any cutover (queries below).
4. **Hasura auto-tracks** the new table at cutover: `scripts/cutover-hasura-tracking.sh`
   derives its allowlist from `information_schema.tables WHERE table_schema='ponder'`
   and bakes the `CandiesHolderBalance` root field. **No manual metadata edit.**
   Regenerate the `test/hasura-contract/metadata-diff.test.ts` snapshot to include
   `candies_holder_balance`.
5. **Cutover** (BELT_UPSTREAM swap, per A-4 shape). Hasura rollback measured
   716ms–1.27s in A-3 staging.
6. **Post-verify** on `belt-gateway-production`, then **signal inventory-api**
   ("CandiesHolderBalance live + populated; repoint clear").

## Verification queries (the fix is correct iff these hold)

```sql
-- A wallet's current Candy holdings (per contract+token), positive only.
SELECT holder_id, contract, "tokenId", amount
FROM candies_holder_balance
WHERE holder_id = '<addr_lower>' AND amount > 0
ORDER BY amount DESC;

-- No negative balances should ever exist (debit clamps at 0).
SELECT count(*) FROM candies_holder_balance WHERE amount < 0;   -- expect 0

-- Sanity: SUM over holders of a (contract, tokenId) ~ candies_inventory.currentSupply
--         minus any burned supply (burns debit the holder but inventory is mint-only).
SELECT "tokenId", SUM(amount) AS held
FROM candies_holder_balance
WHERE contract = '0x80283fbf2b8e50f6ddf9bfc4a90a8336bc90e38f' AND chain_id = 80094
GROUP BY "tokenId" ORDER BY held DESC LIMIT 20;
```

GraphQL spot-check on `belt-gateway-production`:
`CandiesHolderBalance(where: { holder_id: {_eq: "<addr_lower>"}, amount: {_gt: "0"} }) { contract tokenId amount }`
— expect the wallet's positive Candy cells.

## Rollback

Per A-4: BELT_UPSTREAM swap back + Hasura metadata restore from the pre-cutover
snapshot. green stays hot. The code is additive (new table + additive handler
writes only — all existing candies_inventory/candies_backing/erc1155_mint_event/
mibera_order writes are UNCHANGED), so a rollback simply drops the new table;
inventory-api returns `[]` from `CandiesHolderBalance` until repointed (no break,
since it holds its repoint on the live signal).
