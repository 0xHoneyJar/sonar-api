// ponder-runtime/src/handlers/token-projection/shared.test.ts
//
// Unit tests for the pure per-token ownership projection (shared.ts) — the
// load-bearing logic behind the `token` entity, tested without the Ponder
// runtime (mirrors candies-balance.test.ts / mibera-liquid-backing.test.ts).
//
// Coverage maps directly to the bd-jyn folded rules:
//   - mint   → owner=to, isBurned=false
//   - secondary transfer → owner=to
//   - burn   → isBurned=true (row NOT deleted)
//   - pre-boundary transfer (no prior row → upsert CREATES it) ............ B2
//   - last-write-wins ordered by (blockNumber, logIndex), not insert order  B10
//   - conservation: mints − burns == non-burned rows (helper level)

import { describe, expect, it } from "vitest";
import {
  tokenRowId,
  isAtOrAfter,
  projectOwnership,
  resolveTokenRow,
  type TokenRow,
  type TransferInput,
} from "./shared";

const MIBERA = "0x6666397dfe9a8c469bf65dc744cb1c733416c420";
const CHAIN = 80094;
const A = "0x000000000000000000000000000000000000aaaa";
const B = "0x000000000000000000000000000000000000bbbb";
const DEAD = "0x000000000000000000000000000000000000dead";

/** Build a TransferInput with sane defaults; only `to` is required. */
function ev(
  partial: Partial<TransferInput> & Pick<TransferInput, "to">,
): TransferInput {
  return {
    isMint: false,
    isBurn: false,
    blockNumber: 100n,
    logIndex: 0,
    timestamp: 1000n,
    ...partial,
  };
}

describe("tokenRowId", () => {
  it("composes `${contract}_${chainId}_${tokenId}`", () => {
    expect(tokenRowId(MIBERA, CHAIN, 123n)).toBe(`${MIBERA}_80094_123`);
  });
  it("lowercases the contract so the id is checksum-stable", () => {
    expect(tokenRowId(MIBERA.toUpperCase(), CHAIN, 1n)).toBe(
      tokenRowId(MIBERA, CHAIN, 1n),
    );
  });
});

describe("projectOwnership", () => {
  it("mint → owner=to, isBurned=false", () => {
    expect(projectOwnership(ev({ to: A, isMint: true }))).toEqual({
      owner: A,
      isBurned: false,
    });
  });
  it("secondary transfer → owner=to, isBurned=false", () => {
    expect(projectOwnership(ev({ to: B }))).toEqual({
      owner: B,
      isBurned: false,
    });
  });
  it("burn → isBurned=true, owner=the burn sink `to`", () => {
    expect(projectOwnership(ev({ to: DEAD, isBurn: true }))).toEqual({
      owner: DEAD,
      isBurned: true,
    });
  });
  it("lowercases the owner address", () => {
    expect(projectOwnership(ev({ to: A.toUpperCase() })).owner).toBe(A);
  });
});

describe("isAtOrAfter (the (blockNumber, logIndex) ordering key)", () => {
  it("orders by blockNumber first", () => {
    expect(
      isAtOrAfter({ blockNumber: 11n, logIndex: 0 }, { blockNumber: 10n, logIndex: 99 }),
    ).toBe(true);
    expect(
      isAtOrAfter({ blockNumber: 9n, logIndex: 99 }, { blockNumber: 10n, logIndex: 0 }),
    ).toBe(false);
  });
  it("breaks same-block ties by logIndex", () => {
    expect(
      isAtOrAfter({ blockNumber: 10n, logIndex: 5 }, { blockNumber: 10n, logIndex: 4 }),
    ).toBe(true);
    expect(
      isAtOrAfter({ blockNumber: 10n, logIndex: 3 }, { blockNumber: 10n, logIndex: 4 }),
    ).toBe(false);
  });
  it("treats an exactly-equal pair as at-or-after (idempotent re-apply)", () => {
    expect(
      isAtOrAfter({ blockNumber: 10n, logIndex: 4 }, { blockNumber: 10n, logIndex: 4 }),
    ).toBe(true);
  });
});

describe("resolveTokenRow", () => {
  it("B2: pre-boundary transfer with NO prior row CREATES the row (not update-only)", () => {
    // A token whose mint predates the index boundary: the first event we ever
    // see for it is a *secondary* transfer (isMint=false), and prev is null.
    const row = resolveTokenRow(null, ev({ to: A, blockNumber: 500n, logIndex: 2 }));
    expect(row).toEqual({
      owner: A,
      isBurned: false,
      mintedAt: 0n, // non-mint first sighting ⇒ unknown sentinel
      lastTransferTime: 1000n,
      lastBlockNumber: 500n,
      lastLogIndex: 2,
    });
  });

  it("mint creates owner=to, isBurned=false", () => {
    const row = resolveTokenRow(
      null,
      ev({ to: A, isMint: true, blockNumber: 10n, logIndex: 0 }),
    );
    expect(row.owner).toBe(A);
    expect(row.isBurned).toBe(false);
  });

  it("secondary transfer advances owner=to and the ordering key", () => {
    const prev: TokenRow = {
      owner: A,
      isBurned: false,
      mintedAt: 700n,
      lastTransferTime: 1000n,
      lastBlockNumber: 10n,
      lastLogIndex: 0,
    };
    const row = resolveTokenRow(
      prev,
      ev({ to: B, blockNumber: 20n, logIndex: 0, timestamp: 2000n }),
    );
    expect(row.owner).toBe(B);
    expect(row.isBurned).toBe(false);
    expect(row.lastBlockNumber).toBe(20n);
    expect(row.lastTransferTime).toBe(2000n);
    expect(row.mintedAt).toBe(700n); // non-mint transfer preserves the prior mintedAt
  });

  it("burn sets isBurned=true and does NOT delete/clear the row", () => {
    const prev: TokenRow = {
      owner: A,
      isBurned: false,
      mintedAt: 700n,
      lastTransferTime: 1000n,
      lastBlockNumber: 10n,
      lastLogIndex: 0,
    };
    const row = resolveTokenRow(
      prev,
      ev({ to: DEAD, isBurn: true, blockNumber: 30n, logIndex: 1, timestamp: 3000n }),
    );
    expect(row.isBurned).toBe(true);
    expect(row.lastBlockNumber).toBe(30n);
  });

  it("B10: an OLDER (blockNumber,logIndex) event does NOT clobber a newer owner", () => {
    const prev: TokenRow = {
      owner: B,
      isBurned: false,
      mintedAt: 700n,
      lastTransferTime: 2000n,
      lastBlockNumber: 20n,
      lastLogIndex: 0,
    };
    // A re-delivered stale transfer from block 10 arriving after block 20.
    const row = resolveTokenRow(
      prev,
      ev({ to: A, blockNumber: 10n, logIndex: 5, timestamp: 1000n }),
    );
    expect(row).toBe(prev); // returned unchanged, by reference
    expect(row.owner).toBe(B);
  });

  it("B10: same-block HIGHER logIndex wins (ordering is not by timestamp)", () => {
    const prev: TokenRow = {
      owner: A,
      isBurned: false,
      mintedAt: 700n,
      lastTransferTime: 1000n,
      lastBlockNumber: 10n,
      lastLogIndex: 2,
    };
    const row = resolveTokenRow(
      prev,
      ev({ to: B, blockNumber: 10n, logIndex: 3, timestamp: 1000n }),
    );
    expect(row.owner).toBe(B);
    expect(row.lastLogIndex).toBe(3);
  });

  it("B10: a stale burn cannot resurrect isBurned over a newer non-burn transfer", () => {
    const prev: TokenRow = {
      owner: B,
      isBurned: false,
      mintedAt: 700n,
      lastTransferTime: 5000n,
      lastBlockNumber: 50n,
      lastLogIndex: 0,
    };
    const row = resolveTokenRow(
      prev,
      ev({ to: DEAD, isBurn: true, blockNumber: 40n, logIndex: 0, timestamp: 4000n }),
    );
    expect(row.isBurned).toBe(false); // stale burn dropped
    expect(row.owner).toBe(B);
  });
});

describe("mintedAt (review fold #1 — envio Token.mintedAt parity)", () => {
  it("mint stamps mintedAt = the mint event timestamp", () => {
    const row = resolveTokenRow(
      null,
      ev({ to: A, isMint: true, blockNumber: 10n, logIndex: 0, timestamp: 1234n }),
    );
    expect(row.mintedAt).toBe(1234n);
  });

  it("non-mint first sighting (prev=null) ⇒ mintedAt = 0n (unknown sentinel)", () => {
    const row = resolveTokenRow(
      null,
      ev({ to: A, isMint: false, blockNumber: 10n, logIndex: 0, timestamp: 1234n }),
    );
    expect(row.mintedAt).toBe(0n);
  });

  it("a later non-mint transfer preserves the prior mintedAt", () => {
    const prev: TokenRow = {
      owner: A,
      isBurned: false,
      mintedAt: 1234n,
      lastTransferTime: 1234n,
      lastBlockNumber: 10n,
      lastLogIndex: 0,
    };
    const row = resolveTokenRow(
      prev,
      ev({ to: B, isMint: false, blockNumber: 20n, logIndex: 0, timestamp: 5678n }),
    );
    expect(row.mintedAt).toBe(1234n);
    expect(row.lastTransferTime).toBe(5678n);
  });

  it("a later (out-of-order) mint event learns mintedAt over a 0n sentinel", () => {
    // pre-boundary token first seen via a non-mint transfer at block 10 (mintedAt=0n);
    // the actual mint log replays later at a higher (block, logIndex) and stamps it.
    const prev: TokenRow = {
      owner: A,
      isBurned: false,
      mintedAt: 0n,
      lastTransferTime: 1000n,
      lastBlockNumber: 10n,
      lastLogIndex: 0,
    };
    const row = resolveTokenRow(
      prev,
      ev({ to: A, isMint: true, blockNumber: 20n, logIndex: 0, timestamp: 2000n }),
    );
    expect(row.mintedAt).toBe(2000n);
  });
});

describe("conservation (helper level): mints − burns == non-burned rows", () => {
  it("replaying an ordered Transfer log yields nonBurnedRows == mints − burns", () => {
    type Ev = { tokenId: bigint } & TransferInput;
    const log: Ev[] = [
      // token 1: mint → burn (out of circulation)
      { tokenId: 1n, to: A, isMint: true, isBurn: false, blockNumber: 1n, logIndex: 0, timestamp: 1n },
      { tokenId: 1n, to: DEAD, isMint: false, isBurn: true, blockNumber: 2n, logIndex: 0, timestamp: 2n },
      // token 2: mint → secondary (still in circulation)
      { tokenId: 2n, to: A, isMint: true, isBurn: false, blockNumber: 3n, logIndex: 0, timestamp: 3n },
      { tokenId: 2n, to: B, isMint: false, isBurn: false, blockNumber: 4n, logIndex: 0, timestamp: 4n },
      // token 3: mint only (still in circulation)
      { tokenId: 3n, to: B, isMint: true, isBurn: false, blockNumber: 5n, logIndex: 0, timestamp: 5n },
    ];

    const rows = new Map<string, TokenRow>();
    let mints = 0;
    let burns = 0;
    for (const e of log) {
      if (e.isMint) mints++;
      if (e.isBurn) burns++;
      const id = tokenRowId(MIBERA, CHAIN, e.tokenId);
      rows.set(id, resolveTokenRow(rows.get(id) ?? null, e));
    }

    const nonBurned = [...rows.values()].filter((r) => !r.isBurned).length;
    expect(mints).toBe(3);
    expect(burns).toBe(1);
    expect(nonBurned).toBe(mints - burns); // 2 tokens still in circulation
  });
});
