// A-0 Verification Spike — schema
// Validates:
// - T-A0.6: uint256 column type `t.numeric(78, 0)` roundtrip of 2^256-1
// - T-A0.9: deterministic outbox ID schema (chainId|txHash|logIndex|envelopeType)
// - T-A0.4: onConflictDoNothing / onConflictDoUpdate semantics with deterministic IDs
import { onchainTable, index } from "ponder";

// ─── Token entity — uint256-safe (T-A0.6) ──────────────────────────────────
// SDD §3.2: Drizzle's `bigint` maps to Postgres int64 which OVERFLOWS for
// uint256 token IDs above 2^63. NFTs commonly emit token IDs above that.
// Therefore: `t.numeric(78, 0)` (precision 78 = max digits of 2^256-1).
export const token = onchainTable(
  "token",
  (t) => ({
    id: t.text().primaryKey(),               // `${chainId}-${collection}-${tokenId}`
    chainId: t.integer().notNull(),
    collection: t.hex().notNull(),
    // ← uint256-safe. mode: 'bigint' makes drizzle convert numeric(78,0) ↔ bigint
    //   without manual .toString() coercion on writes/reads. Without mode:'bigint'
    //   drizzle defaults to string-mode and `tokenId: bigint` from viem args
    //   becomes a TypeScript error. (Spike finding — COOKBOOK §T-A0.6.)
    tokenId: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
    owner: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    ownerIdx: index().on(table.owner),
    collectionIdx: index().on(table.collection),
  }),
);

// ─── Block-tick counter (T-A0.2 evidence trail) ─────────────────────────
// Lets us prove via SELECT that the block handler fired N times for the
// expected range. Without this, "did the handler run?" is debug-log-only.
export const blockTickCounter = onchainTable(
  "block_tick_counter",
  (t) => ({
    chainId: t.integer().primaryKey(),
    lastBlock: t.bigint().notNull(),
    tickCount: t.bigint().notNull().default(0n),
  }),
);

// ─── NATS outbox — deterministic IDs (T-A0.9) ──────────────────────────────
// SDD §3.3 + T-A0.9 collision-domain analysis:
//   deterministic_id = keccak256(chainId | txHash | logIndex | envelopeType)
// Collision domains covered:
//   1. same-tx-multi-logs — logIndex differentiates
//   2. cross-chain same-contract — chainId differentiates
//   3. reorged-logs — same logIndex re-emitted → same id → onConflictDoNothing
//   4. handler-replay — same input → same id → onConflictDoNothing
//   5. multi-envelope-per-event — envelopeType differentiates
//      (e.g. one log emits both `mint` and `transfer` envelopes)
export const pendingEmits = onchainTable(
  "pending_emits",
  (t) => ({
    id: t.text().primaryKey(),               // deterministic per T-A0.9
    chainId: t.integer().notNull(),
    txHash: t.hex().notNull(),
    logIndex: t.integer().notNull(),
    envelopeType: t.text().notNull(),
    eventBlock: t.bigint().notNull(),
    targetBlock: t.bigint().notNull(),       // eventBlock + reorg_depth
    envelopeJson: t.text().notNull(),
    publishedAt: t.bigint(),                 // null = pending; non-null = published timestamp
    attemptCount: t.integer().notNull().default(0),
    lastError: t.text(),
  }),
  (table) => ({
    chainTargetIdx: index().on(table.chainId, table.targetBlock),
    pendingIdx: index().on(table.publishedAt),
  }),
);
