# SVM pump.fun holder pipe — design (Pythians)

**Date:** 2026-06-23 · **Status:** v1 implemented (code + unit tests landed) · **Sibling:** `2026-06-21-svm-genesis-stones-design.md`

## JTBD

Index **holder balances** for the Pythians community token on Solana — `7C9AvMCtsgbZoip9aMs8etFueo5YStXFnDtwrDg5pump` — behind the same substrate seam as the genesis-stones pipe, so RPC powers v1 and HyperSync-SVM swaps in at scale with no consumer change. Surfaces "who holds what" into the SVM Hasura, unified downstream at the belt-gateway (chain-agnostic by construction).

## On-chain grounding (verified via RPC 2026-06-23 — observed, not assumed)

| Fact | Value | How |
|---|---|---|
| Token program | **Token-2022** (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) | `getAccountInfo(mint).owner` |
| Decimals | **6** | mint data byte 44 |
| Supply | 999,385,713.995004 (raw `999385713995004`) | mint data u64 @36 |
| Classic Token program (for the generic path) | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | `getAccountInfo(wSOL).owner` |

> Pythians is **Token-2022**, not classic SPL — a classic-only holder query (`dataSize:165` filter) would return **zero** accounts. The pipe detects the program from the mint and drops the `dataSize` filter for Token-2022 (its accounts carry variable-length TLV extensions; base fields stay at mint@0 / owner@32 / amount@64).

## The seam (mirror of genesis-stones)

- `src/svm/spl-holder-source.ts` — `SplHolderSource` interface (`snapshot()` + `health()`), pure decoders (`parseTokenAccount`, `decodeMintDecimals`, `aggregateByOwner`), `RpcSplHolderSource` (v1), `HyperSyncSplHolderSource` (stub — Solana HyperSync still lacks token-account handlers, per `2026-06-20-svm-substrate-finding.md`).
- `src/svm/pump-fun-indexer.ts` — Pythians config (`PYTHIANS_MINT`, `COLLECTION_KEY = "pythians"`), batched Hasura upsert + stale-holder reconcile, `indexSnapshot()`/`toRows()` (importable/testable), `main()` (runs via `npx tsx`).
- `test/spl-holder-source.test.ts` — 8 unit tests (classic + Token-2022 account decode, decimals, aggregation, row mapping; u64-max preserved as string).

## Holder model — snapshot + reconcile (NOT append-only)

Holders are **current-state**, unlike genesis stones (append-only). Each run:
1. `getProgramAccounts(program, memcmp(mint@0))` → parse owner+amount → aggregate by owner (sum, drop zero, sort desc) → snapshot at the current slot.
2. Batched **upsert** (`on_conflict` on `<collection_key>:<owner>`), each row stamped with the snapshot `slot`.
3. **Reconcile**: `delete … where collection_key = 'pythians' and slot < <snapshot slot>` — wallets that exited drop out instead of lingering as stale balances.

Balances stored as **raw u64 (`amount_raw`, numeric) + `decimals`** — never a pre-divided float (no precision loss); consumers format `amount_raw / 10^decimals`.

## Hasura table DDL (apply to the SVM Hasura's Postgres before first run)

```sql
CREATE TABLE IF NOT EXISTS svm_token_holder (
  id             text PRIMARY KEY,          -- '<collection_key>:<owner>'
  collection_key text NOT NULL,             -- 'pythians'
  mint           text NOT NULL,             -- SPL/Token-2022 mint (base58)
  owner          text NOT NULL,             -- holder wallet (base58)
  amount_raw     numeric NOT NULL,          -- raw u64 balance (no decimals applied)
  decimals       smallint NOT NULL,         -- mint decimals (6 for Pythians)
  slot           bigint NOT NULL,           -- snapshot slot
  source         text NOT NULL DEFAULT 'rpc',
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS svm_token_holder_collection_idx ON svm_token_holder (collection_key);
CREATE INDEX IF NOT EXISTS svm_token_holder_mint_idx       ON svm_token_holder (mint);
```

Then track the table in Hasura (metadata) so it's queryable. Generic by design: any SPL/Token-2022 token gets a row-set under its own `collection_key`.

## Run

```bash
SOLANA_RPC_URL=<helius-or-capable-rpc> \
HASURA_GRAPHQL_ADMIN_SECRET=<secret> \
SVM_HASURA_ENDPOINT=<svm-hasura-url> \
  npx tsx src/svm/pump-fun-indexer.ts
```

> Needs a **capable RPC** (Helius via `SOLANA_RPC_URL`). A popular mint can have many holders and public endpoints throttle large `getProgramAccounts`. Helius DAS (`getTokenAccounts`) is a drop-in optimization for the `RpcSplHolderSource.snapshot()` internals later.

## Verification (this branch)

- `pnpm test test/spl-holder-source.test.ts` → **8/8** (pure decoders + aggregation + row mapping; includes the Token-2022 >165-byte account case).
- `tsc --noEmit` on both `src/svm/*.ts` → clean.
- Token program IDs + decimals **grounded from mainnet RPC** (table above), not memory — one wrong classic-program-ID guess was caught and corrected this way.

## Future

- **Realtime tail** — `logsSubscribe`/transfer-instruction parsing to apply deltas between snapshots (genesis-stones' `stream()` analogue).
- **HyperSync** — swap `RpcSplHolderSource` → `HyperSyncSplHolderSource` behind the unchanged seam once Solana HyperSync ships token-account state.
- **Multi-token runner** — lift `PYTHIANS_MINT`/`COLLECTION_KEY` to argv/env or a registry so one runner indexes N communities.
- **Token-2022 extensions** — transfer-fee / interest-bearing extensions could affect "effective" balance; v1 reports raw `amount`.
