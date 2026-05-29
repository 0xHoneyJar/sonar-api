// Ponder schema — Mibera blue belt (sonar-ponder-migration-v1 · sprint A-1)
//
// Sources of truth:
//   - SDD: loa-freeside:grimoires/loa/sdd.md §3.2 (uint256-safe), §3.3 (pending_emits)
//   - Cookbook: grimoires/loa/spikes/ponder-api-verification/COOKBOOK.md
//   - envio schema.graphql (filtered to 34 Mibera-belt entities)
//   - Index parity audit: docs/A-1-index-parity-audit.md (T-A1.8)
//
// Conventions applied (all verified in A-0 cookbook):
//   - uint256 token IDs / amounts: `t.numeric({ precision: 78, scale: 0, mode: "bigint" })`
//     (SDD §3.2 SKP-003 HIGH; cookbook §T-A0.6 — Drizzle bigint = Postgres int64 overflows
//      uint256 NFT IDs above 2^63; numeric(78,0) is precision-safe; mode:"bigint" lets
//      handler code write bigint directly without manual .toString() coercion)
//   - addresses: `t.hex()` (viem-typed 0x-prefixed hex, lowercased at handler boundary)
//   - tx hashes: `t.hex()` (32-byte hex)
//   - block-numbers / timestamps: `t.bigint()` (int64-safe; not user-controlled uint256)
//   - boolean flags: `t.boolean()`
//   - JSON blobs: `t.text()` (BadgeHolder.holdings — envio used Json; we serialize string)
//   - implicit PK index: present on every `id` (no need to declare)
//   - explicit @index parity: per docs/A-1-index-parity-audit.md — 7 indexes across 4 tables
//
// Schema namespace control: `DATABASE_SCHEMA=ponder` env var OR `--schema ponder` CLI flag
// (cookbook §C-1). NOT configurable via `createConfig` (verified).

import { onchainTable, index } from "ponder";

// ─────────────────────────────────────────────────────────────────────────
// Badges (CubBadges1155 — Berachain 80094)
// ─────────────────────────────────────────────────────────────────────────

export const badgeHolder = onchainTable("badge_holder", (t) => ({
  id: t.text().primaryKey(),               // address-chainId composite
  address: t.hex().notNull(),
  chainId: t.integer().notNull(),
  totalBadges: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  totalAmount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  // envio used Json — we serialize to text and JSON.parse at handler/read boundary.
  // Drizzle's pg `jsonb` type works but Hasura tracks it cleaner as text for parity.
  holdings: t.text().notNull(),
  updatedAt: t.bigint().notNull(),
}));

export const badgeAmount = onchainTable("badge_amount", (t) => ({
  id: t.text().primaryKey(),
  holderId: t.text().notNull(),            // FK → badge_holder.id (relations declared in handlers/queries)
  badgeId: t.text().notNull(),
  amount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  updatedAt: t.bigint().notNull(),
}));

export const badgeBalance = onchainTable("badge_balance", (t) => ({
  id: t.text().primaryKey(),
  holderId: t.text().notNull(),            // FK → badge_holder.id
  contract: t.hex().notNull(),
  tokenId: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  chainId: t.integer().notNull(),
  amount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  updatedAt: t.bigint().notNull(),
}));

// ─────────────────────────────────────────────────────────────────────────
// BgtToken — boost events (Berachain 80094)
// ─────────────────────────────────────────────────────────────────────────

export const bgtBoostEvent = onchainTable("bgt_boost_event", (t) => ({
  id: t.text().primaryKey(),
  account: t.hex().notNull(),
  validatorPubkey: t.text().notNull(),     // bytes — variable length; text fits
  amount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  transactionFrom: t.hex().notNull(),
  timestamp: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
  chainId: t.integer().notNull(),
}));

// ─────────────────────────────────────────────────────────────────────────
// CandiesMarket1155 — inventory + backing (Berachain 80094)
// ─────────────────────────────────────────────────────────────────────────

export const candiesInventory = onchainTable("candies_inventory", (t) => ({
  id: t.text().primaryKey(),               // contract_tokenId
  contract: t.hex().notNull(),
  tokenId: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  currentSupply: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  mintCount: t.integer().notNull(),
  lastMintTime: t.bigint(),
  chainId: t.integer().notNull(),
}));

export const candiesBacking = onchainTable("candies_backing", (t) => ({
  id: t.text().primaryKey(),               // txHash (deduped by tx)
  user: t.hex().notNull(),
  amount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  timestamp: t.bigint().notNull(),
  chainId: t.integer().notNull(),
}));

// ─────────────────────────────────────────────────────────────────────────
// MiberaLiquidBacking — DailyRfvSnapshot (Berachain 80094)
// ─────────────────────────────────────────────────────────────────────────

export const dailyRfvSnapshot = onchainTable("daily_rfv_snapshot", (t) => ({
  id: t.text().primaryKey(),               // chainId_day
  day: t.integer().notNull(),
  rfv: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  timestamp: t.bigint().notNull(),
  chainId: t.integer().notNull(),
}));

// ─────────────────────────────────────────────────────────────────────────
// MiberaSets / MiberaZora1155 / CandiesMarket1155 / CubBadges1155 — ERC1155 mints
// (envio entity Erc1155MintEvent is written by multiple handlers across chains;
// blue-belt scope covers Berachain 80094 + Optimism legs ported in B-1.
// For A-1 Mibera blue belt we include the table — Mibera handlers do write it.)
// ─────────────────────────────────────────────────────────────────────────

export const erc1155MintEvent = onchainTable("erc1155_mint_event", (t) => ({
  id: t.text().primaryKey(),
  collectionKey: t.text().notNull(),
  tokenId: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  value: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  minter: t.hex().notNull(),
  operator: t.hex().notNull(),
  timestamp: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
  chainId: t.integer().notNull(),
}));

// ─────────────────────────────────────────────────────────────────────────
// FriendtechShares — Base 8453
// ─────────────────────────────────────────────────────────────────────────

export const friendtechTrade = onchainTable("friendtech_trade", (t) => ({
  id: t.text().primaryKey(),               // txHash_logIndex
  trader: t.hex().notNull(),
  subject: t.hex().notNull(),
  subjectKey: t.text().notNull(),
  isBuy: t.boolean().notNull(),
  shareAmount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  ethAmount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  supply: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  timestamp: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
  chainId: t.integer().notNull(),
}));

export const friendtechHolder = onchainTable("friendtech_holder", (t) => ({
  id: t.text().primaryKey(),               // subject_trader_chainId
  subject: t.hex().notNull(),
  subjectKey: t.text().notNull(),
  holder: t.hex().notNull(),
  balance: t.integer().notNull(),
  totalBought: t.integer().notNull(),
  totalSold: t.integer().notNull(),
  firstTradeTime: t.bigint(),
  lastTradeTime: t.bigint().notNull(),
  chainId: t.integer().notNull(),
}));

export const friendtechSubjectStats = onchainTable("friendtech_subject_stats", (t) => ({
  id: t.text().primaryKey(),               // subject_chainId
  subject: t.hex().notNull(),
  subjectKey: t.text().notNull(),
  totalSupply: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  uniqueHolders: t.integer().notNull(),
  totalTrades: t.integer().notNull(),
  totalBuys: t.integer().notNull(),
  totalSells: t.integer().notNull(),
  totalVolumeEth: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  lastTradeTime: t.bigint().notNull(),
  chainId: t.integer().notNull(),
}));

// ─────────────────────────────────────────────────────────────────────────
// MiberaLiquidBacking — loans + orders + stats
// ─────────────────────────────────────────────────────────────────────────

export const miberaLoan = onchainTable(
  "mibera_loan",
  (t) => ({
    id: t.text().primaryKey(),             // chainId_loanType_loanId
    loanId: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
    loanType: t.text().notNull(),          // "backing" | "item"
    user: t.hex().notNull(),               // @index per envio
    // tokenIds is array of uint256. Drizzle/pg array: use the numeric+array combo via
    // onchainTable's t.bigint().array(). For uint256-safety, we serialize as text
    // and JSON.parse at handler boundary — matches the existing envio JSON-array surface.
    tokenIds: t.text().notNull(),          // JSON-encoded uint256[] (e.g., "[\"123\",\"456\"]")
    amount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
    expiry: t.bigint().notNull(),
    status: t.text().notNull(),            // "ACTIVE" | "REPAID" | "DEFAULTED"
    createdAt: t.bigint().notNull(),
    repaidAt: t.bigint(),
    defaultedAt: t.bigint(),
    transactionHash: t.hex().notNull(),
    chainId: t.integer().notNull(),
  }),
  (table) => ({
    // @index parity (envio MiberaLoan_user) — see docs/A-1-index-parity-audit.md row 1
    userIdx: index().on(table.user),
  }),
);

export const miberaLoanStats = onchainTable("mibera_loan_stats", (t) => ({
  id: t.text().primaryKey(),               // chainId_global
  totalActiveLoans: t.integer().notNull(),
  totalLoansCreated: t.integer().notNull(),
  totalLoansRepaid: t.integer().notNull(),
  totalLoansDefaulted: t.integer().notNull(),
  totalAmountLoaned: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  totalNftsWithLoans: t.integer().notNull(),
  chainId: t.integer().notNull(),
}));

export const miberaOrder = onchainTable("mibera_order", (t) => ({
  id: t.text().primaryKey(),               // chainId_txHash_logIndex
  user: t.hex().notNull(),
  tokenId: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  amount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  timestamp: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
  chainId: t.integer().notNull(),
}));

// ─────────────────────────────────────────────────────────────────────────
// MiberaStaking — PaddleFi / Jiko derived view
// ─────────────────────────────────────────────────────────────────────────

export const miberaStakedToken = onchainTable("mibera_staked_token", (t) => ({
  id: t.text().primaryKey(),               // stakingContract_tokenId
  stakingContract: t.text().notNull(),     // "paddlefi" | "jiko"
  contractAddress: t.hex().notNull(),
  tokenId: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  owner: t.hex().notNull(),
  isStaked: t.boolean().notNull(),
  depositedAt: t.bigint().notNull(),
  depositTxHash: t.hex().notNull(),
  depositBlockNumber: t.bigint().notNull(),
  withdrawnAt: t.bigint(),
  withdrawTxHash: t.hex(),
  withdrawBlockNumber: t.bigint(),
  chainId: t.integer().notNull(),
}));

export const miberaStaker = onchainTable("mibera_staker", (t) => ({
  id: t.text().primaryKey(),               // stakingContract_address
  stakingContract: t.text().notNull(),
  contractAddress: t.hex().notNull(),
  address: t.hex().notNull(),
  currentStakedCount: t.integer().notNull(),
  totalDeposits: t.integer().notNull(),
  totalWithdrawals: t.integer().notNull(),
  firstDepositTime: t.bigint(),
  lastActivityTime: t.bigint().notNull(),
  chainId: t.integer().notNull(),
}));

// ─────────────────────────────────────────────────────────────────────────
// MiberaCollection — Transfer tracking
// ─────────────────────────────────────────────────────────────────────────

export const miberaTransfer = onchainTable("mibera_transfer", (t) => ({
  id: t.text().primaryKey(),               // txHash_logIndex
  from: t.hex().notNull(),
  to: t.hex().notNull(),
  tokenId: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  isMint: t.boolean().notNull(),
  timestamp: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
  chainId: t.integer().notNull(),
}));

// ─────────────────────────────────────────────────────────────────────────
// Unified mint activity (cross-source: ERC721 mints, ERC1155 mints, Seaport sales)
// ─────────────────────────────────────────────────────────────────────────

export const mintActivity = onchainTable(
  "mint_activity",
  (t) => ({
    id: t.text().primaryKey(),             // txHash_tokenId_user_activityType
    user: t.hex().notNull(),               // @index per envio
    contract: t.hex().notNull(),           // @index per envio
    tokenStandard: t.text().notNull(),     // "ERC721" | "ERC1155"
    tokenId: t.numeric({ precision: 78, scale: 0, mode: "bigint" }),  // nullable per envio
    quantity: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
    amountPaid: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
    activityType: t.text().notNull(),      // "MINT" | "SALE" | "PURCHASE"
    timestamp: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
    operator: t.hex(),
    chainId: t.integer().notNull(),
  }),
  (table) => ({
    // @index parity (envio MintActivity_user, MintActivity_contract) — audit rows 2, 3
    userIdx: index().on(table.user),
    contractIdx: index().on(table.contract),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// MintEvent (raw single-mint record; trait-bearing for VM)
// ─────────────────────────────────────────────────────────────────────────

export const mintEvent = onchainTable("mint_event", (t) => ({
  id: t.text().primaryKey(),
  collectionKey: t.text().notNull(),
  tokenId: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  minter: t.hex().notNull(),
  timestamp: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
  chainId: t.integer().notNull(),
  encodedTraits: t.text(),                 // VM-specific (nullable)
}));

// ─────────────────────────────────────────────────────────────────────────
// NftBurn — Mibera + Milady burn tracking
// ─────────────────────────────────────────────────────────────────────────

export const nftBurn = onchainTable("nft_burn", (t) => ({
  id: t.text().primaryKey(),               // txHash_logIndex
  collectionKey: t.text().notNull(),
  tokenId: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  from: t.hex().notNull(),
  timestamp: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
  chainId: t.integer().notNull(),
}));

export const nftBurnStats = onchainTable("nft_burn_stats", (t) => ({
  id: t.text().primaryKey(),               // chainId_collectionKey
  chainId: t.integer().notNull(),
  collectionKey: t.text().notNull(),
  totalBurned: t.integer().notNull(),
  uniqueBurners: t.integer().notNull(),
  lastBurnTime: t.bigint(),
  firstBurnTime: t.bigint(),
}));

// ─────────────────────────────────────────────────────────────────────────
// PaddleFi — supply / pawn / liquidation
// ─────────────────────────────────────────────────────────────────────────

export const paddleSupply = onchainTable("paddle_supply", (t) => ({
  id: t.text().primaryKey(),               // txHash_logIndex
  minter: t.hex().notNull(),
  mintAmount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  mintTokens: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  timestamp: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
  chainId: t.integer().notNull(),
}));

export const paddleSupplier = onchainTable("paddle_supplier", (t) => ({
  id: t.text().primaryKey(),               // address
  address: t.hex().notNull(),
  totalSupplied: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  totalPTokens: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  supplyCount: t.integer().notNull(),
  firstSupplyTime: t.bigint(),
  lastActivityTime: t.bigint().notNull(),
  chainId: t.integer().notNull(),
}));

export const paddlePawn = onchainTable("paddle_pawn", (t) => ({
  id: t.text().primaryKey(),               // txHash_logIndex
  borrower: t.hex().notNull(),
  nftIds: t.text().notNull(),              // JSON-encoded uint256[] (uint256-safe via text)
  timestamp: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
  chainId: t.integer().notNull(),
}));

export const paddleBorrower = onchainTable("paddle_borrower", (t) => ({
  id: t.text().primaryKey(),               // address
  address: t.hex().notNull(),
  totalNftsPawned: t.integer().notNull(),
  currentNftsPawned: t.integer().notNull(),
  pawnCount: t.integer().notNull(),
  firstPawnTime: t.bigint(),
  lastActivityTime: t.bigint().notNull(),
  chainId: t.integer().notNull(),
}));

export const paddleLiquidation = onchainTable("paddle_liquidation", (t) => ({
  id: t.text().primaryKey(),               // txHash_logIndex
  liquidator: t.hex().notNull(),
  borrower: t.hex().notNull(),
  repayAmount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  nftIds: t.text().notNull(),              // JSON-encoded uint256[]
  timestamp: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
  chainId: t.integer().notNull(),
}));

// ─────────────────────────────────────────────────────────────────────────
// Premint — phase participation / refunds / per-user rollup
// ─────────────────────────────────────────────────────────────────────────

export const premintParticipation = onchainTable("premint_participation", (t) => ({
  id: t.text().primaryKey(),               // txHash_logIndex
  phase: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  user: t.hex().notNull(),
  amount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  timestamp: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
  chainId: t.integer().notNull(),
}));

export const premintRefund = onchainTable("premint_refund", (t) => ({
  id: t.text().primaryKey(),               // txHash_logIndex
  phase: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  user: t.hex().notNull(),
  amount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  timestamp: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
  chainId: t.integer().notNull(),
}));

export const premintPhaseStats = onchainTable("premint_phase_stats", (t) => ({
  id: t.text().primaryKey(),               // phase_chainId
  phase: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  totalContributed: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  totalRefunded: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  netContribution: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  uniqueParticipants: t.integer().notNull(),
  participationCount: t.integer().notNull(),
  refundCount: t.integer().notNull(),
  chainId: t.integer().notNull(),
}));

export const premintUser = onchainTable("premint_user", (t) => ({
  id: t.text().primaryKey(),               // user_chainId
  user: t.hex().notNull(),
  totalContributed: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  totalRefunded: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  netContribution: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  participationCount: t.integer().notNull(),
  refundCount: t.integer().notNull(),
  firstParticipationTime: t.bigint(),
  lastActivityTime: t.bigint().notNull(),
  chainId: t.integer().notNull(),
}));

// ─────────────────────────────────────────────────────────────────────────
// TrackedHolder + TrackedTokenBalance — generic ERC-721 / ERC-20 holder rollups
// ─────────────────────────────────────────────────────────────────────────

export const trackedHolder = onchainTable(
  "tracked_holder",
  (t) => ({
    id: t.text().primaryKey(),
    contract: t.hex().notNull(),
    collectionKey: t.text().notNull(),     // @index per envio
    chainId: t.integer().notNull(),
    address: t.hex().notNull(),            // @index per envio
    tokenCount: t.integer().notNull(),
  }),
  (table) => ({
    // @index parity (envio TrackedHolder_collectionKey, TrackedHolder_address) — audit rows 4, 5
    collectionKeyIdx: index().on(table.collectionKey),
    addressIdx: index().on(table.address),
  }),
);

export const trackedTokenBalance = onchainTable(
  "tracked_token_balance",
  (t) => ({
    id: t.text().primaryKey(),             // address_tokenAddress_chainId
    address: t.hex().notNull(),            // @index per envio
    tokenAddress: t.hex().notNull(),       // @index per envio
    tokenKey: t.text().notNull(),
    chainId: t.integer().notNull(),
    balance: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
    lastUpdated: t.bigint().notNull(),
  }),
  (table) => ({
    // @index parity (envio TrackedTokenBalance_address, TrackedTokenBalance_tokenAddress) — audit rows 6, 7
    addressIdx: index().on(table.address),
    tokenAddressIdx: index().on(table.tokenAddress),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// MiberaLiquidBacking treasury surface
// ─────────────────────────────────────────────────────────────────────────

export const treasuryItem = onchainTable("treasury_item", (t) => ({
  id: t.text().primaryKey(),               // tokenId as string
  tokenId: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  isTreasuryOwned: t.boolean().notNull(),
  acquiredAt: t.bigint(),
  acquiredVia: t.text(),
  acquiredTxHash: t.hex(),
  purchasedAt: t.bigint(),
  purchasedBy: t.hex(),
  purchasedTxHash: t.hex(),
  purchasePrice: t.numeric({ precision: 78, scale: 0, mode: "bigint" }),
  chainId: t.integer().notNull(),
}));

export const treasuryActivity = onchainTable("treasury_activity", (t) => ({
  id: t.text().primaryKey(),               // txHash_logIndex
  activityType: t.text().notNull(),
  tokenId: t.numeric({ precision: 78, scale: 0, mode: "bigint" }),
  user: t.hex(),
  amount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }),
  timestamp: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
  chainId: t.integer().notNull(),
}));

export const treasuryStats = onchainTable("treasury_stats", (t) => ({
  id: t.text().primaryKey(),               // chainId_global
  totalItemsOwned: t.integer().notNull(),
  totalItemsEverOwned: t.integer().notNull(),
  totalItemsSold: t.integer().notNull(),
  realFloorValue: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  lastRfvUpdate: t.bigint(),
  lastActivityAt: t.bigint().notNull(),
  chainId: t.integer().notNull(),
}));

// ─────────────────────────────────────────────────────────────────────────
// AquaberaVaultDirect — WBERA/HENLO LP vault (Berachain 80094)
//
// Added in A-2 F-6 re-dispatch. Entity shapes are a faithful column-by-column
// port of envio's schema.graphql definitions (AquaberaDeposit, AquaberaWithdrawal,
// AquaberaBuilder, AquaberaStats). The handler at
// ponder-runtime/src/handlers/aquabera-vault-direct.ts requires all four.
// ─────────────────────────────────────────────────────────────────────────

export const aquaberaDeposit = onchainTable("aquabera_deposit", (t) => ({
  id: t.text().primaryKey(),               // tx_hash_logIndex
  amount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),   // WBERA
  shares: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),   // LP tokens
  timestamp: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
  from: t.hex().notNull(),                 // depositor address
  isWallContribution: t.boolean().notNull(),
  chainId: t.integer().notNull(),
}));

export const aquaberaWithdrawal = onchainTable("aquabera_withdrawal", (t) => ({
  id: t.text().primaryKey(),               // tx_hash_logIndex
  amount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),   // WBERA
  shares: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),   // LP tokens
  timestamp: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
  from: t.hex().notNull(),
  chainId: t.integer().notNull(),
}));

export const aquaberaBuilder = onchainTable("aquabera_builder", (t) => ({
  id: t.text().primaryKey(),               // user address (lowercase)
  address: t.hex().notNull(),
  totalDeposited: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  totalWithdrawn: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  netDeposited: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  currentShares: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  depositCount: t.integer().notNull(),
  withdrawalCount: t.integer().notNull(),
  firstDepositTime: t.bigint(),
  lastActivityTime: t.bigint().notNull(),
  isWallContract: t.boolean().notNull(),
  chainId: t.integer().notNull(),
}));

export const aquaberaStats = onchainTable("aquabera_stats", (t) => ({
  id: t.text().primaryKey(),               // "global" singleton
  totalBera: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  totalShares: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  totalDeposited: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  totalWithdrawn: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  uniqueBuilders: t.integer().notNull(),
  depositCount: t.integer().notNull(),
  withdrawalCount: t.integer().notNull(),
  wallContributions: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  wallDepositCount: t.integer().notNull(),
  lastUpdateTime: t.bigint().notNull(),
  chainId: t.integer(),
}));

// ─────────────────────────────────────────────────────────────────────────
// NATS outbox — pending_emits (SDD §3.3 + cookbook §T-A0.9 + §R-1)
//
// Reorg-safe + idempotent NATS publishing.
// - deterministic id = keccak256(chainId | "|" | txHash | "|" | logIndex | "|" | envelopeType)
// - id components stored as first-class columns (R-1) for production triage
// - publishedAt null = pending; non-null = published timestamp
// - chainTargetIdx: drives the block-tick flush handler scan
// - publishedAt index: drives BOTH the null-row scan AND the SKP-003 pruning task
//   (cron deletes rows older than 7d with non-null publishedAt — see T-A2.10)
// - txHashIdx: production triage query "which envelopes for this tx are still pending?"
// ─────────────────────────────────────────────────────────────────────────

export const pendingEmits = onchainTable(
  "pending_emits",
  (t) => ({
    // Deterministic id = keccak256(chainId | "|" | txHash | "|" | logIndex | "|" | envelopeType)
    // (canonical inputs verified at T-A0.9; 5x duplicate insert → 1 row, reorg/replay-safe)
    id: t.text().primaryKey(),

    // ID components stored AS first-class columns for production triage queries (R-1).
    chainId: t.integer().notNull(),
    txHash: t.hex().notNull(),
    logIndex: t.integer().notNull(),
    envelopeType: t.text().notNull(),      // discriminant: "transfer" | "mint" | "burn" | ...

    eventBlock: t.bigint().notNull(),
    targetBlock: t.bigint().notNull(),     // eventBlock + reorg_depth
    envelopeJson: t.text().notNull(),
    publishedAt: t.bigint(),               // null = pending; non-null = published timestamp
    attemptCount: t.integer().notNull().default(0),
    lastError: t.text(),
  }),
  (table) => ({
    // Block-tick flush handler scan: WHERE chainId=? AND publishedAt IS NULL AND targetBlock <= ?
    chainTargetIdx: index().on(table.chainId, table.targetBlock),
    // Two-use index per SKP-003 HIGH (T-A1.7):
    //   1. real-time scan for pending rows (null = ready to attempt publish)
    //   2. pruning task: DELETE WHERE publishedAt IS NOT NULL AND publishedAt < NOW() - INTERVAL '7 days'
    //      Without this index the pruning DELETE would tablescan a hot table.
    publishedAtIdx: index().on(table.publishedAt),
    // Production triage: which envelopes for this tx are still pending? (R-1)
    txHashEnvelopeIdx: index().on(table.txHash, table.envelopeType),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// NATS outbox — dead_letter_emits (SDD §3.3 extension + SKP-002 CRITICAL via T-A2.9)
//
// Per Sprint A-2 T-A2.9 acceptance criteria: rows that fail to publish after
// max 10 attempts OR sit in pending state >5min get moved here for operator
// triage (alert fires at the 5min threshold). Same column shape as
// pending_emits + DLQ-specific columns:
//   - failedAt: when the row was DLQ'd
//   - reason: discriminant ("max-attempts" | "stale-timeout")
//   - finalError: last lastError value at DLQ time
//
// Why a separate table (not a flag on pending_emits):
//   - The block-tick handler's hot-path scan (publishedAt IS NULL AND
//     targetBlock <= head) MUST stay tight. Filtering out DLQ'd rows would
//     either add a WHERE clause that hits the index poorly OR require a
//     compound index. Separate table keeps the hot path clean.
//   - Operator triage queries against dead_letter_emits don't compete with
//     real-time outbox-flush IO.
//
// The Action entity from envio's schema is REQUIRED for A-2 handler ports —
// every Mibera handler calls recordAction(). Added below.
// ─────────────────────────────────────────────────────────────────────────

export const deadLetterEmits = onchainTable(
  "dead_letter_emits",
  (t) => ({
    id: t.text().primaryKey(),                // SAME id as the source pending_emits row (deterministic)
    chainId: t.integer().notNull(),
    txHash: t.hex().notNull(),
    logIndex: t.integer().notNull(),
    envelopeType: t.text().notNull(),
    eventBlock: t.bigint().notNull(),
    targetBlock: t.bigint().notNull(),
    envelopeJson: t.text().notNull(),
    attemptCount: t.integer().notNull(),
    lastError: t.text(),
    failedAt: t.bigint().notNull(),           // unix ms timestamp
    reason: t.text().notNull(),               // "max-attempts" | "stale-timeout"
  }),
  (table) => ({
    failedAtIdx: index().on(table.failedAt),
    chainIdx: index().on(table.chainId, table.failedAt),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// Action — generic activity feed used by every Mibera handler via lib/actions
// (envio schema.graphql §1-12). REQUIRED for A-2 handler ports; the entity
// was missing from A-1's blue-belt-scoped schema and is added here.
//
// Identical column shape to envio's Action entity (schema.graphql §1-12).
// ─────────────────────────────────────────────────────────────────────────

export const action = onchainTable(
  "action",
  (t) => ({
    id: t.text().primaryKey(),                // typically `${txHash}_${logIndex}` (+ suffix)
    actionType: t.text().notNull(),           // "mint" | "burn" | "transfer" | "premint_participate" | ...
    actor: t.hex().notNull(),                 // wallet that performed the action (lowercased)
    primaryCollection: t.text(),              // optional collection key
    timestamp: t.bigint().notNull(),
    chainId: t.integer().notNull(),
    txHash: t.hex().notNull(),
    numeric1: t.numeric({ precision: 78, scale: 0, mode: "bigint" }),
    numeric2: t.numeric({ precision: 78, scale: 0, mode: "bigint" }),
    context: t.text(),                        // JSON-encoded arbitrary context blob
  }),
  (table) => ({
    // Drives the activity-feed queries used by missions + UI surfaces.
    actorIdx: index().on(table.actor, table.timestamp),
    actionTypeIdx: index().on(table.actionType, table.timestamp),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// green-belt: henlo (B-1 Group D)
//
// SOURCE OF TRUTH: grimoires/loa/migration/b-1-green-belt-map.yaml
//   (entities HenloHolder … HenloSourceBurner — every column ported verbatim,
//    incl. NULL/NOT NULL).
//
// Contract: TrackedErc20 (HENLO token 0xb2f7…6a5; Base 8453 + Berachain 80094).
//   The HENLO token is the only TOKEN_CONFIGS entry with burnTracking +
//   holderStats = true. The shared TrackedTokenBalance entity is already in the
//   blue belt (tracked_token_balance above); these 8 are the green-belt gap.
//
// Type mapping (per the map's ponder_type column — note: address columns are
// `text` in the map, so t.text() NOT t.hex()):
//   text PK                     → t.text().primaryKey()
//   text NOT NULL / NULL        → t.text().notNull() / t.text()
//   numeric(78,0) NOT NULL/NULL → t.numeric({ precision: 78, scale: 0, mode: "bigint" })[.notNull()]
//   bigint (int8) NOT NULL/NULL → t.bigint()[.notNull()]
//   integer (int4) NOT NULL/NULL→ t.integer()[.notNull()]
//
// Envio source: src/handlers/tracked-erc20/holder-stats.ts (HenloHolder,
//   HenloHolderStats) + burn-tracking.ts (HenloBurn, HenloBurnStats,
//   HenloGlobalBurnStats, HenloBurner, HenloChainBurner, HenloSourceBurner).
// ─────────────────────────────────────────────────────────────────────────

// HenloHolder — id = holder address (lowercase). rollup-lww (balance LWW per transfer).
export const henloHolder = onchainTable(
  "henlo_holder",
  (t) => ({
    id: t.text().primaryKey(),               // address
    address: t.text().notNull(),             // @index per envio
    balance: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
    firstTransferTime: t.bigint(),
    lastActivityTime: t.bigint().notNull(),
    chainId: t.integer().notNull(),
  }),
  (table) => ({
    addressIdx: index().on(table.address),
  }),
);

// HenloHolderStats — id = chainId.toString(). rollup (uniqueHolders/totalSupply additive).
export const henloHolderStats = onchainTable("henlo_holder_stats", (t) => ({
  id: t.text().primaryKey(),                 // chainId
  chainId: t.integer().notNull(),
  uniqueHolders: t.integer().notNull(),
  totalSupply: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  lastUpdateTime: t.bigint().notNull(),
}));

// HenloBurn — id = `${txHash}_${logIndex}`. append (one row per burn event).
export const henloBurn = onchainTable("henlo_burn", (t) => ({
  id: t.text().primaryKey(),                 // txHash_logIndex
  amount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  timestamp: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  transactionHash: t.text().notNull(),
  from: t.text().notNull(),
  source: t.text().notNull(),
  chainId: t.integer().notNull(),
}));

// HenloBurnStats — id = `${chainId}_${source}` and `${chainId}_total`. rollup.
export const henloBurnStats = onchainTable("henlo_burn_stats", (t) => ({
  id: t.text().primaryKey(),                 // chainId_source | chainId_total
  chainId: t.integer().notNull(),
  source: t.text().notNull(),
  totalBurned: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  burnCount: t.integer().notNull(),
  uniqueBurners: t.integer().notNull(),
  lastBurnTime: t.bigint(),
  firstBurnTime: t.bigint(),
}));

// HenloGlobalBurnStats — id = "global" singleton. rollup (all additive).
export const henloGlobalBurnStats = onchainTable("henlo_global_burn_stats", (t) => ({
  id: t.text().primaryKey(),                 // "global"
  totalBurnedAllChains: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  totalBurnedMainnet: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  totalBurnedTestnet: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  burnCountAllChains: t.integer().notNull(),
  incineratorBurns: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  overunderBurns: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  beratrackrBurns: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  userBurns: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  uniqueBurners: t.integer().notNull(),
  incineratorUniqueBurners: t.integer().notNull(),
  lastUpdateTime: t.bigint().notNull(),
}));

// HenloBurner — id = burner address. rollup-lww (materialized unique-burner; first-seen).
export const henloBurner = onchainTable("henlo_burner", (t) => ({
  id: t.text().primaryKey(),                 // burner address
  address: t.text().notNull(),
  firstBurnTime: t.bigint(),
  chainId: t.integer().notNull(),
}));

// HenloChainBurner — id = `${chainId}_${burnerId}`. rollup-lww (first-seen per chain).
export const henloChainBurner = onchainTable("henlo_chain_burner", (t) => ({
  id: t.text().primaryKey(),                 // chainId_burnerAddress
  chainId: t.integer().notNull(),
  address: t.text().notNull(),
  firstBurnTime: t.bigint(),
}));

// HenloSourceBurner — id = `${chainId}_${source}_${burnerId}`. rollup-lww (first-seen per source).
export const henloSourceBurner = onchainTable("henlo_source_burner", (t) => ({
  id: t.text().primaryKey(),                 // chainId_source_burnerAddress
  chainId: t.integer().notNull(),
  source: t.text().notNull(),
  address: t.text().notNull(),
  firstBurnTime: t.bigint(),
}));
