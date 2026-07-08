---
title: Token ownership index reindex + inventory-api getNftsForOwner (operator-led)
consumer: 0xHoneyJar/inventory-api#27 (getNftsForOwner / getHoldings — Token owner→tokenIds)
authority: operator-led belt cutover (secrets + rollback authority operator-held)
status: ready-to-run pending an operator-chosen reindex window
sprint: EVM Onboarding Sprint 1 (FR-2, #153)
date: 2026-07-07
---

# Token ownership index reindex (operator-led)

This sprint lands the per-token current-ownership `Token` index on **main** — the
`@index` on `Token.owner`/`collection`/`isBurned` (`schema.graphql`) **plus** the
population wiring (`context.Token.set` in `handleTrackedErc721Transfer`
[`tracked-erc721.ts`] and `handleMiberaCollectionTransfer` [`mibera-collection.ts`]),
ported from the proven belt-factory implementation (`cycle/sonar-belt-factory`,
PR #18 / `e58a51c`) which was stranded off `main`.

The `Token` entity gets **no historical backfill** — writes only fire on new
transfers. So `Token(owner→tokenIds)` is **EMPTY in production until the belt
reindexes from genesis.** inventory-api#27's `getNftsForOwner` / `getHoldings`
return `nfts: []` / `tokenIds: []` (while `tokenCount` from `TrackedHolder` is
already correct) until then. Prod evidence (2026-07-07, wallet
`0x15b3392708755a9f7aac3b33b401d7efa3d52f38`, 66 Mibera): `tokenCount: 66` OK,
`tokenIds: []` BROKEN.

> **Why operator-led:** belt cutover is operator-run in a chosen low-traffic
> window — operator-held secrets (PG passwords, Hasura admin secret) + rollback
> authority. The agent prepares; the operator fires.
> **Do NOT run a live reindex from an agent session.**

## Consumer contract (do not break)

inventory-api#27 queries (verified correct — the gap is entirely the index not being live):

```graphql
Token(where: { collection: {_eq: <contractLower>}, owner: {_eq: <addrLower>}, isBurned: {_eq: false} })
  { tokenId }
```

- **`collection`** = the lowercased on-chain contract address. Mibera main =
  `0x6666397dfe9a8c469bf65dc744cb1c733416c420` (`mibera-collection.ts`
  `MIBERA_COLLECTION_ADDRESS`); tracked collections use their contract address
  (`tracked-erc721.ts` `contractAddress`). Matches the query's `collection` filter verbatim.
- **`owner`** = lowercased current holder; `isBurned: false` excludes burns
  (burns set `owner=ZERO` + `isBurned=true`).
- **`tokenId`** = numeric — matches the schema column key verbatim.
- Coverage: the 6 Mibera-belt ERC-721 collections. Mibera (0x6666, Berachain
  80094) + Tarot + Fractures are wired in this sprint; Shadows/VM + GIF
  (`mints.ts`) are a tracked follow-up (`bd-evm-onboarding-s1-htad`), not in this landing.

## Reindex shape (once the green-build dry-run has validated the procedure)

Identical shape to `candies-holder-balance-reindex.md` / `apiculture-green-belt-reindex.md`
(additive new writes -> from-genesis reindex -> auto-track at cutover):

1. **Fresh on main (R-1).** The `Token` population wiring + `@index` are re-landed
   on `main` (ported population-only from `e58a51c`, excluding belt-factory reconcile
   assumptions). Do NOT merge `cycle/sonar-belt-factory` wholesale.
2. **Stand up green** from this branch merged to `main` on its own Railway service +
   own Postgres (wipe-blue guard: green PG vars MUST reference Postgres-green, never
   the live DB).
3. **Reindex from genesis.** A from-genesis reindex `DROP ... CASCADE`s the schema —
   which drops the `Token` table — and the reindex recreates it **populated + indexed**.
   Backfill MUST start from each collection's deploy/`start_block` so no transfer
   history is missed (Mibera 0x6666 on Berachain 80094; Tarot + Fractures on their chains).
4. **Scoped, not a full 6-chain re-backfill** (N4): coordinate the reindex window with
   the belt zero-downtime cutover mechanics — the **STABLE Caddy alias** keeps live
   traffic pointed at blue so the surface being rebuilt never serves reads
   (sibling belt SDD 7.4).
5. **Hasura auto-tracks** the `Token` table at cutover (`scripts/cutover-hasura-tracking.sh`
   derives its allowlist from `information_schema.tables WHERE table_schema='ponder'`).
   No manual metadata edit.
6. **Cutover** (BELT_UPSTREAM / STABLE-alias swap, per the belt cutover shape).

## Verification queries (the reindex is correct iff ALL hold)

Run against green BEFORE cutover, then re-confirm on the live alias after:

1. **`Token` populated for Mibera:**
   `SELECT count(*) FROM "Token" WHERE collection = '0x6666397dfe9a8c469bf65dc744cb1c733416c420';`
   -> must be `> 0` (was `0` in prod — the bug).
2. **Repro wallet non-empty** (inventory-api#27 acceptance):
   `getNftsForOwner(0x15b3392708755a9f7aac3b33b401d7efa3d52f38)` on Mibera -> returns the
   66 tokenIds, NOT `[]`.
3. **Reconciliation invariant** (SDD 3.3, and the unit test
   `test/token-ownership-index.test.ts`): for each owner,
   `count(Token WHERE owner=X AND isBurned=false AND collection=C)` **==**
   `TrackedHolder.tokenCount` for `(C, chain, X)`. A divergence means a token dropped
   from enumeration — HALT and investigate before cutover.

## Rollback

STABLE-alias swap back to blue (blue never stopped serving; the reindex ran on green).
Hasura tracking rollback measured sub-1.3s in prior belt A-3 staging. No data loss —
blue's `Token` state is simply the pre-landing (empty) shape; re-attempt the green
reindex in a later window.
