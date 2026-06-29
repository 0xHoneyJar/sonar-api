# B-1 — Handler-gap analysis (THE key B-1 artifact)

**Cycle**: `sonar-ponder-migration-v1` · **Task**: B-1 · **Branch**: `spike/b-1-green-belt-mapping`
**Status**: SPEC — static code analysis only. NO DB, NO code execution.
**Question answered**: for each green-belt entity, does a **ponder** handler exist (in `ponder-runtime/src/handlers/**` AND registered in `ponder-runtime/src/index.ts`), or must one be **PORTED** from the envio handler? This is the real B-1 work estimate.

---

## 0. The headline

> **All 43 live green-belt entities have ZERO ponder handlers. 100% gap.**

Grounded both ways:
- **Ponder side** — `ponder-runtime/src/index.ts` imports exactly **15** handler files (the Mibera set). Inspecting each handler's `insert(...)`/`update(...)` calls: every one writes only a **40-Mibera** table (`aquabera_*`, `friendtech_*`, `mibera_*`, `paddle_*`, `premint_*`, `treasury_*`, `tracked_token_balance`, `nft_burn*`, `daily_rfv_snapshot`, `erc1155_mint_event`, `action`, `pending_emits`/`dead_letter_emits`). **None writes a green-belt entity.**
- **Envio side** — each of the 43 live green-belt entities is written by an envio handler under `src/handlers/`. Those handler files are **not** ported to `ponder-runtime/`.

So the green belt **frozen-imports fine** (the transform is data-only), but **ponder will not index ANY green-belt entity forward** past the boundary until its handler is ported. This is the gating fact for the T-M4-style cutover (see §4).

This mirrors — and is far larger than — the T-M1 Appendix C "OPEN DECISION": there, 8 of the 40 Mibera tables had no forward handler. Here it is **43 of 43**, because the green-belt contracts were deliberately out of A-1's `ponder.config.mibera.ts` scope (the config comment says so: "the green belt (B-1) ports them").

---

## 1. Two-part gap per entity

Each green-belt entity needs **both**:
1. **A ponder handler** ported from the envio source handler (the read-modify-write / insert logic), AND
2. **A contract registration** in `ponder.config.mibera.ts` (the `contracts: { … }` block) — the green-belt contracts are NOT registered today. Most also need a **viem ABI** authored into `abis/` (see §3).

A frozen-imported table with neither = a table that holds history but never updates. That is the **(A) accept-frozen-only** path from T-M1 Appendix C, applied per group.

---

## 2. The gap, grouped by community / contract / chain

Effort key (rough, per the existing A-2 port pattern — `docs/A-2-handler-port-summary.md`): **S** ≈ ½ day (1 small handler file, append entities), **M** ≈ 1 day (a few entities + rollups), **L** ≈ 2–3 days (large handler / many entities / cross-chain / migration logic).

### Group A — validator-rewards / FatBera (Berachain) — **L**
- **Envio handler**: `src/handlers/fatbera.ts` (24KB; 10 event handlers: `handleFatBeraDeposit`, `handleFatBeraRewardAdded`, `handleFatBeraWithdrawalRequested`, `handleFatBeraWithdrawalFulfilled`, `handleFatBeraBatchStarted`, `handleBeaconDeposit`, `handleBlockRewardProcessed`, `handleValidatorDepositRequested`, `handleValidatorWithdrawalRequested`, `handleAutomatedStakeExecution`).
- **Entities (9)**: `validator_block_rewards` (**906,771 rows — the largest single green-belt table**), `validator_deposits`, `latest_validator_deposit`, `latest_validator_reward`, `validator_withdrawal_totals`, `withdrawal_batch`, `withdrawal_request`, `withdrawal_fulfillment`, `fatbera_deposit`.
- **Contracts to register (7)**: `FatBeraDeposits`, `FatBeraAccounting`, `BeaconDeposit`, `BlockRewardController`, `AutomatedStake`, `ValidatorWithdrawalModule`, `ValidatorDepositRouter` (all Berachain; addresses + start_blocks in `config.yaml:856-885`; event sigs in `config.yaml:360-422`).
- **ABIs to author**: FatBeraDeposits (`Deposit`), FatBeraAccounting (`RewardAdded`/`WithdrawalRequested`/`BatchStarted`/`WithdrawalFulfilled`), BeaconDeposit (`Deposit`), BlockRewardController (block-reward event), AutomatedStake, ValidatorWithdrawalModule, ValidatorDepositRouter — none exist in `abis/MiberaAbis.ts`.
- **Why L**: most complex handler (cross-event validator state + reward-split math + the `timestamp_to_bigint` drift on import + the `block_height`-keyed `block_reward_processed` event that produces the 906k rows). The reward path depends on a `LatestValidatorDeposit` lookup → order-sensitive.

### Group B — honeyjar-genesis (6 chains: eth/arb/zora/op/base/bera) — **L**
- **Envio handler**: `src/handlers/honey-jar-nfts.ts` (13KB) + `src/handlers/crayons.ts` (also writes `Transfer`).
- **Entities (6)**: `transfer` (354,492), `token` (130,921), `mint` (105,622), `holder` (49,237), `user_balance` (35,968), `collection_stat`.
- **Contracts to register**: `HoneyJar` (multi-address per chain) + `HoneyJar2Eth`..`HoneyJar5Eth` + `Honeycomb` + `MiladyCollection` (eth, already a 40-Mibera contract for milady burns — confirm no double-write) + `CrayonsFactory`/`CrayonsCollection` (bera). Spans **all 6 chains** — and **introduces Arbitrum (42161) + Zora (7777777)** to `ponder.config`, which today has only 4 chains. New `chains:` entries + new `PONDER_RPC_URL_42161` / `PONDER_RPC_URL_7777777` env + eRPC routes.
- **ABIs**: `Erc721TransferAbi` already exists (reusable for the HJ Transfer/Mint path).
- **Why L**: 6-chain spread (2 new chains), cross-chain `UserBalance` rollup, two writers feeding `transfer`, and the largest row-count group. Cross-chain `user_balance` is the order-sensitive rollup.

### Group C — moneycomb-vault (Berachain) — **M**
- **Envio handler**: `src/handlers/moneycomb-vault.ts` (10KB; `handleAccountOpened`/`Closed`/`HJBurned`/`SharesMinted`/`RewardClaimed`).
- **Entities (3)**: `vault`, `vault_activity`, `user_vault_summary`.
- **Contracts**: `MoneycombVault` (bera, `config.yaml:770-773`) + depends on `Honeycomb` transfers. ABI to author.

### Group D — henlo holder + burn (Base, Berachain) — **M**
- **Envio handlers**: `src/handlers/tracked-erc20/holder-stats.ts` + `tracked-erc20/burn-tracking.ts`.
- **Entities (8)**: `henlo_holder` (46,073), `henlo_holder_stats`, `henlo_burn`, `henlo_burn_stats`, `henlo_global_burn_stats`, `henlo_burner`, `henlo_chain_burner`, `henlo_source_burner`.
- **Contracts**: **`TrackedErc20` is ALREADY registered** (Base + Bera) and the ponder `tracked-erc20.ts` handler is LIVE — but it ports the `tracked_token_balance` path ONLY. The `Henlo*` burn/holder derivatives are the gap: extend the existing handler (no new contract/ABI needed — `Erc20TransferAbi` exists). **Lowest-friction group** (handler extension, not a new contract).

### Group E — HENLOCKER vault (Berachain) — **M**
- **Envio handler**: `src/handlers/henlo-vault.ts` (14KB).
- **Entities (6)**: `henlo_vault_round`, `henlo_vault_deposit`, `henlo_vault_balance`, `henlo_vault_epoch`, `henlo_vault_stats`, `henlo_vault_user`.
- **Contracts**: `HenloVault` (bera, `config.yaml:918-921`). ABI to author. (Note: `henlo-vault.ts` ALSO writes `tracked_token_balance`, already in the 40 — port only the `HenloVault*` paths.)

### Group F — set-and-forgetti vault (Berachain) — **L**
- **Envio handler**: `src/handlers/sf-vaults.ts` (**40KB — the largest handler in the repo**).
- **Entities (5)**: `sf_position`, `sf_vault_stats`, `sf_multi_rewards_position`, `sf_vault_strategy`, `latest_vault_strategy`.
- **Contracts (3)**: `SFVaultERC4626` (5 addrs), `SFMultiRewards` (5 addrs), `SFVaultStrategyWrapper` (5 addrs) — all bera, `config.yaml:891-916`. 3 ABIs to author.
- **Why L**: biggest handler; strategy-migration logic (per-MultiRewards position tracking across old/new contracts) is the hardest to port faithfully.

### Group G — apdao auction-house (Berachain) — **M**
- **Envio handler**: `src/handlers/apdao-auction.ts` (7.5KB; AuctionCreated/Bid/Extended/Settled + queue events).
- **Entities (4)**: `apdao_auction`, `apdao_bid` (2,692), `apdao_queued_token`, `apdao_auction_stats`.
- **Contracts**: `ApdaoAuctionHouse` proxy (bera, `config.yaml:953-956`). ABI to author. **Note**: origin branch `feat/apdao-seat-tracked` exists — check whether an ABI/handler draft is already there to harvest (could drop this to S).

### Group H — mirror articles (Optimism) — **S**
- **Envio handler**: `src/handlers/mirror-observability.ts` (3.5KB; `WritingEditionPurchased`).
- **Entities (2)**: `mirror_article_purchase`, `mirror_article_stats`.
- **Contracts**: `MirrorObservability` (op, `config.yaml:666-668`). Optimism is already a registered chain. Small handler. ABI to author.

---

## 3. ABI gap (a sub-cost of every port)

`abis/MiberaAbis.ts` covers ONLY the 40-Mibera contracts (`MiberaLiquidBackingAbi`, `Erc721TransferAbi`, `PaddleFiAbi`, `BgtTokenAbi`, `Erc1155Abi`, `GeneralMintsAbi`, `SeaportAbi`, `FriendtechSharesAbi`, `Erc20TransferAbi`, `MiberaPremintAbi`, `AquaberaVaultDirectAbi`).

The reusable ones for the green belt: `Erc721TransferAbi` (Group B HJ Transfer/Mint), `Erc20TransferAbi` (Group D, already wired). **Every other green-belt contract needs a new viem ABI authored** — but the event signatures are present **verbatim** in `config.yaml` (e.g. `config.yaml:363` `Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)`), so authoring is mechanical `parseAbi([...])` extraction, exactly how `MiberaAbis.ts` was built. Budget ~1 ABI block per contract (≈9 new contracts/families).

---

## 4. What the gap means for cutover (the unblock)

- The frozen import (transform) makes ponder hold **all green-belt history** immediately — Score/consumers reading those entities see the same data they see today via the bridge.
- But with **no forward handlers**, every green-belt table **freezes at the boundary** (the T-M1 Appendix C "(A) accept-frozen-only" outcome, applied to all 43).
- **The GLOBAL gateway flip (ponder ⊇ blue → non-regressing) requires forward coverage for any green-belt entity a consumer reads live.** So B-1's handler ports are exactly what unblocks retiring the bridge globally (not just for the Mibera 40).
- Recommended sequencing (see `b-1-plan.md`): port by **consumer-criticality** (which green-belt entities does Score / the Quests API actually read live?) first, accept-frozen for inactive contracts, rather than porting all 8 groups before any cutover.

---

## 5. Gap summary table

| Group | Community | Chain(s) | Live entities | Ponder handler exists? | Envio handler to port | Contracts to register | New ABIs | Effort |
|---|---|---|---:|:---:|---|---:|---:|:---:|
| A | validator-rewards | bera | 9 | **NO** | `fatbera.ts` | 7 | 7 | **L** |
| B | honeyjar-genesis | eth/arb/zora/op/base/bera | 6 | **NO** | `honey-jar-nfts.ts` + `crayons.ts` | ~8 (+2 new chains) | 0 (reuse Erc721) | **L** |
| C | moneycomb-vault | bera | 3 | **NO** | `moneycomb-vault.ts` | 1 (+Honeycomb) | 1 | **M** |
| D | henlo holder/burn | base/bera | 8 | **NO** (extend live tracked-erc20) | `tracked-erc20/{holder-stats,burn-tracking}.ts` | 0 (TrackedErc20 already registered) | 0 | **M** |
| E | henlo HENLOCKER vault | bera | 6 | **NO** | `henlo-vault.ts` | 1 | 1 | **M** |
| F | set-and-forgetti | bera | 5 | **NO** | `sf-vaults.ts` (40KB) | 3 | 3 | **L** |
| G | apdao | bera | 4 | **NO** | `apdao-auction.ts` | 1 | 1 (or harvest `feat/apdao-seat-tracked`) | **M** |
| H | mirror | op | 2 | **NO** | `mirror-observability.ts` | 1 | 1 | **S** |
| **Total** | **8 groups** | **6 chains** | **43** | **0 / 43** | **~8 handler files** | **~22 contracts** | **~14 ABIs** | **3×L · 4×M · 1×S** |

**Rough total handler-port effort: ~3×L (≈2.5d each) + 4×M (≈1d each) + 1×S (≈0.5d) ≈ 12 engineer-days of handler+ABI+config work**, before review/audit and the per-group validation. The transform/import itself is a small fraction on top (the entity-map already exists in YAML form). **The handler ports are the bulk of B-1.**
