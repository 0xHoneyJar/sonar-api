/*
 * protocols.ts — THE protocol-events registry.
 *
 * A protocol entry is a contract whose NAMED events are member behaviors we
 * record as Action rows (stake, stir, borrow, vote, …). It is the third kind of
 * registration, distinct from the other two:
 *
 *   contracts.ts     — token contracts: who HOLDS what (balances, transfers)
 *   marketplaces.ts  — venues: sale settlement, never holder credit
 *   protocols.ts     — protocol contracts: what members DO (one Action per event)
 *
 * The split matters for volume as much as meaning. Generic Transfer streams on
 * DeFi tokens are what blew the 44 GB Action table (see tracked-erc20.ts); named
 * protocol events are orders of magnitude rarer and every one is already a
 * labeled behavior — no downstream classification, no heuristics. Register only
 * events a consumer will read; goldilocks' full core ring measured ~23.7k events
 * total (docs in score-api: docs/research/2026-08-10-goldilocks-protocol-map.md).
 *
 * Adding a protocol is entries here + `pnpm gen:config` + a literal
 * `indexer.onEvent` line in src/handlers/protocol-events.ts for any event NAME
 * not already handled (the bijection checker reads call sites literally, so
 * they cannot be generated in a loop). Same event name on two protocols must
 * share one exact signature — asserted at module load, because one Envio
 * binding carries one event set for its whole address list.
 *
 * `signature` must match the chain's ABI exactly (types AND indexed-ness);
 * param NAMES are ours to choose and become `event.params` keys. Verify against
 * the verified source before registering — a wrong indexed marker decodes
 * garbage rather than failing loudly.
 */

import { TRACKED_CONTRACTS, type TokenStandard } from "./contracts";

export interface ProtocolEventSpec {
  /** Full human-readable ABI signature with named params, e.g. "Stake(address indexed user, uint256 amount)". */
  readonly signature: string;
  /** The Action.actionType this event records — score-api's bronze verb, e.g. "stake". */
  readonly verb: string;
  /** Param name carrying the member wallet (becomes Action.actor, lowercased). */
  readonly actorParam: string;
  /** Param name for Action.numeric1 (raw amount / weight / id). Omit = no numeric. */
  readonly amountParam?: string;
  /** Params copied into Action.context (stringified — bigints become strings). */
  readonly contextParams?: readonly string[];
}

export interface ProtocolEntry {
  /** Community key — becomes Action.primaryCollection, so score-api's existing
   *  bronze pull (filtering primaryCollection ∈ its category_keys) ingests these
   *  rows with zero changes. Must match the community's score-api category_key. */
  readonly community: string;
  /** Human label — protocol + contract role, becomes the YAML comment. */
  readonly label: string;
  /** Lowercased 0x address. May ALSO be tracked in contracts.ts under a token
   *  standard (a token contract that emits protocol events is common — e.g.
   *  goldilocks' Goldilocked is both the PRG ERC-20 and the staking hub). */
  readonly address: string;
  readonly chain: number;
  readonly startBlock: number;
  readonly events: readonly ProtocolEventSpec[];
}

// prettier-ignore
export const PROTOCOLS: readonly ProtocolEntry[] = [
  // Goldilocks (Berachain) — first DeFi/DAO community with behavior depth.
  // All four contracts deployed in block 801948 (receipts verified 2026-08-10).
  // Core ring only, DELIBERATELY: Buy/Sale (~19k) and Claim (~7.3k routine
  // reward claims) are excluded until there is a consumer; the chain is the
  // archive. Event signatures verified against Routescan-verified source +
  // live logs 2026-08-10: all six Goldiswap/Goldilocked events carry the user
  // INDEXED (topics=2, one data word) — verified per-topic against real logs.
  {
    community: "goldilocks", label: "Goldilocked (PRG) — staking + borrowing hub",
    address: "0xbf2e152f460090ace91a456e3dee5acf703f27ad", chain: 80094, startBlock: 801948,
    events: [
      { signature: "Stake(address indexed user, uint256 amount)",   verb: "stake",   actorParam: "user", amountParam: "amount" },
      { signature: "Unstake(address indexed user, uint256 amount)", verb: "unstake", actorParam: "user", amountParam: "amount" },
      { signature: "Stir(address indexed user, uint256 amount)",    verb: "stir",    actorParam: "user", amountParam: "amount" },
      { signature: "Borrow(address indexed user, uint256 amount)",  verb: "borrow",  actorParam: "user", amountParam: "amount" },
      { signature: "Repay(address indexed user, uint256 amount)",   verb: "repay",   actorParam: "user", amountParam: "amount" },
    ],
  },
  {
    community: "goldilocks", label: "Goldiswap (LOCKS) — floor redemptions",
    address: "0xb7e448e5677d212b8c8da7d6312e8afc49800466", chain: 80094, startBlock: 801948,
    events: [
      { signature: "Redeem(address indexed user, uint256 amount)", verb: "redeem", actorParam: "user", amountParam: "amount" },
    ],
  },
  {
    community: "goldilocks", label: "Goldigovernance — GGP proposals + votes",
    address: "0x6c00d68dc6bcc3d47d698f4b566ccbe893d34fed", chain: 80094, startBlock: 801948,
    events: [
      { signature: "ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)",
        verb: "propose", actorParam: "proposer", amountParam: "proposalId", contextParams: ["proposalId"] },
      { signature: "VoteCast(address indexed voter, uint256 proposalId, uint8 support, uint256 weight, string reason)",
        verb: "vote", actorParam: "voter", amountParam: "weight", contextParams: ["proposalId", "support"] },
    ],
  },
  {
    community: "goldilocks", label: "GovLocks — vote delegation",
    address: "0xb9798e0e3ab8b2f2c80684c9d51056538e021dac", chain: 80094, startBlock: 801948,
    events: [
      { signature: "DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate)",
        verb: "delegate", actorParam: "delegator", contextParams: ["fromDelegate", "toDelegate"] },
    ],
  },
];

/** Event name from a signature: "Stake(address user, …)" → "Stake". */
export function eventNameOf(signature: string): string {
  return signature.slice(0, signature.indexOf("("));
}

/** Dedupe by event name, throwing if one name carries two signatures. A binding
 *  carries ONE signature per event name, and the same protocol event may end up
 *  split across bindings (see protocolBindingPlan) — global uniqueness keeps
 *  every possible placement consistent. */
function dedupeByName(specs: Iterable<ProtocolEventSpec>): string[] {
  const byName = new Map<string, string>();
  for (const e of specs) {
    const name = eventNameOf(e.signature);
    const prior = byName.get(name);
    if (prior && prior !== e.signature) {
      throw new Error(
        `protocol event name collision: "${name}" declared as both "${prior}" and "${e.signature}" — one binding carries one signature per event name`,
      );
    }
    byName.set(name, e.signature);
  }
  return [...byName.values()];
}

// Validate global name uniqueness at module load, before any binding split.
dedupeByName(PROTOCOLS.flatMap((p) => p.events));

/**
 * How protocol entries map onto Envio bindings.
 *
 * Envio refuses one address under two contract definitions (verified against
 * envio 3.2.1: "Indexing the same address with multiple contract definitions is
 * not supported"). A protocol contract that is ALSO a tracked token (goldilocks'
 * Goldilocked is the PRG ERC-20 *and* the staking hub) therefore cannot join a
 * standalone ProtocolEvents binding — its protocol events must ride the token
 * lane that already owns the address. Extra event signatures on a token lane
 * cost nothing for addresses that never emit them, and the handler dispatch is
 * registry-keyed by (chain, address, event name), so WHICH binding delivers an
 * event is pure config plumbing.
 *
 *   standalone — entries whose address is not token-tracked → the
 *                ProtocolEvents binding (its own address list + event union)
 *   merged     — per token standard, the extra event signatures that lane's
 *                binding must carry for its protocol-emitting addresses
 */
export interface ProtocolBindingPlan {
  readonly standalone: readonly ProtocolEntry[];
  readonly merged: ReadonlyMap<TokenStandard, readonly string[]>;
}

export function protocolBindingPlan(): ProtocolBindingPlan {
  const laneByKey = new Map(TRACKED_CONTRACTS.map((c) => [`${c.chain}:${c.address}`, c.standard]));
  const standalone: ProtocolEntry[] = [];
  const mergedSpecs = new Map<TokenStandard, ProtocolEventSpec[]>();
  for (const p of PROTOCOLS) {
    const lane = laneByKey.get(`${p.chain}:${p.address}`);
    if (!lane) {
      standalone.push(p);
      continue;
    }
    mergedSpecs.set(lane, [...(mergedSpecs.get(lane) ?? []), ...p.events]);
  }
  const merged = new Map<TokenStandard, readonly string[]>();
  for (const [lane, specs] of mergedSpecs) merged.set(lane, dedupeByName(specs));
  return { standalone, merged };
}

/** The event union for the standalone ProtocolEvents binding. */
export function protocolEventUnion(): string[] {
  return dedupeByName(protocolBindingPlan().standalone.flatMap((p) => p.events));
}

/** Handler dispatch: `${chain}:${address}` → community + (eventName → spec). */
export interface ProtocolDispatch {
  readonly community: string;
  readonly byEvent: ReadonlyMap<string, ProtocolEventSpec>;
}

function buildDispatch(): Map<string, ProtocolDispatch> {
  const out = new Map<string, ProtocolDispatch>();
  for (const p of PROTOCOLS) {
    out.set(`${p.chain}:${p.address}`, {
      community: p.community,
      byEvent: new Map(p.events.map((e) => [eventNameOf(e.signature), e])),
    });
  }
  return out;
}

const DISPATCH = buildDispatch();

export function findProtocol(chain: number, address: string): ProtocolDispatch | undefined {
  return DISPATCH.get(`${chain}:${address.toLowerCase()}`);
}
