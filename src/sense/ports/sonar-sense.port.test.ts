import { describe, it, expect } from "vitest";
import { grounded, type Observation } from "../domain/observation.domain";
import type { Address, ChainId, ReadOptions, SenseHealth, SonarSense } from "./sonar-sense.port";

// Compile-time + runtime proof that the port is IMPLEMENTABLE and every verb
// hands back an Observation that composes with the domain builders. The real
// deterministic fixtures live in mock/sonar-sense.mock.ts (bd-zfj.3).
const stub: SonarSense = {
  async doctor() {
    return grounded<SenseHealth>({
      value: { ok: true, checks: [] },
      source: "stub",
      chain_id: 80094,
      trace_id: "doctor",
    });
  },
  async read<T>(
    chain: ChainId,
    _address: Address,
    _fnSig: string,
    _args?: readonly unknown[],
    _opts?: ReadOptions,
  ): Promise<Observation<T>> {
    return grounded<T>({ value: undefined as T, source: "stub", chain_id: chain, trace_id: "read" });
  },
  async balance(chain, _owner, _token) {
    return grounded<bigint>({ value: 0n, source: "stub", chain_id: chain, trace_id: "balance" });
  },
  async owns(chain, _owner, _collection) {
    return grounded<boolean>({ value: false, source: "stub", chain_id: chain, trace_id: "owns" });
  },
  async native(chain, _account) {
    return grounded<bigint>({ value: 0n, source: "stub", chain_id: chain, trace_id: "native" });
  },
};

const ADDR_A = "0x0000000000000000000000000000000000000001" as Address;
const ADDR_B = "0x0000000000000000000000000000000000000002" as Address;

describe("SonarSense port", () => {
  it("is implementable and doctor() returns a health Observation", async () => {
    const health: Observation<SenseHealth> = await stub.doctor();
    expect(health.value.ok).toBe(true);
    expect(health.grounding).toBe("grounded");
    expect(health.trace_id).toBe("doctor");
  });

  it("balance/owns/native return correctly-typed Observations", async () => {
    const bal = await stub.balance(80094, ADDR_A, ADDR_B);
    expect(bal.value).toBe(0n); // bigint
    expect(bal.trace_id).toBe("balance");

    const own = await stub.owns(80094, ADDR_A, ADDR_B);
    expect(own.value).toBe(false); // boolean
    expect(own.chain_id).toBe(80094);

    const nat = await stub.native(80094, ADDR_A);
    expect(nat.value).toBe(0n); // bigint
  });

  it("read<T> threads the generic value type through the Observation", async () => {
    const owner = await stub.read<Address>(80094, ADDR_B, "function ownerOf(uint256) view returns (address)", [1n]);
    // value is typed Observation<Address>; at runtime the stub returns undefined
    expect(owner.grounding).toBe("grounded");
    expect(owner.chain_id).toBe(80094);
  });
});
