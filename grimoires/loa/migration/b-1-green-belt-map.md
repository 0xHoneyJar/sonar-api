# B-1 — Green-belt entity + column map (human-readable)

**Cycle**: `sonar-ponder-migration-v1` · **Task**: B-1 (SCOPING / FOUNDATION)
**Status**: SPEC — static schema/code analysis only. NO database touched, NO code executed.
**Branch**: `spike/b-1-green-belt-mapping` (off `spike/t-m2-transform`)
**Mirrors**: `grimoires/loa/migration/t-m1-entity-column-map.{md,yaml}` (the 40-Mibera Sprint-M map).
**Machine-readable companion**: `b-1-green-belt-map.yaml` (single source of truth for the transform extension).

---

## 0. Definition

> **Green belt = ALL envio entities (`schema.graphql`) MINUS the 40 Mibera in-scope (T-M1).**

- `schema.graphql` defines **93** envio entity types (grounded: `grep '^type' schema.graphql`, digit-aware).
- T-M1 mapped **40** Mibera in-scope entities.
- **93 − 40 = 53 green-belt entities.**

Per the Sprint-M spec §1 Non-Goals: "NOT migrating the green-belt entities (Henlo / ApDAO / FatBera / Candies / Aquabera-wall / validator-rewards / generic Transfer-Token-Holder-Mint). Those are Sprint B-1." This artifact IS that B-1 map.

### Live vs Dead

| | count | meaning |
|---|---|---|
| **LIVE** | **43** | an envio handler writes the entity (has rows in blue 3vIC) → in scope for B-1 import + schema additions |
| **DEAD** | **10** | defined in `schema.graphql` but **NO handler writes it** (0 `context.<Entity>.` writer files in `src/`) → 0 rows → **excluded** from import and from `ponder.schema.ts` |

**Dead entities (10) — verified 0 writers, EXCLUDE:**
`CandiesTrade`, `MiberaTrade`, `TradeStats` (trading-system; both source contracts commented-out in `config.yaml:844-850`), `GlobalCollectionStat` (type-referenced in `honey-jar-nfts.ts` but never `.set`), and the 6 `HoneyJar_*` auto-scaffold event entities (`HoneyJar_Approval`, `HoneyJar_ApprovalForAll`, `HoneyJar_BaseURISet`, `HoneyJar_OwnershipTransferred`, `HoneyJar_SetGenerated`, `HoneyJar_Transfer` — the live HJ transfer write goes to the generic `Transfer`/`Mint`/`Token`/`Holder`).

> **Pre-import VERIFY (operator-paired session, read-only):** confirm each dead entity is `count(*) = 0` in blue 3vIC. If any has rows, a write path exists that static analysis missed — escalate before excluding.

---

## 1. Grounding (no inferred columns)

- **Envio columns** — from `schema.graphql` (entity defs) cross-checked against `generated/src/Indexer.res` ReScript `type t` records (the canonical Postgres column shapes). Columns are camelCase **verbatim**; relation fields carry the `_id` suffix (e.g. `WithdrawalRequest.batch → batch_id`, `Indexer.res:813`).
- **Ponder columns** — **PROPOSED.** `ponder.schema.ts` today has **exactly the 40 Mibera `onchainTable` defs** (42 incl. the 2 runtime-excluded `pending_emits`/`dead_letter_emits`) and **ZERO** green-belt tables (verified). snake_case names follow ponder's `onchain.js` `toSnakeCase` (the same rule the 40 used). Every PK is the single text column `id`; UPSERT on `id`.

---

## 2. Type-drift (transforms beyond pure snake_case rename)

The 40-Mibera set had **4** drift columns (1 `jsonb→text`, 3 `bigint[]→text`). The green belt introduces **a new drift class** plus more array columns:

| Drift | Columns | Transform | Notes |
|---|---|---|---|
| **`timestamp_to_bigint`** ⚠ NEW | `validator_block_rewards.timestamp`, `validator_deposits.timestamp`, `latest_validator_deposit.timestamp`, `latest_validator_reward.timestamp`, `validator_withdrawal_totals.last_withdrawal_timestamp`, `withdrawal_batch.start_time`, `withdrawal_request.timestamp`, `withdrawal_fulfillment.timestamp` (**8 columns**) | `EXTRACT(EPOCH FROM ts)::bigint` (or `Math.floor(date.getTime()/1000)`) | envio's `Timestamp` GraphQL scalar is stored as `Js.Date.t` ⇒ Postgres `timestamp`/`timestamptz`, **NOT bigint**. Ponder target is `bigint` epoch-seconds (matches every other time column + what Score expects). The 40-Mibera set had **zero** Timestamp-scalar columns — this drift is **green-belt-only** and concentrated in the validator/withdrawal family. Grounded: `Indexer.res:764,771,482,489,778,799,806,813` (`Js.Date.t`). ⚠ `ValidatorBlockRewards.nextTimestamp` and `FatBeraDeposit.timestamp` and `ApdaoAuction.startTime` are **BigInt** in the schema (NOT the Timestamp scalar) → pure rename; do not over-convert. |
| **`array_to_json_text`** | `withdrawal_batch.user_addresses` (**string[]** — NEW variant) | `JSON.stringify(addresses)` — NOT a `::text` cast | the 40-set's 3 array columns were `bigint[]`; this is the first **`string[]`** (`array<string>`, `Indexer.res:799`). Same rule: produce a JSON array-of-strings, never the pg `{a,b}` literal. |

No `jsonb→text` columns in the green belt (the only envio `Json!` field, `BadgeHolder.holdings`, is in the 40-Mibera set, not the green belt).

---

## 3. Entity groups (43 live, by community / contract-family)

Full column-by-column detail is in the YAML. Summary of group → chains → entities → handler:

| Group | Community | Chain(s) | Live entities | Envio handler(s) | Notable |
|---|---|---|---|---|---|
| **A** | validator-rewards | berachain | 9: `ValidatorBlockRewards`, `ValidatorDeposits`, `LatestValidatorDeposit`, `LatestValidatorReward`, `ValidatorWithdrawalTotals`, `WithdrawalBatch`, `WithdrawalRequest`, `WithdrawalFulfillment`, `FatBeraDeposit` | `src/handlers/fatbera.ts` (24KB) | **`ValidatorBlockRewards` = 906,771 rows** (largest green-belt entity). **All `timestamp_to_bigint` drift + the `user_addresses` string[] drift live here.** |
| **B** | honeyjar-genesis | **6 chains** (eth/arb/zora/op/base/bera) | 6: `Transfer`, `Token`, `Mint`, `Holder`, `UserBalance`, `CollectionStat` | `src/handlers/honey-jar-nfts.ts` (+ `crayons.ts` also writes `Transfer`) | the generic NFT entities. `Transfer` 354,492 · `Token` 130,921 · `Mint` 105,622 · `Holder` 49,237 · `UserBalance` 35,968. **Introduces Arbitrum + Zora** (new chains). |
| **C** | moneycomb-vault | berachain | 3: `Vault`, `VaultActivity`, `UserVaultSummary` | `src/handlers/moneycomb-vault.ts` | HJ-burn vault. |
| **D** | henlo (holder+burn) | base, berachain | 8: `HenloHolder`, `HenloHolderStats`, `HenloBurn`, `HenloBurnStats`, `HenloGlobalBurnStats`, `HenloBurner`, `HenloChainBurner`, `HenloSourceBurner` | `src/handlers/tracked-erc20/holder-stats.ts` + `burn-tracking.ts` | `HenloHolder` 46,073. Same `TrackedErc20` contract whose `tracked_token_balance` is already in the 40 — only the `Henlo*` derivatives are the gap. |
| **E** | henlo (HENLOCKER vault) | berachain | 6: `HenloVaultRound`, `HenloVaultDeposit`, `HenloVaultBalance`, `HenloVaultEpoch`, `HenloVaultStats`, `HenloVaultUser` | `src/handlers/henlo-vault.ts` (14KB) | HENLOCKED round/epoch system. |
| **F** | set-and-forgetti | berachain | 5: `SFPosition`, `SFVaultStats`, `SFMultiRewardsPosition`, `SFVaultStrategy`, `LatestVaultStrategy` | `src/handlers/sf-vaults.ts` (**40KB — largest handler**) | strategy-migration-aware vault staking. |
| **G** | apdao | berachain | 4: `ApdaoAuction`, `ApdaoBid`, `ApdaoQueuedToken`, `ApdaoAuctionStats` | `src/handlers/apdao-auction.ts` (7.5KB) | ApiologyDAO seat auctions. `ApdaoBid` 2,692. (origin branch `feat/apdao-seat-tracked` exists.) |
| **H** | mirror | optimism | 2: `MirrorArticlePurchase`, `MirrorArticleStats` | `src/handlers/mirror-observability.ts` | WritingEditions article purchases. |

> **Candies note:** the Sprint-M spec Appendix A green-belt list named `CandiesHolderBalance` and `CandiesTrade`. T-M1 Appendix C already flagged `CandiesHolderBalance` does not exist as an envio entity. `CandiesTrade` IS in `schema.graphql` but is **dead** (contract commented out). The Candies entities that DO have rows (`CandiesInventory`, `CandiesBacking`) are in the **40-Mibera set**, not the green belt.

---

## 4. Classification (operationalizes the T-M0 double-count finding)

Per T-M0 Appendix B finding 3: `startBlock = boundary − finalityOverlap` ONLY for entities whose handler is **append-only** (re-indexing the overlap is a safe `onConflictDoNothing` no-op). **additive-rollup / last-write-wins-state** entities use `startBlock = boundary` EXACTLY (no overlap) to avoid double-counting baked-in totals.

Of the 43 live green-belt entities:

| Classification | count | startBlock policy | examples |
|---|---|---|---|
| append (event log) | 9 | `boundary − finalityOverlap` | `Transfer`, `Mint`, `ApdaoBid`, `HenloBurn`, `HenloVaultDeposit`, `MirrorArticlePurchase`, `FatBeraDeposit`, `VaultActivity`, `WithdrawalRequest`/`WithdrawalFulfillment` (7+2) |
| append-running (cumulative-carry) | 2 | `boundary` EXACTLY | `ValidatorBlockRewards`, `ValidatorDeposits` — append-keyed but each row copies running totals from prior; safe-replay only if prior present → treat as no-overlap |
| rollup (additive counter) | 17 | `boundary` EXACTLY | `Holder`, `CollectionStat`, `UserBalance`, all `*Stats`, `HenloVaultBalance/Round/Epoch`, `SF*`, `ApdaoAuctionStats`, `ValidatorWithdrawalTotals`, … |
| rollup-lww (state mutation) | 15 | `boundary` EXACTLY | `Token`, `Vault`, `HenloHolder`, `HenloBurner`/`ChainBurner`/`SourceBurner`, `Latest*`, `SFVaultStrategy`, `ApdaoAuction`/`QueuedToken`, `WithdrawalBatch`, … |

**Per-contract reduction (mirrors T-M2 finding):** `startBlock` is set per-**contract** but the double-count rule is per-**entity**. A contract gets overlap ONLY if every entity its events write is append-only. Most green-belt contracts touch at least one rollup → pinned to `boundary` exactly. The clean append-only candidates: HoneyJar/Honeycomb contracts write the rollup `Holder`/`Token`/`CollectionStat`/`UserBalance` alongside append `Transfer`/`Mint`, so they pin to `boundary`; `MirrorObservability` writes append `MirrorArticlePurchase` + rollup `MirrorArticleStats` → `boundary`. **Net: nearly all green-belt contracts pin to `boundary` exactly; the live-overlap diff (validation) has almost no append-only-pure surface — count+checksum parity is the universal backstop (same conclusion T-M2 reached for Mibera).**

---

## 5. The handler-gap headline

**All 43 live green-belt entities have ZERO ponder handlers today.** `ponder-runtime/src/index.ts` registers only 15 Mibera-set handler files; none write a green-belt entity. So B-1's real work is **porting ~8 envio handler files** (one per group) — see `b-1-handler-gap.md`. The frozen-import (transform) is mechanical; the handler ports are the bulk.
