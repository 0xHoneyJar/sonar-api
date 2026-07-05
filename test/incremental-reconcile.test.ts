/*
 * incremental-reconcile.test.ts — unit coverage for the T-6 incremental reconcile (SDD §2.6).
 *
 * Pure mint-selection (selectDriftedMints: drifted / missing-from-derived / equal sets) + the injected
 * runReconcile flow: a counting fake source proves ONLY drifted mints get walked in incremental mode vs
 * ALL members under --full; --verify-off skips the snapshot and records 'skipped-no-das' (and stays a
 * no-op when no sync-status writer is injected). No live RPC/Helius/Hasura.
 */
import { describe, it, expect, vi } from "vitest";
import {
  selectDriftedMints,
  runReconcile,
  type ReconcileDeps,
  type ReconcileOpts,
} from "../src/svm/collection-event-indexer";
import type { CollectionEvent } from "../src/svm/collection-event-source";
import type { CollectionMember, CollectionSnapshot } from "../src/svm/nft-collection-source";

const member = (nftMint: string, owner: string): CollectionMember => ({
  nftMint,
  owner,
  delegate: null,
  name: null,
  compressed: false,
});

const snapOf = (members: CollectionMember[]): CollectionSnapshot => ({
  collectionMint: "COLLECTION_MINT",
  slot: 500,
  source: "das",
  members,
});

const ev = (nftMint: string, to: string, over: Partial<CollectionEvent> = {}): CollectionEvent => ({
  nftMint,
  kind: "transfer",
  from: "SOMEONE",
  to,
  instructionIndex: 0,
  price: null,
  marketplace: null,
  slot: 400,
  blockTime: 1_700_000_000,
  txSignature: `SIG_${nftMint}`,
  ...over,
});

describe("selectDriftedMints", () => {
  it("selects a mint whose derived owner differs from the snapshot owner", () => {
    const drifted = selectDriftedMints(
      [
        { nftMint: "A", owner: "X" },
        { nftMint: "B", owner: "Y" },
      ],
      new Map([
        ["A", "X"],
        ["B", "SOMEONE_ELSE"],
      ]),
    );
    expect(drifted).toEqual(["B"]);
  });

  it("selects a mint missing from the derived set (never indexed)", () => {
    const drifted = selectDriftedMints([{ nftMint: "A", owner: "X" }], new Map());
    expect(drifted).toEqual(["A"]);
  });

  it("returns [] when derived and snapshot agree for every member", () => {
    const drifted = selectDriftedMints(
      [
        { nftMint: "A", owner: "X" },
        { nftMint: "B", owner: "Y" },
      ],
      new Map([
        ["A", "X"],
        ["B", "Y"],
      ]),
    );
    expect(drifted).toEqual([]);
  });
});

/**
 * Test harness: 3 members (A→X in agreement; B drifted — derived says W; C missing from derived).
 * The counting fake source records every mintHistory() call; per-mint histories re-agree with DAS so
 * the §4.5 gate passes at 100%.
 */
function harness(over: { eventsByMint?: Record<string, CollectionEvent[]> } = {}) {
  const members = [member("A", "X"), member("B", "Y"), member("C", "Z")];
  const eventsByMint = over.eventsByMint ?? {
    A: [ev("A", "X")],
    B: [ev("B", "Y")],
    C: [ev("C", "Z")],
  };
  const walkedMints: string[] = [];
  const upsert = vi.fn(async (events: readonly CollectionEvent[]) => events.length);
  const writeSyncStatus = vi.fn(async () => undefined);
  const snapshot = vi.fn(async () => snapOf(members));
  const fetchDerivedOwners = vi.fn(async () =>
    new Map([
      ["A", "X"], // agrees with DAS → not walked in incremental mode
      ["B", "W"], // drifted → walked
      // C absent → never indexed → walked
    ]),
  );
  const deps: ReconcileDeps = {
    snapshot,
    events: {
      async *mintHistory(mint: string) {
        walkedMints.push(mint);
        yield* eventsByMint[mint] ?? [];
      },
    },
    fetchDerivedOwners,
    upsert: upsert as unknown as ReconcileDeps["upsert"],
    writeSyncStatus,
    log: () => {},
  };
  return { deps, walkedMints, upsert, writeSyncStatus, snapshot, fetchDerivedOwners };
}

const opts = (over: Partial<ReconcileOpts> = {}): ReconcileOpts => ({
  dry: false,
  force: false,
  collection: "pythians",
  full: false,
  verifyOff: false,
  ...over,
});

describe("runReconcile — incremental vs --full walk selection", () => {
  it("incremental walks ONLY drifted mints and upserts only their events", async () => {
    const h = harness();
    await runReconcile(opts(), h.deps);

    expect(h.walkedMints).toEqual(["B", "C"]); // A agreed → never walked
    expect(h.upsert).toHaveBeenCalledTimes(1);
    const upserted = h.upsert.mock.calls[0][0] as CollectionEvent[];
    expect(upserted.map((e) => e.nftMint).sort()).toEqual(["B", "C"]);
    // gate passed at 100% (non-walked members match by construction) → recorded 'passed'
    expect(h.writeSyncStatus).toHaveBeenCalledWith(
      expect.objectContaining({ collectionKey: "pythians", lastReconcileResult: "passed" }),
    );
  });

  it("--full walks ALL members (original behavior) and upserts everything", async () => {
    const h = harness();
    await runReconcile(opts({ full: true }), h.deps);

    expect(h.walkedMints).toEqual(["A", "B", "C"]);
    expect(h.fetchDerivedOwners).not.toHaveBeenCalled(); // full mode never reads the derived set
    const upserted = h.upsert.mock.calls[0][0] as CollectionEvent[];
    expect(upserted.map((e) => e.nftMint).sort()).toEqual(["A", "B", "C"]);
  });

  it("--dry performs no writes (no upsert, no sync-status)", async () => {
    const h = harness();
    await runReconcile(opts({ dry: true }), h.deps);

    expect(h.walkedMints).toEqual(["B", "C"]);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.writeSyncStatus).not.toHaveBeenCalled();
  });
});

describe("runReconcile — §4.5 gate semantics preserved", () => {
  it("throws below the gate (no upsert) and records 'failed'", async () => {
    // B's fresh walk STILL disagrees with DAS (Y expected, STRANGER derived) → 2/3 = 66.67% < 99%.
    const h = harness({ eventsByMint: { B: [ev("B", "STRANGER")], C: [ev("C", "Z")] } });
    await expect(runReconcile(opts(), h.deps)).rejects.toThrow(/reconciliation .* < 99% gate/);

    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.writeSyncStatus).toHaveBeenCalledWith(expect.objectContaining({ lastReconcileResult: "failed" }));
  });

  it("--force upserts despite a failed gate (still recorded 'failed')", async () => {
    const h = harness({ eventsByMint: { B: [ev("B", "STRANGER")], C: [ev("C", "Z")] } });
    await runReconcile(opts({ force: true }), h.deps);

    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.writeSyncStatus).toHaveBeenCalledWith(expect.objectContaining({ lastReconcileResult: "failed" }));
  });
});

describe("runReconcile — --verify-off (Helius dark)", () => {
  it("skips the DAS snapshot entirely and records 'skipped-no-das'", async () => {
    const h = harness();
    await runReconcile(opts({ verifyOff: true }), h.deps);

    expect(h.snapshot).not.toHaveBeenCalled();
    expect(h.fetchDerivedOwners).not.toHaveBeenCalled();
    expect(h.walkedMints).toEqual([]);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.writeSyncStatus).toHaveBeenCalledWith(
      expect.objectContaining({ collectionKey: "pythians", lastReconcileResult: "skipped-no-das" }),
    );
  });

  it("is a tolerated no-op when no sync-status writer is injected", async () => {
    const h = harness();
    const { writeSyncStatus: _omit, ...deps } = h.deps;
    await expect(runReconcile(opts({ verifyOff: true }), deps)).resolves.toBeUndefined();
  });
});
