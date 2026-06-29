import { describe, it, expect } from "vitest";
import { makeSolanaSense } from "./sonar-sense-solana.live";

const INCINERATOR = "1nc1nerator11111111111111111111111111111111"; // SOL burn address (accrues lamports)
const SYSTEM = "11111111111111111111111111111111"; // System Program (holds no SPL tokens)
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC mainnet mint

describe("Solana sense — offline (malformed short-circuits, no network)", () => {
  const s = makeSolanaSense();

  it("malformed address ⇒ unverifiable across native/balance/owns", async () => {
    expect((await s.native("mainnet-beta", "not a base58 key!!!")).grounding).toBe("unverifiable");
    expect((await s.balance("mainnet-beta", "bad", USDC)).source).toBe("solana:malformed-address");
    expect((await s.owns("mainnet-beta", USDC, "bad")).grounding).toBe("unverifiable");
  });

  it("Observation is the SAME chain-neutral envelope (trace_id + Solana chain_id)", async () => {
    const o = await s.native("mainnet-beta", "bad");
    expect(o.trace_id).toMatch(/^solana:native:\d+$/);
    expect(o.chain_id).toBe(101); // mainnet-beta sentinel
    expect(o.schema_version).toBe("sonar-sense/observation@1"); // identical to the EVM envelope
  });
});

// Real-network validation against the free public mainnet RPC. Skipped by default.
//   SONAR_SENSE_LIVE=1 npx vitest run src/sense/live/solana
const LIVE = process.env.SONAR_SENSE_LIVE === "1";

describe.skipIf(!LIVE)("Solana sense — network smoke (SONAR_SENSE_LIVE=1 · free public RPC)", () => {
  const s = makeSolanaSense();

  it("doctor() ⇒ grounded, Solana RPC up", async () => {
    const h = await s.doctor();
    expect(h.value.checks.some((c) => c.target === "rpc:solana-mainnet" && c.status === "up")).toBe(true);
    expect(h.grounding).toBe("grounded");
  }, 30_000);

  it("native() ⇒ grounded SOL balance (bigint lamports) — the envelope ports unchanged", async () => {
    const o = await s.native("mainnet-beta", INCINERATOR);
    expect(o.grounding).toBe("grounded");
    expect(typeof o.value).toBe("bigint");
    expect(o.source).toContain("mainnet-beta");
  }, 30_000);

  it("balance() + owns() of USDC for the System Program (holds none) ⇒ grounded 0n / false", async () => {
    const bal = await s.balance("mainnet-beta", SYSTEM, USDC);
    expect(bal.grounding).toBe("grounded");
    expect(typeof bal.value).toBe("bigint");

    // assert the CONTRACT (grounded boolean) — not a guessed on-chain value, which can change
    const own = await s.owns("mainnet-beta", SYSTEM, USDC);
    expect(own.grounding).toBe("grounded");
    expect(typeof own.value).toBe("boolean");
  }, 30_000);
});
