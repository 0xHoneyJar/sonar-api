/*
 * tracked-nft-contracts-read-failure.test.ts — the config-read failure path (review MEDIUM-1).
 *
 * Two properties are in tension and both must hold:
 *
 *   BOUNDED    — an unreadable config must not cost one readFileSync per event. Since
 *                sprint-bug-191 the caller is every ERC-721 Transfer (2.65M on chain 1
 *                alone), not just Seaport fills, and the one-shot error log would hide a
 *                syscall storm behind a single line: the operator sees one error and then
 *                a belt that is inexplicably slow.
 *   SELF-HEALING — but the failure must NOT be cached forever (BB SEA-004), or one
 *                transient FS error at startup disables sale attribution and collection
 *                naming for the whole process lifetime.
 *
 * Only the retry RATE is bounded. Both assertions below are needed: either one alone is
 * satisfied by a trivially wrong implementation (cache forever / never cache).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let reads: string[] = [];

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (path: unknown, ...rest: unknown[]) => {
      reads.push(String(path));
      // @ts-expect-error — pass through to the real implementation
      return actual.readFileSync(path, ...rest);
    },
  };
});

const MISSING = "/tmp/sonar-nonexistent-config-for-test.yaml";
const GOOD = "config.yaml";

const BASED_PUNKS = "0xcb28749c24af4797808364d71d71539bc01e76d4";

/** Fresh module state per test — the cache and the retry clock are module-scoped. */
async function freshModule(configPath: string) {
  vi.resetModules();
  process.env.BELT_CONFIG = configPath;
  reads = [];
  return import("../src/handlers/marketplaces/tracked-nft-contracts");
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BELT_CONFIG;
});

describe("unreadable config — bounded cost", () => {
  it("does not re-read the config on every handler call", async () => {
    const { collectionKeyFor } = await freshModule(MISSING);

    for (let i = 0; i < 50_000; i++) collectionKeyFor(8453, BASED_PUNKS);

    // One read for the first call; the retry window suppresses the other 49,999.
    // A per-event retry would put 50,000 here.
    expect(reads.filter((p) => p === MISSING)).toHaveLength(1);
  });

  it("still degrades soft — no throw, and every collection falls back to its address", async () => {
    const { collectionKeyFor, isTrackedNftContract } = await freshModule(MISSING);

    expect(collectionKeyFor(8453, BASED_PUNKS)).toBeNull();
    expect(isTrackedNftContract(8453, BASED_PUNKS)).toBe(false);
  });

  it("logs the failure exactly once, naming the path and the cwd", async () => {
    const { collectionKeyFor } = await freshModule(MISSING);
    const spy = vi.mocked(console.error);

    for (let i = 0; i < 1_000; i++) collectionKeyFor(8453, BASED_PUNKS);

    const failureLogs = spy.mock.calls.filter((c) =>
      String(c[0]).includes("could not read"),
    );
    expect(failureLogs).toHaveLength(1);
    expect(String(failureLogs[0][0])).toContain(MISSING);
    expect(String(failureLogs[0][0])).toContain("cwd=");
  });
});

describe("unreadable config — still self-healing", () => {
  it("retries once the interval elapses (the failure is rate-limited, not cached)", async () => {
    const { collectionKeyFor } = await freshModule(MISSING);

    expect(collectionKeyFor(8453, BASED_PUNKS)).toBeNull();
    expect(reads.filter((p) => p === MISSING)).toHaveLength(1);

    // Advance past READ_RETRY_INTERVAL_MS without waiting on a real clock.
    const realNow = Date.now;
    try {
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + 6_000);
      collectionKeyFor(8453, BASED_PUNKS);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }

    expect(
      reads.filter((p) => p === MISSING),
      "a second read must happen after the interval — otherwise one transient FS error " +
        "disables collection naming for the whole process lifetime (BB SEA-004)",
    ).toHaveLength(2);
  });
});

describe("readable config — cached, read exactly once", () => {
  it("reads the config once no matter how many events arrive", async () => {
    const { collectionKeyFor } = await freshModule(GOOD);

    for (let i = 0; i < 50_000; i++) {
      expect(collectionKeyFor(8453, BASED_PUNKS)).toBe("based_punks");
    }

    expect(reads.filter((p) => p === GOOD)).toHaveLength(1);
  });
});
