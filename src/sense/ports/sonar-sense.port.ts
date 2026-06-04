/**
 * sonar-sense.port.ts — the declared sense-EDGE (the identity Score binds).
 *
 * This is the `ports/` leaf of the honeycomb four-folder: a pure interface,
 * Sonar-owned. `live/` (viem runtime) and `mock/` (fixtures) provide the
 * behaviour; consumers depend on THIS, never the runtime — port-in-engine,
 * runtime-in-module. Every verb returns a `Promise<Observation<T>>` so the
 * epistemic frame (grounding · tier · trace_id) rides every read.
 *
 * Verbs map to loa-freeside `IChainProvider` shapes where they overlap
 * (`balance`→getBalance, `owns`→ownsNFT, `native`→getNativeBalance) for
 * portability to the V2 shared-building extraction; `read` is first-party
 * (a direct viem readContract — IChainProvider has no generic read verb).
 *
 * V1 scope: doctor · read · balance · owns · native. `category`/`categories`
 * are deferred to V2 (no grounded Sonar index source yet — spec fork D-V1).
 */

import type { Observation } from "../domain/observation.domain";

/** EVM address (0x-hex; checksummed or lowercase). */
export type Address = `0x${string}`;

/**
 * Numeric chain id. We narrow loa-freeside `IChainProvider`'s `number | string`
 * to `number` (Berachain = 80094); this matches `Observation.chain_id`. Widen
 * at the V2 shared-building extraction if a string-keyed chain ever appears.
 */
export type ChainId = number;

/**
 * Read options. `blockNumber` pins a point-in-time read; `verify` selects the
 * cross-checked grounding path — read the same call from ≥2 independent
 * upstreams and judge agreement. This is the verify spine Score's parity-check
 * binds. (V2 MAY add more optional fields — additive, backward-compatible.)
 */
export interface ReadOptions {
  /** read state at a specific block height; defaults to latest. */
  readonly blockNumber?: bigint;
  /**
   * Cross-check across independent upstreams: ≥2 agree ⇒ grounded · they
   * contradict ⇒ refuted · fewer than 2 respond ⇒ unverifiable. Default (false)
   * is a single fast read (grounded on success). Costs an extra RPC round —
   * use it for the parity-check / when refutation detection matters.
   */
  readonly verify?: boolean;
}

/** One probe result inside a {@link SenseHealth} report. */
export interface HealthCheck {
  /** what was probed, e.g. "belt-gateway:graphql" | "rpc:berachain" | "dead-endpoint-trap". */
  readonly target: string;
  readonly status: "up" | "down" | "degraded";
  readonly latency_ms?: number;
  readonly detail?: string;
}

/** `doctor()` payload — endpoint health, checked BEFORE any read is trusted. */
export interface SenseHealth {
  /** true iff every required target is up AND the dead-endpoint trap is correctly down. */
  readonly ok: boolean;
  readonly checks: readonly HealthCheck[];
}

/**
 * The Sonar sense-edge. Each verb returns `Promise<Observation<T>>`.
 *
 * IMPLEMENTOR CONTRACT — enforced in `live/`, NOT in the pure domain (the
 * domain is a zero-dep DTO by design, per FL-PRD-006). Every implementation:
 *  • stamps a NON-EMPTY `trace_id` on every Observation (the line back to the
 *    originating request / chain event);
 *  • keeps `confidence` within 0..1;
 *  • sets `grounding` from real signal — sources agree / cache hit ⇒ grounded ·
 *    circuit-open / fallback-degraded / single source ⇒ unverifiable · two
 *    sources contradict ⇒ refuted. Never collapse the tristate to a boolean;
 *  • on malformed input that slips past the (erased) types — bad address,
 *    chain, or fnSig — returns `unverifiable` with a descriptive `source`,
 *    NEVER throws.
 *
 * Callers SHOULD pass valid inputs (0x-hex addresses, positive chain ids). The
 * port does not validate at the type boundary — TS template-literal types are
 * erased at runtime — so the `live/` layer is the real enforcement point.
 *
 * CONSUMER NOTE — `balance`/`native` return `Observation<bigint>`, and `bigint`
 * is NOT JSON-serialisable. A consumer (the CLI, Score) MUST stringify bigints,
 * e.g. `JSON.stringify(obs, (_, v) => (typeof v === "bigint" ? v.toString() : v))`.
 */
export interface SonarSense {
  /**
   * Probe live-vs-dead endpoints (belt-gateway GraphQL + the chosen RPC + the
   * dead-endpoint trap) BEFORE any read is trusted. `ok` is false if a required
   * target is down or a known-dead endpoint answers.
   */
  doctor(): Promise<Observation<SenseHealth>>;

  /**
   * First-party contract read (mirrors viem `readContract` internals — there is
   * no `IChainProvider` delegate). `fnSig` is a VALID Solidity function
   * signature in viem `parseAbi` form, e.g.
   * "function ownerOf(uint256) view returns (address)" (no colons — they would
   * collide the mock's fixture keys); `args` line up with it positionally.
   * The implementor lets viem reject a malformed fnSig/args and returns
   * `unverifiable` (never throws). NOTE: `grounded` here means "the source
   * answered" — the value may legitimately be a zero/empty default; an unset
   * contract slot is a successful, grounded read, not an absence of grounding.
   */
  read<T = unknown>(
    chain: ChainId,
    address: Address,
    fnSig: string,
    args?: readonly unknown[],
    opts?: ReadOptions,
  ): Promise<Observation<T>>;

  /** ERC-20 balance of `token` held by `owner`. Maps `IChainProvider.getBalance(chainId, address, token)` — param order preserved. */
  balance(chain: ChainId, owner: Address, token: Address, opts?: ReadOptions): Promise<Observation<bigint>>;

  /** Does `owner` hold `collection` (optionally the specific `tokenId`)? Maps `IChainProvider.ownsNFT(chainId, address, collection, tokenId?)`. */
  owns(
    chain: ChainId,
    owner: Address,
    collection: Address,
    tokenId?: bigint,
    opts?: ReadOptions,
  ): Promise<Observation<boolean>>;

  /** Native (gas-token) balance of `account`. Maps `IChainProvider.getNativeBalance(chainId, address)`. */
  native(chain: ChainId, account: Address, opts?: ReadOptions): Promise<Observation<bigint>>;
}
