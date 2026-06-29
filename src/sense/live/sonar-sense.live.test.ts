import { describe, it, expect } from "vitest";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, ContractFunctionZeroDataError } from "viem";
import { crossCheck, isContractRevert, makeLiveSonarSense } from "./sonar-sense.live";
import type { Address } from "../ports/sonar-sense.port";

const BERA = 80094;
const BAD_ADDR = "0xnot-an-address" as Address;
const ZERO = ("0x" + "0".repeat(40)) as Address;

describe("live SonarSense — offline paths (no network: malformed/unsupported short-circuit)", () => {
  const live = makeLiveSonarSense();

  it("unsupported chain ⇒ unverifiable, never throws", async () => {
    const r = await live.balance(999999, ZERO, ZERO);
    expect(r.grounding).toBe("unverifiable");
    expect(r.source).toContain("unsupported-chain");
    expect(r.value).toBe(0n);
  });

  it("malformed address ⇒ unverifiable across balance/owns/native", async () => {
    expect((await live.balance(BERA, BAD_ADDR, ZERO)).grounding).toBe("unverifiable");
    expect((await live.owns(BERA, BAD_ADDR, ZERO)).grounding).toBe("unverifiable");
    expect((await live.native(BERA, BAD_ADDR)).grounding).toBe("unverifiable");
    expect((await live.balance(BERA, BAD_ADDR, ZERO)).source).toBe("live:malformed-address");
  });

  it("malformed fnSig ⇒ unverifiable (read)", async () => {
    const r = await live.read(BERA, ZERO, "this is not a signature");
    expect(r.grounding).toBe("unverifiable");
    expect(r.source).toBe("live:malformed-fnSig");
  });

  it("every offline Observation carries a non-empty trace_id (implementor contract)", async () => {
    const r = await live.balance(999999, ZERO, ZERO);
    expect(r.trace_id).toMatch(/^live:balance:\d+$/);
  });

  it("rejects a non-http(s) or malformed URL at construction (closes file:// / typos)", () => {
    expect(() => makeLiveSonarSense({ erpcUrl: "file:///etc/passwd" })).toThrow(/http/);
    expect(() => makeLiveSonarSense({ graphqlUrl: "not a url" })).toThrow(/valid URL/);
    // internal hosts stay ALLOWED (the legitimate eRPC path) — must NOT throw
    expect(() => makeLiveSonarSense({ erpcUrl: "http://erpc.railway.internal:4000" })).not.toThrow();
  });
});

describe("isContractRevert — revert vs transport discrimination (the owns() verify spine)", () => {
  it("a real revert ⇒ grounded false; zero-data is AMBIGUOUS (not a contract?) ⇒ unverifiable", () => {
    expect(isContractRevert(Object.create(ContractFunctionRevertedError.prototype))).toBe(true);
    expect(isContractRevert(Object.create(ContractFunctionZeroDataError.prototype))).toBe(false);
  });

  it("an execution error whose nested .cause is a revert IS a revert", () => {
    const exec = Object.assign(Object.create(ContractFunctionExecutionError.prototype), {
      cause: Object.create(ContractFunctionRevertedError.prototype),
    });
    expect(isContractRevert(exec)).toBe(true);
  });

  it("an execution error whose .cause is a NETWORK error is NOT a revert ⇒ unverifiable", () => {
    const exec = Object.assign(Object.create(ContractFunctionExecutionError.prototype), {
      cause: new Error("HttpRequestError: timeout"),
    });
    expect(isContractRevert(exec)).toBe(false);
  });

  it("plain / non-error values are not reverts", () => {
    expect(isContractRevert(new Error("boom"))).toBe(false);
    expect(isContractRevert("nope")).toBe(false);
    expect(isContractRevert(undefined)).toBe(false);
  });
});

describe("crossCheck — the grounding spine (verify)", () => {
  const ok = <T>(v: T) => (): Promise<T> => Promise.resolve(v);
  const down = (): Promise<never> => Promise.reject(new Error("rpc down"));

  it("≥2 upstreams agree ⇒ grounded", async () => {
    const r = await crossCheck([ok(100n), ok(100n)]);
    expect(r.grounding).toBe("grounded");
    expect(r.value).toBe(100n);
    expect(r.agreed).toBe(2);
  });

  it("upstreams contradict ⇒ refuted", async () => {
    expect((await crossCheck([ok(100n), ok(200n)])).grounding).toBe("refuted");
    // 3 upstreams, one dissents ⇒ still refuted
    expect((await crossCheck([ok(1n), ok(1n), ok(2n)])).grounding).toBe("refuted");
  });

  it("fewer than 2 respond ⇒ unverifiable (degraded)", async () => {
    const one = await crossCheck([ok(100n), down]);
    expect(one.grounding).toBe("unverifiable");
    expect(one.value).toBe(100n); // the single responder's value is still surfaced

    const none = await crossCheck([down, down]);
    expect(none.grounding).toBe("unverifiable");
    expect(none.value).toBeUndefined();
  });

  it("agreement is bigint-safe (sameValue, not JSON.stringify which throws on bigint)", async () => {
    const big = 123456789012345678901234567890n;
    expect((await crossCheck([ok(big), ok(big)])).grounding).toBe("grounded");
  });

  it("refuted carries NO value (contradiction ⇒ caller falls back to its default)", async () => {
    const r = await crossCheck([ok(100n), ok(200n)]);
    expect(r.grounding).toBe("refuted");
    expect(r.value).toBeUndefined();
  });

  it("a SYNCHRONOUS throw in a read-fn is a non-response, not a crash", async () => {
    const boom = (): Promise<bigint> => {
      throw new Error("sync boom");
    };
    const r = await crossCheck([ok(5n), boom]); // 1 ok + 1 sync-throw ⇒ <2 ⇒ unverifiable
    expect(r.grounding).toBe("unverifiable");
    expect(r.value).toBe(5n);
  });
});

// Real-network validation. Skipped by default so CI stays hermetic; run with:
//   SONAR_SENSE_LIVE=1 npx vitest run src/sense/live
const LIVE = process.env.SONAR_SENSE_LIVE === "1";

describe.skipIf(!LIVE)("live SonarSense — network smoke (gated by SONAR_SENSE_LIVE=1)", () => {
  const live = makeLiveSonarSense();

  it("doctor(): belt-gateway up · RPC up · dead-endpoint trap down ⇒ grounded+ok", async () => {
    const h = await live.doctor();
    const byTarget = Object.fromEntries(h.value.checks.map((c) => [c.target, c]));
    expect(byTarget["belt-gateway:graphql"].status).toBe("up");
    expect(byTarget["rpc:berachain"].status).toBe("up");
    expect(byTarget["dead-endpoint-trap"].status).toBe("down");
    expect(h.value.ok).toBe(true);
    expect(h.grounding).toBe("grounded");
  }, 30_000);

  it("native(): grounded BERA balance for the zero address", async () => {
    const r = await live.native(BERA, ZERO);
    expect(r.grounding).toBe("grounded");
    expect(typeof r.value).toBe("bigint");
  }, 30_000);

  it("verify: native() cross-checked across 2 upstreams ⇒ grounded or unverifiable, never refuted", async () => {
    const r = await live.native(BERA, ZERO, { verify: true });
    // zero-address balance is identical on both upstreams ⇒ grounded (or
    // unverifiable if one upstream is flaky) — but never refuted (same value).
    expect(["grounded", "unverifiable"]).toContain(r.grounding);
    expect(r.grounding).not.toBe("refuted");
    if (r.grounding === "grounded") expect(r.source).toContain("verify");
  }, 30_000);
});
