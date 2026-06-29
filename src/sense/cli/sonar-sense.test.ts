import { describe, it, expect } from "vitest";
import type { SonarSense } from "../ports/sonar-sense.port";
import { makeMockSonarSense, REFUTED_ADDRESS, UNVERIFIABLE_ADDRESS } from "../mock/sonar-sense.mock";
import { makeLiveSonarSense } from "../live/sonar-sense.live";
import { buildSonarSenseCli } from "./sonar-sense";

const BERA = 80094;
const OWNER = "0x" + "0".repeat(39) + "1";
const TOKEN = "0x" + "0".repeat(39) + "2";

async function run(sense: SonarSense, argv: string[]): Promise<{ out: string; code: number }> {
  const { cli, getExit } = buildSonarSenseCli(sense);
  let out = "";
  let incurCode = 0;
  await cli.serve(argv, {
    stdout: (s) => {
      out += s;
    },
    exit: (c) => {
      incurCode = c;
    },
  });
  return { out, code: incurCode !== 0 ? incurCode : (getExit() ?? 0) };
}

describe("sonar-sense CLI", () => {
  it("balance (mock) → grounded Observation, exit 0, bigint serialized to string", async () => {
    const sense = makeMockSonarSense({ balances: { [`${BERA}:${OWNER}:${TOKEN}`]: 500n } });
    const { out, code } = await run(sense, ["balance", String(BERA), OWNER, TOKEN, "--json"]);
    const o = JSON.parse(out);
    expect(o.grounding).toBe("grounded");
    expect(o.value).toBe("500"); // bigint → string, JSON-safe
    expect(o.trace_id).toMatch(/^mock:balance/);
    expect(code).toBe(0);
  });

  it("doctor (mock) → grounded, ok=true, exit 0", async () => {
    const { out, code } = await run(makeMockSonarSense(), ["doctor", "--json"]);
    const o = JSON.parse(out);
    expect(o.grounding).toBe("grounded");
    expect(o.value.ok).toBe(true);
    expect(code).toBe(0);
  });

  it("owns with --tokenId (mock) → boolean value", async () => {
    const sense = makeMockSonarSense({ ownerships: { [`${BERA}:${OWNER}:${TOKEN}:7`]: true } });
    const { out } = await run(sense, ["owns", String(BERA), OWNER, TOKEN, "--tokenId", "7", "--json"]);
    expect(JSON.parse(out).value).toBe(true);
  });

  it("refuted sentinel → exit 5 (stale/degraded)", async () => {
    const { out, code } = await run(makeMockSonarSense(), ["balance", String(BERA), REFUTED_ADDRESS, TOKEN, "--json"]);
    expect(JSON.parse(out).grounding).toBe("refuted");
    expect(code).toBe(5);
  });

  it("unverifiable sentinel → exit 5", async () => {
    const { out, code } = await run(makeMockSonarSense(), ["native", String(BERA), UNVERIFIABLE_ADDRESS, "--json"]);
    expect(JSON.parse(out).grounding).toBe("unverifiable");
    expect(code).toBe(5);
  });

  // exit 2/3 are live-reader paths (malformed/unsupported short-circuit before any network).
  it("live: malformed address → exit 2 (bad-input), no network", async () => {
    const { out, code } = await run(makeLiveSonarSense(), ["balance", String(BERA), "0xnotanaddress", TOKEN, "--json"]);
    expect(JSON.parse(out).source).toBe("live:malformed-address");
    expect(code).toBe(2);
  });

  it("live: unsupported chain → exit 3 (not-found), no network", async () => {
    const { out, code } = await run(makeLiveSonarSense(), ["balance", "999999", OWNER, TOKEN, "--json"]);
    expect(JSON.parse(out).source).toContain("unsupported-chain");
    expect(code).toBe(3);
  });

  it("live: malformed fnSig (colons) → exit 2 (enforced at the port via parseAbi)", async () => {
    const { out, code } = await run(makeLiveSonarSense(), ["read", String(BERA), TOKEN, "bad:signature", "--json"]);
    expect(JSON.parse(out).source).toBe("live:malformed-fnSig");
    expect(code).toBe(2);
  });
});
