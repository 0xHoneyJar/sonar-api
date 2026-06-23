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
  `COLLECTION_KEY = "pythians"`), batched Hasura upsert + stale reconcile + **empty-snapshot wipe
  guard**, `indexSnapshot()`/`toRows()` (importable/testable), `main()` (runs via `npx tsx`).
- `test/nft-collection-source.test.ts` — 8 unit tests (parse / burnt-drop / missing-owner /
  compressed flag, DAS pagination, indexSnapshot upsert→reconcile + wipe guard, row mapping).

## Ownership model — snapshot + reconcile

Ownership is current-state. Each run:
1. `getAssetsByGroup(collection)` paged → every verified member NFT + its owner → snapshot @ slot.
2. Batched **upsert** keyed on the NFT mint, each row stamped with the snapshot `slot`.
3. **Reconcile**: `delete … where collection_key = 'pythians' and slot < <snapshot slot>` — NFTs
   transferred out of scope / burnt drop out. **Wipe guard:** an empty snapshot (DAS/RPC failure)
   skips upsert+reconcile rather than deleting every row.

## Hasura table DDL (apply before first run)

```sql
CREATE TABLE IF NOT EXISTS svm_collection_nft (
  id              text PRIMARY KEY,          -- NFT mint (base58)
  collection_key  text NOT NULL,             -- 'pythians'
  collection_mint text NOT NULL,             -- pyTh2…Moru
  nft_mint        text NOT NULL,
  owner           text NOT NULL,             -- current holder wallet (base58)
  name            text,
  compressed      boolean NOT NULL DEFAULT false,
  slot            bigint NOT NULL,           -- snapshot slot
  source          text NOT NULL DEFAULT 'das',
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS svm_collection_nft_collection_idx ON svm_collection_nft (collection_key);
CREATE INDEX IF NOT EXISTS svm_collection_nft_owner_idx      ON svm_collection_nft (owner);
```

Then track the table in Hasura. Generic by design: any collection gets a row-set under its own
`collection_key`.

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
