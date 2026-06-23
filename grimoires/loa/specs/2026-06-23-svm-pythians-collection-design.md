# SVM NFT-collection ownership pipe — design (Pythians)

**Date:** 2026-06-23 · **Status:** v1 implemented (code + unit tests landed) · **Sibling:** `2026-06-21-svm-genesis-stones-design.md`

## JTBD

Track **per-NFT ownership** for the Pythians NFT collection on Solana — collection mint
`pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru` — behind the same substrate seam as genesis-stones, so
Helius DAS powers v1 and HyperSync-SVM swaps in at scale with no consumer change. Surfaces "who holds
which Pythian" into the SVM Hasura, unified downstream at the belt-gateway.

## Address correction (why this replaced the fungible pipe)

The first address given, `7C9AvMCtsgbZoip9aMs8etFueo5YStXFnDtwrDg5pump`, is a **Token-2022 fungible
token** (pump.fun, 6 decimals). The operator corrected it: Pythians is the **NFT collection**
`pyTh2…Moru`. Fungible holder-balances are the wrong model for an NFT collection — it needs per-token
ownership. The earlier `spl-holder-source.ts` / `pump-fun-indexer.ts` were removed.

## On-chain grounding (mainnet RPC, 2026-06-23 — observed)

| Fact | Value |
|---|---|
| `pyTh2…Moru` owner program | classic SPL Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) |
| decimals / supply | **0 / 1** → an NFT (Metaplex collection mint) |
| mint+freeze authority | `2QJTLwQ7BjTLLwkPTh1Bt7yLny5Hz7cYLHDC6APoUsKK` |

## The seam (mirror of genesis-stones)

- `src/svm/nft-collection-source.ts` — `NftCollectionSource` interface (`snapshot()` + `health()`),
  pure `parseAsset()`, `DasNftCollectionSource` (Helius DAS `getAssetsByGroup`, paginated; handles
  regular + compressed NFTs; owner comes straight from DAS), `HyperSyncNftCollectionSource` stub.
- `src/svm/pythians-collection-indexer.ts` — Pythians config (`PYTHIANS_COLLECTION`,
  `COLLECTION_KEY = "pythians"`), batched Hasura upsert + run-marker reconcile + **two wipe guards**,
  `indexSnapshot()`/`toRows()` (importable/testable), `main()` (runs via `npx tsx`).
- `test/nft-collection-source.test.ts` — 12 unit tests (parse incl. delegate / burnt-drop /
  missing-owner / compressed flag, DAS pagination, DAS-specific health probe, non-2xx surfacing,
  indexSnapshot upsert→reconcile, both wipe guards, row mapping).

## Ownership model — snapshot + reconcile

Ownership is current-state. Each run:
1. `getAssetsByGroup(collection)` paged → every verified member NFT + owner + delegate → snapshot.
   (Page-based; capped at `MAX_PAGES` so a misbehaving DAS fails before any write rather than looping.)
2. Batched **upsert** keyed on the NFT mint, each row stamped with a single per-run `updated_at`.
3. **Reconcile**: `delete … where collection_key = 'pythians' and updated_at < <run iso>` — NFTs
   transferred out / burnt drop out. Reconcile keys on the self-controlled `updated_at` marker, **not**
   the RPC `slot` (which isn't monotonic across load-balanced nodes).

**Two wipe guards** (a reconcile DELETE is the only destructive op):
- **0-member snapshot** → skip upsert + reconcile (a fully-empty read is a DAS/RPC failure).
- **proportional**: if the snapshot shrinks the holder set below `RECONCILE_MIN_RATIO` (0.5) of the
  existing rows → keep the upserts but **skip the reconcile** (a short/dropped DAS page would otherwise
  delete the unread holders).

**Escrow/staking caveat:** DAS `ownership.owner` is the token-account owner. For escrow marketplace
listings and most staking programs that's a program PDA, not the human lister/staker. The pipe stores
BOTH `owner` and `delegate`; resolving escrow PDAs back to the lister is a future enhancement (flagged
for the operator — it affects "who holds" semantics for listed/staked NFTs).

## Hasura table DDL (apply before first run)

Table lives in the **`svm` schema** (matching the sibling `svm.genesis_stone`). Hasura exposes it under
the root field `svm_collection_nft` (schema_table naming); the Postgres PK constraint is
`collection_nft_pkey` (named after the bare table) — that's the name the indexer's `on_conflict` uses.

```sql
CREATE SCHEMA IF NOT EXISTS svm;

CREATE TABLE IF NOT EXISTS svm.collection_nft (
  id              text PRIMARY KEY,          -- NFT mint (base58); PK constraint => collection_nft_pkey
  collection_key  text NOT NULL,             -- 'pythians'
  collection_mint text NOT NULL,             -- pyTh2…Moru
  nft_mint        text NOT NULL,
  owner           text NOT NULL,             -- token-account owner (may be an escrow/stake PDA — see caveat)
  delegate        text,                      -- delegate, if any (often the real lister for escrowless listings)
  name            text,
  compressed      boolean NOT NULL DEFAULT false,
  slot            bigint NOT NULL,           -- snapshot slot (informational; chain tip at snapshot)
  source          text NOT NULL DEFAULT 'das',
  updated_at      timestamptz NOT NULL DEFAULT now()  -- per-run marker; reconcile keys on this
);
CREATE INDEX IF NOT EXISTS collection_nft_collection_idx ON svm.collection_nft (collection_key);
CREATE INDEX IF NOT EXISTS collection_nft_owner_idx      ON svm.collection_nft (owner);
```

Then **track `svm.collection_nft` in Hasura** (it surfaces as `svm_collection_nft`). Generic by
design: any collection gets a row-set under its own `collection_key`.

## Run

```bash
SOLANA_RPC_URL=<helius-DAS-rpc> \    # MUST be DAS-capable (getAssetsByGroup) — Helius
HASURA_GRAPHQL_ADMIN_SECRET=<secret> \
SVM_HASURA_ENDPOINT=<svm-hasura-url> \
  npx tsx src/svm/pythians-collection-indexer.ts
```

> `getAssetsByGroup` is a DAS extension — a plain RPC endpoint will fail `health()`. The indexer aborts
> early if the source is unhealthy. An RPC-only fallback (Token Metadata `getProgramAccounts` filtered
> by the collection field) is a future option if DAS isn't available.

## Future

- **Realtime tail** — subscribe to transfers of member NFTs to apply deltas between snapshots.
- **HyperSync** — swap `DasNftCollectionSource` → `HyperSyncNftCollectionSource` behind the unchanged seam.
- **Multi-collection runner** — lift the two CONFIG constants to argv/env or a registry.
- **Per-NFT traits** — DAS already returns `content.metadata`; extend the row/table if traits are wanted.
