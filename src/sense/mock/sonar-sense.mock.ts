/**
 * sonar-sense.mock.ts — deterministic fixtures for the SonarSense port.
 *
 * The `mock/` leaf of the honeycomb four-folder. Test-first: it lets Score (and
 * the CLI tests) bind the port and exercise ALL THREE grounding branches before
 * `live/` exists. Grounding is resolved per call in this precedence:
 *   1. `groundingOverrides` — pin a specific verb+actor (Score's parity-check
 *      wants "balance grounded, owns refuted" for the same owner);
 *   2. sentinel addresses (REFUTED_ADDRESS / UNVERIFIABLE_ADDRESS);
 *   3. default `grounded`.
 * Values come from the fixture maps (or sensible defaults).
 */

import { grounded, refuted, unverifiable } from "../domain/observation.domain";
import type { Grounding, Observation, ObservationInit } from "../domain/observation.domain";
import type { Address, ChainId, ReadOptions, SenseHealth, SonarSense } from "../ports/sonar-sense.port";

const MOCK_SOURCE = "mock:sonar-sense";
/** Fixed block height stamped on grounded chain reads (exercises the field). */
const MOCK_BLOCK = 1_000_000;

/** Any verb addressed to this returns `refuted` (simulates two sources contradicting). */
export const REFUTED_ADDRESS = ("0x" + "0".repeat(36) + "dead") as Address;
/** Any verb addressed to this returns `unverifiable` (simulates degraded / can't-check). */
export const UNVERIFIABLE_ADDRESS = ("0x" + "0".repeat(36) + "fade") as Address;

/** Optional canned values, keyed deterministically; unknown keys fall back to defaults. */
export interface MockFixtures {
  /** key `${chain}:${owner}:${token}` → ERC-20 balance */
  readonly balances?: Readonly<Record<string, bigint>>;
  /** key `${chain}:${account}` → native balance */
  readonly nativeBalances?: Readonly<Record<string, bigint>>;
  /** key `${chain}:${owner}:${collection}:${tokenId ?? "*"}` → owns? */
  readonly ownerships?: Readonly<Record<string, boolean>>;
  /** key `${chain}:${address}:${fnSig}` → decoded read value */
  readonly reads?: Readonly<Record<string, unknown>>;
  /**
   * Pin a grounding per verb+primary-actor, checked BEFORE the address
   * sentinels. Key: `${verb}:${chain}:${primary}` where `primary` is the actor
   * (owner / account / read-target). e.g. `{ "balance:80094:0xabc…": "refuted" }`
   * pins that one balance read while every other verb/owner defaults normally.
   */
  readonly groundingOverrides?: Readonly<Record<string, Grounding>>;
  /** doctor() health — default healthy. */
  readonly healthy?: boolean;
}

/** Which grounding (if any) the sentinel addresses force. Refuted wins over unverifiable. */
function forcedBySentinel(...addrs: readonly Address[]): Grounding | null {
  if (addrs.includes(REFUTED_ADDRESS)) return "refuted";
  if (addrs.includes(UNVERIFIABLE_ADDRESS)) return "unverifiable";
  return null;
}

/** Resolve grounding: explicit override → sentinel → default grounded. */
function groundingOf(
  fixtures: MockFixtures,
  verb: string,
  chain: ChainId,
  primary: Address,
  ...others: readonly Address[]
): Grounding {
  const override = fixtures.groundingOverrides?.[`${verb}:${chain}:${primary}`];
  if (override) return override;
  return forcedBySentinel(primary, ...others) ?? "grounded";
}

/** Build an Observation for a dynamically-resolved grounding. */
function buildAs<T>(grounding: Grounding, init: ObservationInit<T>): Observation<T> {
  switch (grounding) {
    case "grounded":
      return grounded<T>(init);
    case "refuted":
      return refuted<T>(init);
    case "unverifiable":
      return unverifiable<T>(init);
    default: {
      const _exhaustive: never = grounding;
      throw new Error(`unreachable grounding: ${String(_exhaustive)}`);
    }
  }
}

/** Build a mock SonarSense; pass fixtures to pin specific values / groundings. */
export function makeMockSonarSense(fixtures: MockFixtures = {}): SonarSense {
  return {
    /**
     * Health is driven by the `healthy` fixture: true ⇒ grounded (all required
     * targets up, dead-endpoint trap down); false ⇒ unverifiable (the spec's
     * fallback-degraded ⇒ unverifiable mapping). `live/` returns grounded only
     * when belt-gateway AND the RPC are up and the dead-endpoint trap is down.
     */
    async doctor() {
      const ok = fixtures.healthy ?? true;
      const value: SenseHealth = {
        ok,
        checks: [
          { target: "belt-gateway:graphql", status: ok ? "up" : "down" },
          { target: "rpc:berachain", status: ok ? "up" : "degraded" },
          { target: "dead-endpoint-trap", status: "down" }, // a known-dead endpoint is correctly down
        ],
      };
      const init = { value, source: MOCK_SOURCE, chain_id: 80094, trace_id: "mock:doctor" };
      return ok ? grounded<SenseHealth>(init) : unverifiable<SenseHealth>(init);
    },

    /** The mock does NOT validate fnSig/args (live/ + viem do). Fixture miss ⇒ grounded `undefined` (a successful empty read). */
    async read<T>(chain: ChainId, address: Address, fnSig: string, _args?: readonly unknown[], _opts?: ReadOptions) {
      const value = (fixtures.reads?.[`${chain}:${address}:${fnSig}`] as T) ?? (undefined as T);
      const init = { value, source: MOCK_SOURCE, chain_id: chain, block_number: MOCK_BLOCK, trace_id: "mock:read" };
      return buildAs<T>(groundingOf(fixtures, "read", chain, address), init);
    },

    async balance(chain, owner, token, _opts) {
      const value = fixtures.balances?.[`${chain}:${owner}:${token}`] ?? 0n;
      const init = { value, source: MOCK_SOURCE, chain_id: chain, block_number: MOCK_BLOCK, trace_id: "mock:balance" };
      return buildAs<bigint>(groundingOf(fixtures, "balance", chain, owner, token), init);
    },

    async owns(chain, owner, collection, tokenId, _opts) {
      const key = `${chain}:${owner}:${collection}:${tokenId ?? "*"}`;
      const value = fixtures.ownerships?.[key] ?? false;
      const init = { value, source: MOCK_SOURCE, chain_id: chain, block_number: MOCK_BLOCK, trace_id: "mock:owns" };
      return buildAs<boolean>(groundingOf(fixtures, "owns", chain, owner, collection), init);
    },

    async native(chain, account, _opts) {
      const value = fixtures.nativeBalances?.[`${chain}:${account}`] ?? 0n;
      const init = { value, source: MOCK_SOURCE, chain_id: chain, block_number: MOCK_BLOCK, trace_id: "mock:native" };
      return buildAs<bigint>(groundingOf(fixtures, "native", chain, account), init);
    },
  };
}

/** A ready-to-bind default mock (no custom fixtures). */
export const mockSonarSense: SonarSense = makeMockSonarSense();
