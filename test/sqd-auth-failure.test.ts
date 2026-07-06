/**
 * T-4: Auth Failure Test — SqdAuthRequiredError surfaces on 401/403, is not retried,
 * carries diagnostic fields, and produces zero upsert calls.
 *
 * Distinct from sqd-kill-switch.test.ts (kill switch covers env-var halt; this covers
 * the auth-error path). Zero external dependencies — runs unconditionally in CI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqdAuthRequiredError, SqdClient } from "../src/svm/sqd-client";
import { runSqdLoader, type SqdLoaderDeps } from "../src/svm/sqd-loader";

const MINT = "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

function makeDeps(status: 401 | 403): { deps: SqdLoaderDeps; upsertMock: ReturnType<typeof vi.fn> } {
  fetchMock.mockResolvedValue(new Response("", { status }));
  const upsertMock = vi.fn().mockResolvedValue(undefined);
  const deps: SqdLoaderDeps = {
    client: new SqdClient(undefined, 10),
    members: vi.fn().mockResolvedValue([MINT]),
    cursorSlot: vi.fn().mockResolvedValue(0),
    knownMints: vi.fn().mockResolvedValue([]),
    upsert: upsertMock as unknown as SqdLoaderDeps["upsert"],
    syncStatus: vi.fn().mockResolvedValue(true) as unknown as SqdLoaderDeps["syncStatus"],
    log: () => {},
  };
  return { deps, upsertMock };
}

describe("SQD auth failure — 401", () => {
  it("throws SqdAuthRequiredError (instanceof) on 401", async () => {
    const { deps } = makeDeps(401);
    await expect(runSqdLoader({ collectionKey: "mad_lads" }, deps)).rejects.toBeInstanceOf(SqdAuthRequiredError);
  });

  it("fetch called exactly once — no retry on 401", async () => {
    const { deps } = makeDeps(401);
    await runSqdLoader({ collectionKey: "mad_lads" }, deps).catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("zero upsert calls on 401", async () => {
    const { deps, upsertMock } = makeDeps(401);
    await runSqdLoader({ collectionKey: "mad_lads" }, deps).catch(() => {});
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("error carries status:401, url (string), blockHeight (number)", async () => {
    const { deps } = makeDeps(401);
    const err = await runSqdLoader({ collectionKey: "mad_lads" }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(SqdAuthRequiredError);
    expect((err as SqdAuthRequiredError).status).toBe(401);
    expect(typeof (err as SqdAuthRequiredError).url).toBe("string");
    expect(typeof (err as SqdAuthRequiredError).blockHeight).toBe("number");
  });
});

describe("SQD auth failure — 403", () => {
  it("throws SqdAuthRequiredError (instanceof) on 403", async () => {
    const { deps } = makeDeps(403);
    await expect(runSqdLoader({ collectionKey: "mad_lads" }, deps)).rejects.toBeInstanceOf(SqdAuthRequiredError);
  });

  it("fetch called exactly once — no retry on 403", async () => {
    const { deps } = makeDeps(403);
    await runSqdLoader({ collectionKey: "mad_lads" }, deps).catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("zero upsert calls on 403", async () => {
    const { deps, upsertMock } = makeDeps(403);
    await runSqdLoader({ collectionKey: "mad_lads" }, deps).catch(() => {});
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("error carries status:403, url (string), blockHeight (number)", async () => {
    const { deps } = makeDeps(403);
    const err = await runSqdLoader({ collectionKey: "mad_lads" }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(SqdAuthRequiredError);
    expect((err as SqdAuthRequiredError).status).toBe(403);
    expect(typeof (err as SqdAuthRequiredError).url).toBe("string");
    expect(typeof (err as SqdAuthRequiredError).blockHeight).toBe("number");
  });
});
