/*
 * collection-event-webhook.test.ts — pins the load-bearing crash-loop hardening (FAGAN MAJOR-2).
 *
 * refreshMembers() is the function whose throwing once took the whole realtime service down (a Helius 429
 * "max usage reached" propagated out of main() → process.exit(1) → Railway crash-loop). The invariant is:
 * it NEVER throws — DAS (authoritative) → DB-derived fallback → keep-existing-set. These tests fail if a
 * future edit reintroduces a throw on any path, which "vitest 83/83 green" alone would not catch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted so the (hoisted) vi.mock factories can close over them (vitest evaluates factories first).
const { dasSnapshot, fetchMemberMintsFromDbMock } = vi.hoisted(() => ({
  dasSnapshot: vi.fn(),
  fetchMemberMintsFromDbMock: vi.fn(),
}));

vi.mock("../src/svm/nft-collection-source", () => ({
  DasNftCollectionSource: class {
    snapshot = dasSnapshot;
  },
}));

vi.mock("../src/svm/collection-event-writer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/svm/collection-event-writer")>();
  return { ...actual, fetchMemberMintsFromDb: fetchMemberMintsFromDbMock };
});

import { refreshMembers, memberState } from "../src/svm/collection-event-webhook";

const snap = (mints: string[]) => ({ members: mints.map((m) => ({ nftMint: m, owner: "W" })), slot: 1 });
const quota429 = () => new Error('getAssetsByGroup: HTTP 429 {"code":-32429,"message":"max usage reached"}');

beforeEach(() => {
  dasSnapshot.mockReset();
  fetchMemberMintsFromDbMock.mockReset();
});

describe("refreshMembers (crash-loop hardening)", () => {
  it("DAS success → authoritative set, source=das, DB never consulted", async () => {
    dasSnapshot.mockResolvedValue(snap(["A", "B"]));
    await expect(refreshMembers()).resolves.toBeUndefined();
    expect(memberState()).toMatchObject({ size: 2, source: "das" });
    expect(fetchMemberMintsFromDbMock).not.toHaveBeenCalled();
  });

  it("DAS 429 → falls back to the DB-derived set, source=db-fallback (the outage path)", async () => {
    dasSnapshot.mockRejectedValue(quota429());
    fetchMemberMintsFromDbMock.mockResolvedValue(["X", "Y", "Z"]);
    await expect(refreshMembers()).resolves.toBeUndefined();
    expect(memberState()).toMatchObject({ size: 3, source: "db-fallback" });
  });

  it("DAS 429 + DB throws → NEVER throws; retains the prior set (the invariant)", async () => {
    // establish a known DAS set first
    dasSnapshot.mockResolvedValueOnce(snap(["A", "B"]));
    await refreshMembers();
    const before = memberState();
    // now both sources fail
    dasSnapshot.mockRejectedValue(quota429());
    fetchMemberMintsFromDbMock.mockRejectedValue(new Error("hasura: HTTP 500"));
    await expect(refreshMembers()).resolves.toBeUndefined();
    // set retained, loadedAt unchanged (so the next request self-heals by retrying)
    expect(memberState()).toEqual(before);
  });

  it("DAS 429 + DB returns [] → NEVER throws; retains the prior set", async () => {
    dasSnapshot.mockResolvedValueOnce(snap(["A", "B", "C"]));
    await refreshMembers();
    const before = memberState();
    dasSnapshot.mockRejectedValue(quota429());
    fetchMemberMintsFromDbMock.mockResolvedValue([]);
    await expect(refreshMembers()).resolves.toBeUndefined();
    expect(memberState()).toEqual(before);
  });
});
