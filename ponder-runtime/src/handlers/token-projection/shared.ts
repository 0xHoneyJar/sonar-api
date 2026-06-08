// ponder-runtime/src/handlers/token-projection/shared.ts
//
// Pure projection helpers for the per-token current-ownership index (the `token`
// entity in ponder.schema.ts). Extracted so the ownership transition AND the
// last-write-wins ordering guard are unit-testable WITHOUT the Ponder runtime —
// mirrors the pure-helper convention in ../mibera-liquid-backing/shared.ts and
// ../candies-balance.ts (handlers can't be unit-tested without the runtime, so
// the load-bearing logic lives here behind a plain-function boundary).
//
// bd-jyn (S1a) — Mibera per-token ownership. The helpers are collection-agnostic
// (contract / chainId / collectionKey are passed in, never hardcoded) so the
// sibling beads (bd-1jg TrackedErc721, bd-d2b GeneralMints/MST/GIF) can reuse
// the exact same projection without forking the ordering logic.
//
// PROJECTION SEMANTICS:
//   - owner    = the `to` of the latest APPLIED Transfer (raw on-chain ownership;
//                for a burn this is the burn sink address).
//   - isBurned = true once a transfer lands in the collection's REAL burn sink.
//                The caller passes `isBurn`, computed via the collection's own
//                isBurnTransfer() helper — NOT a hardcoded `to == 0x0` check
//                (B1). A burn does NOT delete the row; it flags it out of
//                circulation (the consumer filters `isBurned: false`).
//   - last-write-wins ordered by (blockNumber, logIndex) (B10): an out-of-order
//     / older event NEVER clobbers a newer owner. The reorg-safe source of
//     record is the `action` ledger (+ `mibera_transfer`); `token` is a
//     re-derivable projection — drop it and replay the Transfer log to rebuild.

/** A position in the on-chain event stream — the last-write-wins ordering key. */
export interface EventOrder {
  blockNumber: bigint;
  logIndex: number;
}

/** The persisted shape of a `token` row's mutable (per-transfer) state. */
export interface TokenRow {
  owner: string; // lowercased hex
  isBurned: boolean;
  // Block timestamp of the MINT event. 0n is the "unknown" sentinel for a token
  // first seen via a non-mint transfer (mint predates this index boundary).
  mintedAt: bigint;
  lastTransferTime: bigint;
  lastBlockNumber: bigint;
  lastLogIndex: number;
}

/** A single ERC-721 Transfer projected onto one token. */
export interface TransferInput {
  /** Recipient of the transfer (lowercased at the handler boundary). */
  to: string;
  /** from == 0x0 — per the collection's own isMintFromZero() helper. */
  isMint: boolean;
  /** `to` is the collection's real burn sink — per isBurnTransfer(), NOT to==0x0. */
  isBurn: boolean;
  blockNumber: bigint;
  logIndex: number;
  timestamp: bigint;
}

/**
 * Deterministic per-token row id: `{contract}_{chainId}_{tokenId}`.
 * Contract is lowercased so the id is stable regardless of checksum casing —
 * the consumer + handler both key on the lowercased contract address.
 */
export function tokenRowId(
  contract: string,
  chainId: number,
  tokenId: bigint,
): string {
  return `${contract.toLowerCase()}_${chainId}_${tokenId.toString()}`;
}

/**
 * True iff `incoming` is at or after `existing` in (blockNumber, logIndex) order.
 * An equal pair returns true: re-applying the exact same event is an idempotent
 * (value-identical) write, never a regression.
 */
export function isAtOrAfter(incoming: EventOrder, existing: EventOrder): boolean {
  if (incoming.blockNumber !== existing.blockNumber) {
    return incoming.blockNumber > existing.blockNumber;
  }
  return incoming.logIndex >= existing.logIndex;
}

/**
 * The ownership state a single Transfer projects onto the token, ignoring order.
 *   owner    = to (the new holder; for a burn this is the burn sink)
 *   isBurned = isBurn
 * `isMint` / `from` do not change the transition (a mint has isBurn=false, so it
 * yields owner=to, isBurned=false). They are part of the input for an explicit,
 * self-documenting signature and so callers can extend the projection later.
 */
export function projectOwnership(input: TransferInput): {
  owner: string;
  isBurned: boolean;
} {
  return {
    owner: input.to.toLowerCase(),
    isBurned: input.isBurn,
  };
}

/**
 * Resolve the next persisted token row given the previously-persisted row (or
 * `null` for a first sighting) and an incoming Transfer.
 *
 * UPSERT (B2): callers use this for BOTH the create branch (prev=null → the row
 *   is CREATED) and the onConflictDoUpdate branch (prev=existing). A token whose
 *   mint predates this handler's index boundary has no prior row and is created
 *   on the first transfer seen — never silently dropped by an update-only path.
 *
 * LAST-WRITE-WINS (B10): if the incoming event is OLDER than the stored row in
 *   (blockNumber, logIndex) order, the stored row is returned UNCHANGED (the
 *   stale event is dropped). Otherwise the row advances to the incoming event's
 *   projection. Ordering is by (blockNumber, logIndex) — NOT insert order and
 *   NOT timestamp (same-block events share a timestamp but differ by logIndex).
 */
export function resolveTokenRow(
  prev: TokenRow | null,
  input: TransferInput,
): TokenRow {
  const projected = projectOwnership(input);
  const candidate: TokenRow = {
    owner: projected.owner,
    isBurned: projected.isBurned,
    // Stamped at the mint event; a pre-boundary token first seen via a non-mint
    // transfer is 0n (unknown); preserved across later non-mint transfers; a
    // later (rare/out-of-order) mint learns it. The stale-event branch below
    // returns `prev` unchanged, so a stale event never clobbers a known mintedAt.
    mintedAt: input.isMint ? input.timestamp : (prev?.mintedAt ?? 0n),
    lastTransferTime: input.timestamp,
    lastBlockNumber: input.blockNumber,
    lastLogIndex: input.logIndex,
  };
  if (prev === null) return candidate;

  const incomingIsNewer = isAtOrAfter(
    { blockNumber: input.blockNumber, logIndex: input.logIndex },
    { blockNumber: prev.lastBlockNumber, logIndex: prev.lastLogIndex },
  );
  return incomingIsNewer ? candidate : prev;
}
