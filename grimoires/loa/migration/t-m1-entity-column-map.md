# T-M1 — Entity + Column Mapping (Envio → Ponder)

**Cycle**: `sonar-ponder-migration-v1` · **Task**: T-M1 · **Status**: COMPLETE (read + produce-artifact; no DB touched)
**Branch**: `spike/t-m1-entity-column-map` (off `main @ f8f2cad8`)
**Authored**: 2026-05-28 · single source of truth for **T-M2** (the transform). Machine-readable companion: `t-m1-entity-column-map.yaml`.

## 0. What this is

A declarative, column-by-column map for the 40 in-scope Mibera blue-belt entities, plus a classification of every envio-only and ponder-only table. **Every mapping below is grounded in a file actually read** — no column or type is inferred.

### Grounding sources (read, not inferred)

| Side | Artifact | What it grounds |
|---|---|---|
| envio SOURCE | `schema.graphql` | GraphQL entity field names + GraphQL types (BigInt/String/Int/Boolean/Json) |
| envio SOURCE | `generated/src/Indexer.res` (ReScript `module <Entity> = { type t = {...} }`) | Exact DB column names + nullability. Confirms columns are **camelCase verbatim**; relation fields get `_id` suffix (e.g. `BadgeAmount.holder_id`) per `node_modules/envio/.../src/db/Table.res:94 getDbFieldName` |
| ponder TARGET | `ponder.schema.ts` (`onchainTable("snake", t => ({...}))`) | Target table names (snake_case literal) + JS column keys + Drizzle types + PK + nullability |
| ponder casing | `node_modules/ponder/dist/esm/drizzle/onchain.js:134,146` `colBuilder.setName(toSnakeCase(name))` | Confirms ponder Postgres columns are **snake_case** (JS `actionType` → column `action_type`) |
| classification | `ponder-runtime/src/handlers/**` + `src/lib/record-action.ts` | append-only (`onConflictDoNothing`) vs additive-rollup (`onConflictDoUpdate`/read-modify-write) — cited per entity |
| classification (no-handler) | `src/handlers/*.ts` (envio source) | For 8 tables ponder defines but does NOT port a handler — classified by envio semantics |

### The core transform shape (applies to all 40)

```
envio  public."PascalTable"."camelColumn"   →   ponder  ponder.snake_table.snake_column
```

- **Table**: PascalCase (quoted) → snake_case literal.
- **Column**: camelCase (quoted, verbatim) → snake_case.
- **Types** (identical; pure cast, NOT drift): envio `BigInt` → ponder `numeric(78,0)` (uint256-safe per SDD §3.2) OR `bigint` (block/timestamp); envio `String` → ponder `text` (or hex-as-text for addresses/hashes); envio `Int` → ponder `integer`; envio `Boolean` → ponder `boolean`.
- **PK**: every ponder table's PK is the single `text` column `id`. T-M2 UPSERTs on `id`.
- **4 NON-rename columns** (real type drift — §3): 3 array→text + 1 jsonb→text.

## 1. Coverage summary

- **40 / 40** in-scope entities mapped fully, column-by-column. **0 columns** unaccounted (no ponder-only, no envio-only column on any in-scope table).
- **Classification**: 14 append-only-event · 14 additive-rollup · 4 rollup-lww-state · 4 append-only-no-handler · 4 additive-rollup-no-handler.
- **Type drift**: 4 columns are NOT pure renames (3× `bigint[]`→text JSON, 1× `jsonb`→text). All other 349 columns are pure snake_case renames with identical/castable types.
- **8 tables have NO ponder handler** — defined in `ponder.schema.ts` but not written by any handler in `ponder-runtime/src/index.ts`. They migrate as **frozen import only**; ponder will not index them forward, so their startBlock policy is informational (see §4).

## 2. startBlock policy by classification (the T-M0 double-count fix)

Per **Appendix B finding 3** (mandatory T-M2 constraint):

| Classification | Handler signature | Overlap re-index safe? | startBlock |
|---|---|---|---|
| append-only-event | `insert(...).onConflictDoNothing()` | YES (PK-collision = SKIP) | `boundary − finalityOverlap` |
| additive-rollup | read-modify-write `+`, `onConflictDoUpdate` counter | NO — re-applies increments → double-count | `boundary` EXACTLY |
| rollup-lww-state | `onConflictDoUpdate`/`update().set()` last-write-wins **state** | Treat as NO (overlap-sensitive; safest = no overlap) | `boundary` EXACTLY |
| *-no-handler | n/a (not indexed forward) | n/a — frozen import only | informational |

Per-chain boundaries (envio `chain_metadata.latest_processed_block`): `eth=25,184,952 · base=46,537,425 · berachain=21,424,739 · optimism=152,132,710`.

## 3. NON-rename columns — the T-M2 risk surface

Only these 4 columns need transform logic beyond a snake_case rename. **Everything else is a pure rename + identical-type copy.**

| ponder table.column | envio source | drift | transform |
|---|---|---|---|
| `badge_holder.holdings` | `BadgeHolder.holdings` (`jsonb`) | jsonb → `text` | serialize JSON value to string (ponder schema.ts:37-39 comment: "envio used Json — we serialize to text") |
| `mibera_loan.token_ids` | `MiberaLoan.tokenIds` (`numeric[]`/`bigint[]`) | array → `text` | `JSON.stringify(ids.map(String))` — uint256-safe (shared.ts:138 `encodeTokenIds`) |
| `paddle_pawn.nft_ids` | `PaddlePawn.nftIds` (`bigint[]`) | array → `text` | `JSON.stringify(ids.map(String))` (paddlefi.ts:117) |
| `paddle_liquidation.nft_ids` | `PaddleLiquidation.nftIds` (`bigint[]`) | array → `text` | `JSON.stringify(ids.map(String))` (paddlefi.ts:192) |

> Note: envio array columns are pg `numeric[]`/`bigint[]`. The T-M2 transform must read them as arrays and re-encode to the JSON-string form ponder's handlers + schema expect. A naive `::text` cast of a pg array yields `{1,2,3}` form, NOT `["1","2","3"]` — so this is real transform logic, not a cast.

## 4. Per-entity column maps (the 40)

Ordered largest-first where row counts are known (Appendix A), then alphabetically. `🔸` marks a non-rename column. `⚠ no-handler` = table not indexed forward by ponder.

### `public."Action"` → `ponder.action`

- **Classification**: append-only-event · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **rows (envio)**: 2,391,463 · **chain(s)**: multi (per chainId col)
- **Evidence**: record-action.ts:105 onConflictDoNothing; + every handler insert(action).onConflictDoNothing()

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `actionType` (text NOT NULL) | `action_type` (text NOT NULL) | rename |
| `actor` (text NOT NULL) | `actor` (text (hex / bytea-as-text) NOT NULL) | rename |
| `primaryCollection` (text NULL) | `primary_collection` (text NULL) | rename |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |
| `txHash` (text NOT NULL) | `tx_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `numeric1` (numeric (BigInt) NULL) | `numeric1` (numeric(78,0) NULL) | rename |
| `numeric2` (numeric (BigInt) NULL) | `numeric2` (numeric(78,0) NULL) | rename |
| `context` (text NULL) | `context` (text NULL) | rename |

### `public."BgtBoostEvent"` → `ponder.bgt_boost_event`  ⚠ no-handler

- **Classification**: append-only (NO ponder handler) · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **rows (envio)**: 1,469,077 · **chain(s)**: berachain
- **Evidence**: ENVIO src/handlers/bgt.ts:100 context.BgtBoostEvent.set() single deterministic id — append. NO ponder handler ports BgtToken:QueueBoost (not in index.ts / config). Frozen-import only.

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `account` (text NOT NULL) | `account` (text (hex / bytea-as-text) NOT NULL) | rename |
| `validatorPubkey` (text NOT NULL) | `validator_pubkey` (text NOT NULL) | rename |
| `amount` (numeric (BigInt) NOT NULL) | `amount` (numeric(78,0) NOT NULL) | rename |
| `transactionFrom` (text NOT NULL) | `transaction_from` (text (hex / bytea-as-text) NOT NULL) | rename |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `blockNumber` (numeric (BigInt) NOT NULL) | `block_number` (bigint (int8) NOT NULL) | rename |
| `transactionHash` (text NOT NULL) | `transaction_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."BadgeAmount"` → `ponder.badge_amount`  ⚠ no-handler

- **Classification**: additive-rollup (NO ponder handler) · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **rows (envio)**: 435,037 · **chain(s)**: berachain
- **Evidence**: ENVIO src/handlers/badges1155.ts:201-224 per-badge amount recompute — derived/rollup. NO ponder handler. Frozen-import only.

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `holder_id` (text NOT NULL) | `holder_id` (text NOT NULL) | rename |
| `badgeId` (text NOT NULL) | `badge_id` (text NOT NULL) | rename |
| `amount` (numeric (BigInt) NOT NULL) | `amount` (numeric(78,0) NOT NULL) | rename |
| `updatedAt` (numeric (BigInt) NOT NULL) | `updated_at` (bigint (int8) NOT NULL) | rename |

### `public."BadgeBalance"` → `ponder.badge_balance`  ⚠ no-handler

- **Classification**: additive-rollup (NO ponder handler) · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **rows (envio)**: 435,037 · **chain(s)**: berachain
- **Evidence**: ENVIO src/handlers/badges1155.ts:108-112 nextBalance=currentBalance+amountDelta — additive-rollup. NO ponder handler. Frozen-import only.

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `holder_id` (text NOT NULL) | `holder_id` (text NOT NULL) | rename |
| `contract` (text NOT NULL) | `contract` (text (hex / bytea-as-text) NOT NULL) | rename |
| `tokenId` (numeric (BigInt) NOT NULL) | `token_id` (numeric(78,0) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |
| `amount` (numeric (BigInt) NOT NULL) | `amount` (numeric(78,0) NOT NULL) | rename |
| `updatedAt` (numeric (BigInt) NOT NULL) | `updated_at` (bigint (int8) NOT NULL) | rename |

### `public."Erc1155MintEvent"` → `ponder.erc1155_mint_event`

- **Classification**: append-only-event · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **rows (envio)**: 131,041 · **chain(s)**: berachain/optimism (multi)
- **Evidence**: mibera-sets.ts:104-118 / mibera-zora.ts:77-91 / puru-apiculture1155.ts:72-86 insert(erc1155MintEvent).onConflictDoNothing()

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `collectionKey` (text NOT NULL) | `collection_key` (text NOT NULL) | rename |
| `tokenId` (numeric (BigInt) NOT NULL) | `token_id` (numeric(78,0) NOT NULL) | rename |
| `value` (numeric (BigInt) NOT NULL) | `value` (numeric(78,0) NOT NULL) | rename |
| `minter` (text NOT NULL) | `minter` (text (hex / bytea-as-text) NOT NULL) | rename |
| `operator` (text NOT NULL) | `operator` (text (hex / bytea-as-text) NOT NULL) | rename |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `blockNumber` (numeric (BigInt) NOT NULL) | `block_number` (bigint (int8) NOT NULL) | rename |
| `transactionHash` (text NOT NULL) | `transaction_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."TrackedHolder"` → `ponder.tracked_holder`

- **Classification**: additive-rollup · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **rows (envio)**: 76,595 · **chain(s)**: multi (per chainId col)
- **Evidence**: mibera-collection.ts:368-369 update(trackedHolder).set({tokenCount: nextCount}); puru-apiculture1155.ts:400-403 same

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `contract` (text NOT NULL) | `contract` (text (hex / bytea-as-text) NOT NULL) | rename |
| `collectionKey` (text NOT NULL) | `collection_key` (text NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |
| `address` (text NOT NULL) | `address` (text (hex / bytea-as-text) NOT NULL) | rename |
| `tokenCount` (integer NOT NULL) | `token_count` (integer (int4) NOT NULL) | rename |

### `public."TrackedTokenBalance"` → `ponder.tracked_token_balance`

- **Classification**: additive-rollup · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **rows (envio)**: 50,788 · **chain(s)**: base (+per chainId col)
- **Evidence**: tracked-erc20.ts:197-202/227-232 update(trackedTokenBalance).set({balance: existing.balance +/- value})

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `address` (text NOT NULL) | `address` (text (hex / bytea-as-text) NOT NULL) | rename |
| `tokenAddress` (text NOT NULL) | `token_address` (text (hex / bytea-as-text) NOT NULL) | rename |
| `tokenKey` (text NOT NULL) | `token_key` (text NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |
| `balance` (numeric (BigInt) NOT NULL) | `balance` (numeric(78,0) NOT NULL) | rename |
| `lastUpdated` (numeric (BigInt) NOT NULL) | `last_updated` (bigint (int8) NOT NULL) | rename |

### `public."MiberaTransfer"` → `ponder.mibera_transfer`

- **Classification**: append-only-event · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **rows (envio)**: 39,728 · **chain(s)**: berachain
- **Evidence**: mibera-collection.ts:98-111 insert(miberaTransfer).onConflictDoNothing()

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `from` (text NOT NULL) | `from` (text (hex / bytea-as-text) NOT NULL) | rename |
| `to` (text NOT NULL) | `to` (text (hex / bytea-as-text) NOT NULL) | rename |
| `tokenId` (numeric (BigInt) NOT NULL) | `token_id` (numeric(78,0) NOT NULL) | rename |
| `isMint` (boolean NOT NULL) | `is_mint` (boolean NOT NULL) | rename |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `blockNumber` (numeric (BigInt) NOT NULL) | `block_number` (bigint (int8) NOT NULL) | rename |
| `transactionHash` (text NOT NULL) | `transaction_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."MintActivity"` → `ponder.mint_activity`

- **Classification**: append-only-event · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **rows (envio)**: 29,538 · **chain(s)**: berachain (+others)
- **Evidence**: mibera-collection.ts:118-135 insert(mintActivity).onConflictDoNothing()

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `user` (text NOT NULL) | `user` (text (hex / bytea-as-text) NOT NULL) | rename |
| `contract` (text NOT NULL) | `contract` (text (hex / bytea-as-text) NOT NULL) | rename |
| `tokenStandard` (text NOT NULL) | `token_standard` (text NOT NULL) | rename |
| `tokenId` (numeric (BigInt) NULL) | `token_id` (numeric(78,0) NULL) | rename |
| `quantity` (numeric (BigInt) NOT NULL) | `quantity` (numeric(78,0) NOT NULL) | rename |
| `amountPaid` (numeric (BigInt) NOT NULL) | `amount_paid` (numeric(78,0) NOT NULL) | rename |
| `activityType` (text NOT NULL) | `activity_type` (text NOT NULL) | rename |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `blockNumber` (numeric (BigInt) NOT NULL) | `block_number` (bigint (int8) NOT NULL) | rename |
| `transactionHash` (text NOT NULL) | `transaction_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `operator` (text NULL) | `operator` (text (hex / bytea-as-text) NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."AquaberaDeposit"` → `ponder.aquabera_deposit`

- **Classification**: append-only-event · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **rows (envio)**: 16,309 · **chain(s)**: berachain
- **Evidence**: aquabera-vault-direct.ts:66-79 insert(aquaberaDeposit).onConflictDoNothing()

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `amount` (numeric (BigInt) NOT NULL) | `amount` (numeric(78,0) NOT NULL) | rename |
| `shares` (numeric (BigInt) NOT NULL) | `shares` (numeric(78,0) NOT NULL) | rename |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `blockNumber` (numeric (BigInt) NOT NULL) | `block_number` (bigint (int8) NOT NULL) | rename |
| `transactionHash` (text NOT NULL) | `transaction_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `from` (text NOT NULL) | `from` (text (hex / bytea-as-text) NOT NULL) | rename |
| `isWallContribution` (boolean NOT NULL) | `is_wall_contribution` (boolean NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."TreasuryActivity"` → `ponder.treasury_activity`

- **Classification**: append-only-event · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **rows (envio)**: 11,819 · **chain(s)**: berachain
- **Evidence**: rfv.ts:65-78 / treasury.ts:73-86 insert(treasuryActivity).onConflictDoNothing()

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `activityType` (text NOT NULL) | `activity_type` (text NOT NULL) | rename |
| `tokenId` (numeric (BigInt) NULL) | `token_id` (numeric(78,0) NULL) | rename |
| `user` (text NULL) | `user` (text (hex / bytea-as-text) NULL) | rename |
| `amount` (numeric (BigInt) NULL) | `amount` (numeric(78,0) NULL) | rename |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `blockNumber` (numeric (BigInt) NOT NULL) | `block_number` (bigint (int8) NOT NULL) | rename |
| `transactionHash` (text NOT NULL) | `transaction_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."BadgeHolder"` → `ponder.badge_holder`  ⚠ no-handler

- **Classification**: additive-rollup (NO ponder handler) · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **rows (envio)**: 8,010 · **chain(s)**: berachain
- **Evidence**: ENVIO src/handlers/badges1155.ts:192-198 totalBadges=nextTotal + holdings accumulation — additive-rollup. NO ponder handler (CubBadges1155 not registered in ponder index.ts). Frozen-import only.

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `address` (text NOT NULL) | `address` (text (hex / bytea-as-text) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |
| `totalBadges` (numeric (BigInt) NOT NULL) | `total_badges` (numeric(78,0) NOT NULL) | rename |
| `totalAmount` (numeric (BigInt) NOT NULL) | `total_amount` (numeric(78,0) NOT NULL) | rename |
| `holdings` (jsonb NOT NULL) | `holdings` (text NOT NULL) | 🔸 **jsonb_to_text** — envio jsonb -> ponder text: serialize JSON to string |
| `updatedAt` (numeric (BigInt) NOT NULL) | `updated_at` (bigint (int8) NOT NULL) | rename |

### `public."AquaberaBuilder"` → `ponder.aquabera_builder`

- **Classification**: additive-rollup · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **rows (envio)**: 7,115 · **chain(s)**: berachain
- **Evidence**: aquabera-vault-direct.ts:86-96 update(aquaberaBuilder).set({totalDeposited: existing+wbera, depositCount: existing+1})

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `address` (text NOT NULL) | `address` (text (hex / bytea-as-text) NOT NULL) | rename |
| `totalDeposited` (numeric (BigInt) NOT NULL) | `total_deposited` (numeric(78,0) NOT NULL) | rename |
| `totalWithdrawn` (numeric (BigInt) NOT NULL) | `total_withdrawn` (numeric(78,0) NOT NULL) | rename |
| `netDeposited` (numeric (BigInt) NOT NULL) | `net_deposited` (numeric(78,0) NOT NULL) | rename |
| `currentShares` (numeric (BigInt) NOT NULL) | `current_shares` (numeric(78,0) NOT NULL) | rename |
| `depositCount` (integer NOT NULL) | `deposit_count` (integer (int4) NOT NULL) | rename |
| `withdrawalCount` (integer NOT NULL) | `withdrawal_count` (integer (int4) NOT NULL) | rename |
| `firstDepositTime` (numeric (BigInt) NULL) | `first_deposit_time` (bigint (int8) NULL) | rename |
| `lastActivityTime` (numeric (BigInt) NOT NULL) | `last_activity_time` (bigint (int8) NOT NULL) | rename |
| `isWallContract` (boolean NOT NULL) | `is_wall_contract` (boolean NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."PremintParticipation"` → `ponder.premint_participation`

- **Classification**: append-only-event · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **rows (envio)**: 5,902 · **chain(s)**: berachain
- **Evidence**: mibera-premint.ts:38-50 insert(premintParticipation).onConflictDoNothing()

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `phase` (numeric (BigInt) NOT NULL) | `phase` (numeric(78,0) NOT NULL) | rename |
| `user` (text NOT NULL) | `user` (text (hex / bytea-as-text) NOT NULL) | rename |
| `amount` (numeric (BigInt) NOT NULL) | `amount` (numeric(78,0) NOT NULL) | rename |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `blockNumber` (numeric (BigInt) NOT NULL) | `block_number` (bigint (int8) NOT NULL) | rename |
| `transactionHash` (text NOT NULL) | `transaction_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."PremintUser"` → `ponder.premint_user`

- **Classification**: additive-rollup · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **rows (envio)**: 5,891 · **chain(s)**: berachain
- **Evidence**: mibera-premint.ts:63-69 update(premintUser).set({totalContributed: existing+amount, participationCount: existing+1})

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `user` (text NOT NULL) | `user` (text (hex / bytea-as-text) NOT NULL) | rename |
| `totalContributed` (numeric (BigInt) NOT NULL) | `total_contributed` (numeric(78,0) NOT NULL) | rename |
| `totalRefunded` (numeric (BigInt) NOT NULL) | `total_refunded` (numeric(78,0) NOT NULL) | rename |
| `netContribution` (numeric (BigInt) NOT NULL) | `net_contribution` (numeric(78,0) NOT NULL) | rename |
| `participationCount` (integer NOT NULL) | `participation_count` (integer (int4) NOT NULL) | rename |
| `refundCount` (integer NOT NULL) | `refund_count` (integer (int4) NOT NULL) | rename |
| `firstParticipationTime` (numeric (BigInt) NULL) | `first_participation_time` (bigint (int8) NULL) | rename |
| `lastActivityTime` (numeric (BigInt) NOT NULL) | `last_activity_time` (bigint (int8) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."MintEvent"` → `ponder.mint_event`  ⚠ no-handler

- **Classification**: append-only (NO ponder handler) · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **rows (envio)**: 3,591 · **chain(s)**: berachain
- **Evidence**: ENVIO src/handlers/mints.ts:75 context.MintEvent.set() single deterministic id — append. NO ponder handler ports GeneralMints to mint_event (GeneralMints contract not registered). Frozen-import only.

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `collectionKey` (text NOT NULL) | `collection_key` (text NOT NULL) | rename |
| `tokenId` (numeric (BigInt) NOT NULL) | `token_id` (numeric(78,0) NOT NULL) | rename |
| `minter` (text NOT NULL) | `minter` (text (hex / bytea-as-text) NOT NULL) | rename |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `blockNumber` (numeric (BigInt) NOT NULL) | `block_number` (bigint (int8) NOT NULL) | rename |
| `transactionHash` (text NOT NULL) | `transaction_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |
| `encodedTraits` (text NULL) | `encoded_traits` (text NULL) | rename |

### `public."MiberaStakedToken"` → `ponder.mibera_staked_token`

- **Classification**: rollup-lww-state · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **rows (envio)**: 1,603 · **chain(s)**: berachain
- **Evidence**: mibera-collection.ts:429-433 insert.onConflictDoUpdate; 476 update().set state-flip (isStaked/withdrawnAt) — NOT additive increment

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `stakingContract` (text NOT NULL) | `staking_contract` (text NOT NULL) | rename |
| `contractAddress` (text NOT NULL) | `contract_address` (text (hex / bytea-as-text) NOT NULL) | rename |
| `tokenId` (numeric (BigInt) NOT NULL) | `token_id` (numeric(78,0) NOT NULL) | rename |
| `owner` (text NOT NULL) | `owner` (text (hex / bytea-as-text) NOT NULL) | rename |
| `isStaked` (boolean NOT NULL) | `is_staked` (boolean NOT NULL) | rename |
| `depositedAt` (numeric (BigInt) NOT NULL) | `deposited_at` (bigint (int8) NOT NULL) | rename |
| `depositTxHash` (text NOT NULL) | `deposit_tx_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `depositBlockNumber` (numeric (BigInt) NOT NULL) | `deposit_block_number` (bigint (int8) NOT NULL) | rename |
| `withdrawnAt` (numeric (BigInt) NULL) | `withdrawn_at` (bigint (int8) NULL) | rename |
| `withdrawTxHash` (text NULL) | `withdraw_tx_hash` (text (hex / bytea-as-text) NULL) | rename |
| `withdrawBlockNumber` (numeric (BigInt) NULL) | `withdraw_block_number` (bigint (int8) NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."TreasuryItem"` → `ponder.treasury_item`

- **Classification**: rollup-lww-state · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **rows (envio)**: 1,551 · **chain(s)**: berachain
- **Evidence**: treasury.ts:147-158/237-245/323-335 update(treasuryItem).set state-flip (isTreasuryOwned/purchased*) — state mutation, not additive

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `tokenId` (numeric (BigInt) NOT NULL) | `token_id` (numeric(78,0) NOT NULL) | rename |
| `isTreasuryOwned` (boolean NOT NULL) | `is_treasury_owned` (boolean NOT NULL) | rename |
| `acquiredAt` (numeric (BigInt) NULL) | `acquired_at` (bigint (int8) NULL) | rename |
| `acquiredVia` (text NULL) | `acquired_via` (text NULL) | rename |
| `acquiredTxHash` (text NULL) | `acquired_tx_hash` (text (hex / bytea-as-text) NULL) | rename |
| `purchasedAt` (numeric (BigInt) NULL) | `purchased_at` (bigint (int8) NULL) | rename |
| `purchasedBy` (text NULL) | `purchased_by` (text (hex / bytea-as-text) NULL) | rename |
| `purchasedTxHash` (text NULL) | `purchased_tx_hash` (text (hex / bytea-as-text) NULL) | rename |
| `purchasePrice` (numeric (BigInt) NULL) | `purchase_price` (numeric(78,0) NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."AquaberaStats"` → `ponder.aquabera_stats`

- **Classification**: additive-rollup · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **chain(s)**: berachain
- **Evidence**: aquabera-vault-direct.ts:121-136 update(aquaberaStats).set({totalBera: existing+wbera, depositCount: existing+1})

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `totalBera` (numeric (BigInt) NOT NULL) | `total_bera` (numeric(78,0) NOT NULL) | rename |
| `totalShares` (numeric (BigInt) NOT NULL) | `total_shares` (numeric(78,0) NOT NULL) | rename |
| `totalDeposited` (numeric (BigInt) NOT NULL) | `total_deposited` (numeric(78,0) NOT NULL) | rename |
| `totalWithdrawn` (numeric (BigInt) NOT NULL) | `total_withdrawn` (numeric(78,0) NOT NULL) | rename |
| `uniqueBuilders` (integer NOT NULL) | `unique_builders` (integer (int4) NOT NULL) | rename |
| `depositCount` (integer NOT NULL) | `deposit_count` (integer (int4) NOT NULL) | rename |
| `withdrawalCount` (integer NOT NULL) | `withdrawal_count` (integer (int4) NOT NULL) | rename |
| `wallContributions` (numeric (BigInt) NOT NULL) | `wall_contributions` (numeric(78,0) NOT NULL) | rename |
| `wallDepositCount` (integer NOT NULL) | `wall_deposit_count` (integer (int4) NOT NULL) | rename |
| `lastUpdateTime` (numeric (BigInt) NOT NULL) | `last_update_time` (bigint (int8) NOT NULL) | rename |
| `chainId` (integer NULL) | `chain_id` (integer (int4) NULL) | rename |

### `public."AquaberaWithdrawal"` → `ponder.aquabera_withdrawal`

- **Classification**: append-only-event · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **chain(s)**: berachain
- **Evidence**: aquabera-vault-direct.ts:199-211 insert(aquaberaWithdrawal).onConflictDoNothing()

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `amount` (numeric (BigInt) NOT NULL) | `amount` (numeric(78,0) NOT NULL) | rename |
| `shares` (numeric (BigInt) NOT NULL) | `shares` (numeric(78,0) NOT NULL) | rename |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `blockNumber` (numeric (BigInt) NOT NULL) | `block_number` (bigint (int8) NOT NULL) | rename |
| `transactionHash` (text NOT NULL) | `transaction_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `from` (text NOT NULL) | `from` (text (hex / bytea-as-text) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."CandiesBacking"` → `ponder.candies_backing`  ⚠ no-handler

- **Classification**: append-only (NO ponder handler) · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **chain(s)**: berachain
- **Evidence**: ENVIO src/handlers/mints1155.ts:64-73 get-then-set dedup-by-txHash, no increment — append/idempotent. NO ponder handler. Frozen-import only.

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `user` (text NOT NULL) | `user` (text (hex / bytea-as-text) NOT NULL) | rename |
| `amount` (numeric (BigInt) NOT NULL) | `amount` (numeric(78,0) NOT NULL) | rename |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."CandiesInventory"` → `ponder.candies_inventory`  ⚠ no-handler

- **Classification**: additive-rollup (NO ponder handler) · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **chain(s)**: berachain
- **Evidence**: ENVIO src/handlers/mints1155.ts:101-109 currentSupply+quantity / mintCount+1 read-modify-write — additive-rollup. NO ponder handler. Frozen-import only.

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `contract` (text NOT NULL) | `contract` (text (hex / bytea-as-text) NOT NULL) | rename |
| `tokenId` (numeric (BigInt) NOT NULL) | `token_id` (numeric(78,0) NOT NULL) | rename |
| `currentSupply` (numeric (BigInt) NOT NULL) | `current_supply` (numeric(78,0) NOT NULL) | rename |
| `mintCount` (integer NOT NULL) | `mint_count` (integer (int4) NOT NULL) | rename |
| `lastMintTime` (numeric (BigInt) NULL) | `last_mint_time` (bigint (int8) NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."DailyRfvSnapshot"` → `ponder.daily_rfv_snapshot`

- **Classification**: rollup-lww-state · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **chain(s)**: berachain
- **Evidence**: rfv.ts:49-61 insert(dailyRfvSnapshot).onConflictDoUpdate(() => ({rfv:newRFV})) — last-write-wins per day, NOT additive

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `day` (integer NOT NULL) | `day` (integer (int4) NOT NULL) | rename |
| `rfv` (numeric (BigInt) NOT NULL) | `rfv` (numeric(78,0) NOT NULL) | rename |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."FriendtechHolder"` → `ponder.friendtech_holder`

- **Classification**: additive-rollup · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **chain(s)**: base
- **Evidence**: friendtech.ts:72-78 update(friendtechHolder).set({balance: newBalance, totalBought: existing+amt})

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `subject` (text NOT NULL) | `subject` (text (hex / bytea-as-text) NOT NULL) | rename |
| `subjectKey` (text NOT NULL) | `subject_key` (text NOT NULL) | rename |
| `holder` (text NOT NULL) | `holder` (text (hex / bytea-as-text) NOT NULL) | rename |
| `balance` (integer NOT NULL) | `balance` (integer (int4) NOT NULL) | rename |
| `totalBought` (integer NOT NULL) | `total_bought` (integer (int4) NOT NULL) | rename |
| `totalSold` (integer NOT NULL) | `total_sold` (integer (int4) NOT NULL) | rename |
| `firstTradeTime` (numeric (BigInt) NULL) | `first_trade_time` (bigint (int8) NULL) | rename |
| `lastTradeTime` (numeric (BigInt) NOT NULL) | `last_trade_time` (bigint (int8) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."FriendtechSubjectStats"` → `ponder.friendtech_subject_stats`

- **Classification**: additive-rollup · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **chain(s)**: base
- **Evidence**: friendtech.ts:108-117 update(friendtechSubjectStats).set({totalTrades: existing+1, totalVolumeEth: existing+eth})

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `subject` (text NOT NULL) | `subject` (text (hex / bytea-as-text) NOT NULL) | rename |
| `subjectKey` (text NOT NULL) | `subject_key` (text NOT NULL) | rename |
| `totalSupply` (numeric (BigInt) NOT NULL) | `total_supply` (numeric(78,0) NOT NULL) | rename |
| `uniqueHolders` (integer NOT NULL) | `unique_holders` (integer (int4) NOT NULL) | rename |
| `totalTrades` (integer NOT NULL) | `total_trades` (integer (int4) NOT NULL) | rename |
| `totalBuys` (integer NOT NULL) | `total_buys` (integer (int4) NOT NULL) | rename |
| `totalSells` (integer NOT NULL) | `total_sells` (integer (int4) NOT NULL) | rename |
| `totalVolumeEth` (numeric (BigInt) NOT NULL) | `total_volume_eth` (numeric(78,0) NOT NULL) | rename |
| `lastTradeTime` (numeric (BigInt) NOT NULL) | `last_trade_time` (bigint (int8) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."FriendtechTrade"` → `ponder.friendtech_trade`

- **Classification**: append-only-event · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **chain(s)**: base
- **Evidence**: friendtech.ts:45-61 insert(friendtechTrade).onConflictDoNothing()

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `trader` (text NOT NULL) | `trader` (text (hex / bytea-as-text) NOT NULL) | rename |
| `subject` (text NOT NULL) | `subject` (text (hex / bytea-as-text) NOT NULL) | rename |
| `subjectKey` (text NOT NULL) | `subject_key` (text NOT NULL) | rename |
| `isBuy` (boolean NOT NULL) | `is_buy` (boolean NOT NULL) | rename |
| `shareAmount` (numeric (BigInt) NOT NULL) | `share_amount` (numeric(78,0) NOT NULL) | rename |
| `ethAmount` (numeric (BigInt) NOT NULL) | `eth_amount` (numeric(78,0) NOT NULL) | rename |
| `supply` (numeric (BigInt) NOT NULL) | `supply` (numeric(78,0) NOT NULL) | rename |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `blockNumber` (numeric (BigInt) NOT NULL) | `block_number` (bigint (int8) NOT NULL) | rename |
| `transactionHash` (text NOT NULL) | `transaction_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."MiberaLoan"` → `ponder.mibera_loan`

- **Classification**: rollup-lww-state · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **chain(s)**: berachain
- **Evidence**: loans.ts:43-60 insert.onConflictDoNothing on create; loans.ts:108-113/treasury.ts:55-60 update().set status-flip (REPAID/DEFAULTED) — state mutation, not additive

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `loanId` (numeric (BigInt) NOT NULL) | `loan_id` (numeric(78,0) NOT NULL) | rename |
| `loanType` (text NOT NULL) | `loan_type` (text NOT NULL) | rename |
| `user` (text NOT NULL) | `user` (text (hex / bytea-as-text) NOT NULL) | rename |
| `tokenIds` (numeric[] / array<bigint> NOT NULL) | `token_ids` (text NOT NULL) | 🔸 **array_to_json_text** — envio array<bigint> (pg numeric[]) -> ponder text: JSON.stringify(ids.map(String)) |
| `amount` (numeric (BigInt) NOT NULL) | `amount` (numeric(78,0) NOT NULL) | rename |
| `expiry` (numeric (BigInt) NOT NULL) | `expiry` (bigint (int8) NOT NULL) | rename |
| `status` (text NOT NULL) | `status` (text NOT NULL) | rename |
| `createdAt` (numeric (BigInt) NOT NULL) | `created_at` (bigint (int8) NOT NULL) | rename |
| `repaidAt` (numeric (BigInt) NULL) | `repaid_at` (bigint (int8) NULL) | rename |
| `defaultedAt` (numeric (BigInt) NULL) | `defaulted_at` (bigint (int8) NULL) | rename |
| `transactionHash` (text NOT NULL) | `transaction_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."MiberaLoanStats"` → `ponder.mibera_loan_stats`

- **Classification**: additive-rollup · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **chain(s)**: berachain
- **Evidence**: shared.ts:112-126 setLoanStats insert.onConflictDoUpdate; loans.ts:64-70 totalActiveLoans+1 / totalLoansCreated+1 read-modify-write

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `totalActiveLoans` (integer NOT NULL) | `total_active_loans` (integer (int4) NOT NULL) | rename |
| `totalLoansCreated` (integer NOT NULL) | `total_loans_created` (integer (int4) NOT NULL) | rename |
| `totalLoansRepaid` (integer NOT NULL) | `total_loans_repaid` (integer (int4) NOT NULL) | rename |
| `totalLoansDefaulted` (integer NOT NULL) | `total_loans_defaulted` (integer (int4) NOT NULL) | rename |
| `totalAmountLoaned` (numeric (BigInt) NOT NULL) | `total_amount_loaned` (numeric(78,0) NOT NULL) | rename |
| `totalNftsWithLoans` (integer NOT NULL) | `total_nfts_with_loans` (integer (int4) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."MiberaOrder"` → `ponder.mibera_order`  ⚠ no-handler

- **Classification**: append-only (NO ponder handler) · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **chain(s)**: berachain
- **Evidence**: ENVIO src/handlers/mints1155.ts:35-45 context.MiberaOrder.set() append. NO ponder handler (CandiesMarket1155 not registered in ponder index.ts). Frozen-import only.

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `user` (text NOT NULL) | `user` (text (hex / bytea-as-text) NOT NULL) | rename |
| `tokenId` (numeric (BigInt) NOT NULL) | `token_id` (numeric(78,0) NOT NULL) | rename |
| `amount` (numeric (BigInt) NOT NULL) | `amount` (numeric(78,0) NOT NULL) | rename |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `blockNumber` (numeric (BigInt) NOT NULL) | `block_number` (bigint (int8) NOT NULL) | rename |
| `transactionHash` (text NOT NULL) | `transaction_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."MiberaStaker"` → `ponder.mibera_staker`

- **Classification**: additive-rollup · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **chain(s)**: berachain
- **Evidence**: mibera-collection.ts:439-443 update(miberaStaker).set({currentStakedCount: existing+1, totalDeposits: existing+1})

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `stakingContract` (text NOT NULL) | `staking_contract` (text NOT NULL) | rename |
| `contractAddress` (text NOT NULL) | `contract_address` (text (hex / bytea-as-text) NOT NULL) | rename |
| `address` (text NOT NULL) | `address` (text (hex / bytea-as-text) NOT NULL) | rename |
| `currentStakedCount` (integer NOT NULL) | `current_staked_count` (integer (int4) NOT NULL) | rename |
| `totalDeposits` (integer NOT NULL) | `total_deposits` (integer (int4) NOT NULL) | rename |
| `totalWithdrawals` (integer NOT NULL) | `total_withdrawals` (integer (int4) NOT NULL) | rename |
| `firstDepositTime` (numeric (BigInt) NULL) | `first_deposit_time` (bigint (int8) NULL) | rename |
| `lastActivityTime` (numeric (BigInt) NOT NULL) | `last_activity_time` (bigint (int8) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."NftBurn"` → `ponder.nft_burn`

- **Classification**: append-only-event · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **chain(s)**: berachain/ethereum
- **Evidence**: mibera-collection.ts:177-189 insert(nftBurn).onConflictDoNothing()

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `collectionKey` (text NOT NULL) | `collection_key` (text NOT NULL) | rename |
| `tokenId` (numeric (BigInt) NOT NULL) | `token_id` (numeric(78,0) NOT NULL) | rename |
| `from` (text NOT NULL) | `from` (text (hex / bytea-as-text) NOT NULL) | rename |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `blockNumber` (numeric (BigInt) NOT NULL) | `block_number` (bigint (int8) NOT NULL) | rename |
| `transactionHash` (text NOT NULL) | `transaction_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."NftBurnStats"` → `ponder.nft_burn_stats`

- **Classification**: additive-rollup · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **chain(s)**: berachain/ethereum
- **Evidence**: mibera-collection.ts:194-201 update(nftBurnStats).set({totalBurned: existing.totalBurned + 1})

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |
| `collectionKey` (text NOT NULL) | `collection_key` (text NOT NULL) | rename |
| `totalBurned` (integer NOT NULL) | `total_burned` (integer (int4) NOT NULL) | rename |
| `uniqueBurners` (integer NOT NULL) | `unique_burners` (integer (int4) NOT NULL) | rename |
| `lastBurnTime` (numeric (BigInt) NULL) | `last_burn_time` (bigint (int8) NULL) | rename |
| `firstBurnTime` (numeric (BigInt) NULL) | `first_burn_time` (bigint (int8) NULL) | rename |

### `public."PaddleBorrower"` → `ponder.paddle_borrower`

- **Classification**: additive-rollup · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **chain(s)**: berachain
- **Evidence**: paddlefi.ts:129-134 update(paddleBorrower).set({totalNftsPawned: existing+len, pawnCount: existing+1})

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `address` (text NOT NULL) | `address` (text (hex / bytea-as-text) NOT NULL) | rename |
| `totalNftsPawned` (integer NOT NULL) | `total_nfts_pawned` (integer (int4) NOT NULL) | rename |
| `currentNftsPawned` (integer NOT NULL) | `current_nfts_pawned` (integer (int4) NOT NULL) | rename |
| `pawnCount` (integer NOT NULL) | `pawn_count` (integer (int4) NOT NULL) | rename |
| `firstPawnTime` (numeric (BigInt) NULL) | `first_pawn_time` (bigint (int8) NULL) | rename |
| `lastActivityTime` (numeric (BigInt) NOT NULL) | `last_activity_time` (bigint (int8) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."PaddleLiquidation"` → `ponder.paddle_liquidation`

- **Classification**: append-only-event · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **chain(s)**: berachain
- **Evidence**: paddlefi.ts:185-198 insert(paddleLiquidation).onConflictDoNothing()

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `liquidator` (text NOT NULL) | `liquidator` (text (hex / bytea-as-text) NOT NULL) | rename |
| `borrower` (text NOT NULL) | `borrower` (text (hex / bytea-as-text) NOT NULL) | rename |
| `repayAmount` (numeric (BigInt) NOT NULL) | `repay_amount` (numeric(78,0) NOT NULL) | rename |
| `nftIds` (numeric[] / array<bigint> NOT NULL) | `nft_ids` (text NOT NULL) | 🔸 **array_to_json_text** — envio array<bigint> (pg numeric[]) -> ponder text: JSON.stringify(ids.map(String)) |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `blockNumber` (numeric (BigInt) NOT NULL) | `block_number` (bigint (int8) NOT NULL) | rename |
| `transactionHash` (text NOT NULL) | `transaction_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."PaddlePawn"` → `ponder.paddle_pawn`

- **Classification**: append-only-event · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **chain(s)**: berachain
- **Evidence**: paddlefi.ts:112-123 insert(paddlePawn).onConflictDoNothing()

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `borrower` (text NOT NULL) | `borrower` (text (hex / bytea-as-text) NOT NULL) | rename |
| `nftIds` (numeric[] / array<bigint> NOT NULL) | `nft_ids` (text NOT NULL) | 🔸 **array_to_json_text** — envio array<bigint> (pg numeric[]) -> ponder text: JSON.stringify(ids.map(String)) |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `blockNumber` (numeric (BigInt) NOT NULL) | `block_number` (bigint (int8) NOT NULL) | rename |
| `transactionHash` (text NOT NULL) | `transaction_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."PaddleSupplier"` → `ponder.paddle_supplier`

- **Classification**: additive-rollup · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **chain(s)**: berachain
- **Evidence**: paddlefi.ts:58-63 update(paddleSupplier).set({totalSupplied: existing+mintAmount, supplyCount: existing+1})

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `address` (text NOT NULL) | `address` (text (hex / bytea-as-text) NOT NULL) | rename |
| `totalSupplied` (numeric (BigInt) NOT NULL) | `total_supplied` (numeric(78,0) NOT NULL) | rename |
| `totalPTokens` (numeric (BigInt) NOT NULL) | `total_p_tokens` (numeric(78,0) NOT NULL) | rename |
| `supplyCount` (integer NOT NULL) | `supply_count` (integer (int4) NOT NULL) | rename |
| `firstSupplyTime` (numeric (BigInt) NULL) | `first_supply_time` (bigint (int8) NULL) | rename |
| `lastActivityTime` (numeric (BigInt) NOT NULL) | `last_activity_time` (bigint (int8) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."PaddleSupply"` → `ponder.paddle_supply`

- **Classification**: append-only-event · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **chain(s)**: berachain
- **Evidence**: paddlefi.ts:40-52 insert(paddleSupply).onConflictDoNothing()

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `minter` (text NOT NULL) | `minter` (text (hex / bytea-as-text) NOT NULL) | rename |
| `mintAmount` (numeric (BigInt) NOT NULL) | `mint_amount` (numeric(78,0) NOT NULL) | rename |
| `mintTokens` (numeric (BigInt) NOT NULL) | `mint_tokens` (numeric(78,0) NOT NULL) | rename |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `blockNumber` (numeric (BigInt) NOT NULL) | `block_number` (bigint (int8) NOT NULL) | rename |
| `transactionHash` (text NOT NULL) | `transaction_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."PremintPhaseStats"` → `ponder.premint_phase_stats`

- **Classification**: additive-rollup · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **chain(s)**: berachain
- **Evidence**: mibera-premint.ts:100-106 update(premintPhaseStats).set({totalContributed: phaseTotal+amount, participationCount: existing+1})

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `phase` (numeric (BigInt) NOT NULL) | `phase` (numeric(78,0) NOT NULL) | rename |
| `totalContributed` (numeric (BigInt) NOT NULL) | `total_contributed` (numeric(78,0) NOT NULL) | rename |
| `totalRefunded` (numeric (BigInt) NOT NULL) | `total_refunded` (numeric(78,0) NOT NULL) | rename |
| `netContribution` (numeric (BigInt) NOT NULL) | `net_contribution` (numeric(78,0) NOT NULL) | rename |
| `uniqueParticipants` (integer NOT NULL) | `unique_participants` (integer (int4) NOT NULL) | rename |
| `participationCount` (integer NOT NULL) | `participation_count` (integer (int4) NOT NULL) | rename |
| `refundCount` (integer NOT NULL) | `refund_count` (integer (int4) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."PremintRefund"` → `ponder.premint_refund`

- **Classification**: append-only-event · **startBlock**: `boundary − finalityOverlap` · **PK**: `id` · **chain(s)**: berachain
- **Evidence**: mibera-premint.ts:157-169 insert(premintRefund).onConflictDoNothing()

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `phase` (numeric (BigInt) NOT NULL) | `phase` (numeric(78,0) NOT NULL) | rename |
| `user` (text NOT NULL) | `user` (text (hex / bytea-as-text) NOT NULL) | rename |
| `amount` (numeric (BigInt) NOT NULL) | `amount` (numeric(78,0) NOT NULL) | rename |
| `timestamp` (numeric (BigInt) NOT NULL) | `timestamp` (bigint (int8) NOT NULL) | rename |
| `blockNumber` (numeric (BigInt) NOT NULL) | `block_number` (bigint (int8) NOT NULL) | rename |
| `transactionHash` (text NOT NULL) | `transaction_hash` (text (hex / bytea-as-text) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

### `public."TreasuryStats"` → `ponder.treasury_stats`

- **Classification**: additive-rollup · **startBlock**: `boundary` EXACTLY (no overlap) · **PK**: `id` · **chain(s)**: berachain
- **Evidence**: shared.ts:92-107 setStats insert.onConflictDoUpdate; treasury.ts:182-184 totalItemsOwned+1 read-modify-write

| envio column (type) | → ponder column (type) | transform |
|---|---|---|
| `id` (text NOT NULL) | `id` (text NOT NULL PK) | rename |
| `totalItemsOwned` (integer NOT NULL) | `total_items_owned` (integer (int4) NOT NULL) | rename |
| `totalItemsEverOwned` (integer NOT NULL) | `total_items_ever_owned` (integer (int4) NOT NULL) | rename |
| `totalItemsSold` (integer NOT NULL) | `total_items_sold` (integer (int4) NOT NULL) | rename |
| `realFloorValue` (numeric (BigInt) NOT NULL) | `real_floor_value` (numeric(78,0) NOT NULL) | rename |
| `lastRfvUpdate` (numeric (BigInt) NULL) | `last_rfv_update` (bigint (int8) NULL) | rename |
| `lastActivityAt` (numeric (BigInt) NOT NULL) | `last_activity_at` (bigint (int8) NOT NULL) | rename |
| `chainId` (integer NOT NULL) | `chain_id` (integer (int4) NOT NULL) | rename |

## 5. Out-of-scope classification (envio-only + ponder-only + gaps)

Source: `schema.graphql` (97 user entities total) cross-checked against the 40 in-scope set and Appendix A's out-of-scope lists.

### 5.1 Envio-only user entities → green-belt-deferred (B-1)

All of the following exist in envio `schema.graphql` but have **no** in-scope ponder table. Each is correctly **green-belt-deferred** (Henlo / ApDAO / FatBera / Candies-trade / validator-rewards / Set&Forgetti vaults / Mirror / HoneyJar / generic Token-Holder-Mint-Transfer / cross-chain vault). 53 entities:

| Group | Entities |
|---|---|
| Validator / FatBera (green) | `ValidatorBlockRewards`, `ValidatorDeposits`, `ValidatorWithdrawalTotals`, `LatestValidatorDeposit`, `LatestValidatorReward`, `WithdrawalBatch`, `WithdrawalRequest`, `WithdrawalFulfillment`, `FatBeraDeposit` |
| Henlo burn/holder/vault (green) | `HenloBurn`, `HenloBurnStats`, `HenloGlobalBurnStats`, `HenloBurner`, `HenloSourceBurner`, `HenloChainBurner`, `HenloHolder`, `HenloHolderStats`, `HenloVaultRound`, `HenloVaultDeposit`, `HenloVaultBalance`, `HenloVaultEpoch`, `HenloVaultStats`, `HenloVaultUser` |
| ApDAO auction (green) | `ApdaoAuction`, `ApdaoAuctionStats`, `ApdaoBid`, `ApdaoQueuedToken` |
| Set & Forgetti vaults (green) | `SFPosition`, `SFVaultStats`, `SFMultiRewardsPosition`, `SFVaultStrategy`, `LatestVaultStrategy` |
| Mirror articles (green) | `MirrorArticlePurchase`, `MirrorArticleStats` |
| HoneyJar NFT raw (green) | `HoneyJar_Approval`, `HoneyJar_ApprovalForAll`, `HoneyJar_BaseURISet`, `HoneyJar_OwnershipTransferred`, `HoneyJar_SetGenerated`, `HoneyJar_Transfer` |
| Moneycomb / HJ vaults (green) | `Vault`, `VaultActivity`, `UserVaultSummary` |
| Generic collection tracking (green) | `Transfer`, `Token`, `Mint`, `Holder`, `UserBalance`, `CollectionStat`, `GlobalCollectionStat` |
| Trading (green) | `MiberaTrade`, `CandiesTrade`, `TradeStats` |

**Verdict**: all 53 are legitimately out-of-scope per ADR-010 / §2 Decision 2 (Mibera blue-belt = the 40 matched tables; the envio-only entities = the green belt). No action for this sprint.

### 5.2 Ponder-only tables → runtime-excluded

| ponder table | reason |
|---|---|
| `pending_emits` | NATS outbox, created/written at runtime (`outbox-flush.ts` + `reorg-safe-emit.ts`). No envio source. Correctly runtime-excluded (Appendix A). Do NOT migrate. |
| `dead_letter_emits` | NATS DLQ, runtime-only (T-A2.9). No envio source. Correctly runtime-excluded. Do NOT migrate. |

### 5.3 GAPS the spec missed (flagged per mission)

1. **Envio-internal raw tables — in NEITHER list.** `Block`, `Transaction`, `AggregatedBlock`, `AggregatedTransaction` appear in envio's blue Postgres but are **not** in `schema.graphql` (they are HyperIndex internal raw-data tables produced by `field_selection` / raw-events config, not user entities). They are neither in the 40 in-scope NOR explicitly named in Appendix A's out-of-scope lists. **Resolution: correctly EXCLUDE** — they are envio engine internals, not Mibera dataset entities. T-M2 must skip them (a `public.*` table dump that naively enumerates all tables would otherwise pull them in).

2. **`CandiesHolderBalance` named in spec but does not exist.** Appendix A's green-belt list names `CandiesHolderBalance`, but no such entity exists in `schema.graphql` (the candies entities are `CandiesInventory` (in-scope), `CandiesBacking` (in-scope), `CandiesTrade` (green)). Minor spec inaccuracy; no migration impact (nothing to defer that isn't already covered).

3. **8 in-scope ponder tables have NO ponder handler** — `badge_holder`, `badge_amount`, `badge_balance`, `bgt_boost_event`, `candies_inventory`, `candies_backing`, `mibera_order`, `mint_event`. They are defined in `ponder.schema.ts` and the envio source has the data (~1.9M rows across bgt_boost_event + badges + candies + mint_event), but the corresponding contracts/handlers are **not registered** in `ponder-runtime/src/index.ts` (CubBadges1155, BgtToken:QueueBoost, CandiesMarket1155→MiberaOrder, GeneralMints→mint_event are not wired). **Implication for T-M2/T-M4**: these tables can be frozen-imported (data exists in envio blue), but ponder will NOT index them forward — the live timeline for these 8 entities stops at the boundary. The T-M3 live-overlap validation cannot apply to them (no ponder-from-chain output to diff). **Operator decision needed** before T-M4 cutover: either (a) accept these 8 as frozen-only (consumers read history but no new rows post-boundary), or (b) register the missing contracts/handlers so they index forward. This is the single most material finding for cutover planning.

## 6. T-M2 handoff checklist

- Load `t-m1-entity-column-map.yaml` programmatically. Per entity: `envio_table`, `ponder_table`, `columns[]`, `pk`, `classification`, `start_block_policy`.
- For each `transform: rename` column → direct copy with snake_case alias + type cast (BigInt→numeric(78,0)/bigint, String→text, etc.).
- For the 4 `transform: array_to_json_text` / `jsonb_to_text` columns → apply the JSON re-encode (do NOT `::text`-cast a pg array).
- UPSERT on `id` (idempotent — re-runnable + tolerant of T-M3 overlap).
- Set ponder `startBlock` per chain per the `start_block_policy`: append-only → `boundary − finalityOverlap`; additive-rollup + rollup-lww → `boundary` EXACTLY.
- EXCLUDE: `pending_emits`, `dead_letter_emits` (runtime), and the envio-internal `Block`/`Transaction`/`AggregatedBlock`/`AggregatedTransaction` raw tables.
- FLAG to operator: the 8 no-handler tables (frozen-only vs wire-the-handler decision) before T-M4.
