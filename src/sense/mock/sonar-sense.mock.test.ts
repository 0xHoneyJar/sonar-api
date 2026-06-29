import { describe, it, expect } from "vitest";
import { makeMockSonarSense, mockSonarSense, REFUTED_ADDRESS, UNVERIFIABLE_ADDRESS } from "./sonar-sense.mock";
import type { Address } from "../ports/sonar-sense.port";

const OWNER = ("0x" + "0".repeat(39) + "1") as Address;
const TOKEN = ("0x" + "0".repeat(39) + "2") as Address;
const COLLECTION = ("0x" + "0".repeat(39) + "3") as Address;
const BERA = 80094;

describe("mock SonarSense", () => {
  it("doctor() is grounded+ok by default, unverifiable when unhealthy; dead-endpoint trap stays down", async () => {
    const ok = await mockSonarSense.doctor();
    expect(ok.grounding).toBe("grounded");
    expect(ok.value.ok).toBe(true);
    expect(ok.value.checks.some((c) => c.target === "dead-endpoint-trap" && c.status === "down")).toBe(true);

    const sick = await makeMockSonarSense({ healthy: false }).doctor();
    expect(sick.grounding).toBe("unverifiable");
    expect(sick.value.ok).toBe(false);
  });

  it("balance() returns grounded fixture value; sentinels force refuted/unverifiable", async () => {
    const m = makeMockSonarSense({ balances: { [`${BERA}:${OWNER}:${TOKEN}`]: 500n } });
    const g = await m.balance(BERA, OWNER, TOKEN);
    expect(g.grounding).toBe("grounded");
    expect(g.value).toBe(500n);
    expect(g.block_number).toBe(1_000_000);

    expect((await m.balance(BERA, REFUTED_ADDRESS, TOKEN)).grounding).toBe("refuted");
    expect((await m.balance(BERA, UNVERIFIABLE_ADDRESS, TOKEN)).grounding).toBe("unverifiable");
  });

  it("owns() honours the tokenId key + fixtures + sentinels", async () => {
    const m = makeMockSonarSense({ ownerships: { [`${BERA}:${OWNER}:${COLLECTION}:7`]: true } });
    const yes = await m.owns(BERA, OWNER, COLLECTION, 7n);
    expect(yes.grounding).toBe("grounded");
    expect(yes.value).toBe(true);

    const unknownToken = await m.owns(BERA, OWNER, COLLECTION, 8n);
    expect(unknownToken.value).toBe(false); // unknown tokenId → default false, still grounded
    expect(unknownToken.grounding).toBe("grounded");

    expect((await m.owns(BERA, REFUTED_ADDRESS, COLLECTION)).grounding).toBe("refuted");
  });

  it("native() defaults to 0n grounded; sentinel forces unverifiable", async () => {
    const g = await mockSonarSense.native(BERA, OWNER);
    expect(g.grounding).toBe("grounded");
    expect(g.value).toBe(0n);
    expect((await mockSonarSense.native(BERA, UNVERIFIABLE_ADDRESS)).grounding).toBe("unverifiable");
  });

  it("read() returns the fixture value grounded, undefined by default, sentinel refuted", async () => {
    const sig = "function ownerOf(uint256) view returns (address)";
    const m = makeMockSonarSense({ reads: { [`${BERA}:${TOKEN}:${sig}`]: "0xowner" } });
    const g = await m.read<string>(BERA, TOKEN, sig, [1n]);
    expect(g.grounding).toBe("grounded");
    expect(g.value).toBe("0xowner");

    const unknown = await m.read(BERA, TOKEN, "function totalSupply() view returns (uint256)");
    expect(unknown.value).toBeUndefined();
    expect(unknown.grounding).toBe("grounded");

    expect((await m.read(BERA, REFUTED_ADDRESS, sig)).grounding).toBe("refuted");
  });

  it("groundingOverrides pin a specific verb+actor, taking precedence over the default", async () => {
    const m = makeMockSonarSense({
      balances: { [`${BERA}:${OWNER}:${TOKEN}`]: 500n },
      groundingOverrides: { [`balance:${BERA}:${OWNER}`]: "refuted" },
    });
    const r = await m.balance(BERA, OWNER, TOKEN);
    expect(r.grounding).toBe("refuted"); // override wins over the default grounded
    expect(r.value).toBe(500n); // ...but the value is still served (downgrade, not drop)
    // a different verb for the same owner is unaffected
    expect((await m.native(BERA, OWNER)).grounding).toBe("grounded");
  });
});
