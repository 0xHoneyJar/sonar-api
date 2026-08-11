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

  // StonkBrokers (Robinhood Chain 4663) — second deep-tracking community.
  // Recon + plan: score-api docs/research/2026-08-10-stonkbrokers-protocol-map.md.
  // Every signature's topic/data layout verified against a real HyperSync log
  // 2026-08-10 (indexed-ness from Blockscout-verified source, layout confirmed
  // per-topic). startBlock = the NFT's deploy block for the whole ring — every
  // protocol contract deployed after it, and an early startBlock only widens
  // the (cheap) HyperSync scan, never the result.
  // DELIBERATELY excluded, per the plan: the Clock In fan-out ring (Delivered/
  // CreditAccrued/DropCredited — 1.83M rows, sizing), ActivationCleared (no
  // actor param; state comes from activationOf reads), CertificateMinted
  // (double-counts CertificateBought + PullSettled), lockers (V3/V4 same-name
  // different-signature collision, 94 events, protocol-adjacent), LoanLiquidated
  // (actor = liquidator, not member; 0 events ever).
  {
    community: "stonk_brokers", label: "ActivationManager — tiered payroll registration",
    address: "0xacd5ae3c060c1137fe2ee86b0ab2ef697456f664", chain: 4663, startBlock: 12493793,
    events: [
      { signature: "Activated(uint256 indexed tokenId, address indexed owner, uint8 tier, uint256 feePaid)",
        verb: "activate", actorParam: "owner", amountParam: "feePaid", contextParams: ["tokenId", "tier"] },
      { signature: "ActivationUpgraded(uint256 indexed tokenId, address indexed owner, uint8 fromTier, uint8 toTier, uint256 feePaid)",
        verb: "upgrade_activation", actorParam: "owner", amountParam: "feePaid", contextParams: ["tokenId", "fromTier", "toTier"] },
    ],
  },
  {
    community: "stonk_brokers", label: "DirectedClockInBooster — distribution elections",
    address: "0x1f12fe622c11947f93f53d63f68f7f46b6d081c9", chain: 4663, startBlock: 12493793,
    events: [
      { signature: "ElectionSet(uint256 indexed tokenId, address indexed elector, uint32 indexed menuVersion, uint8[] pickIndexes, uint16[] pickBps, bytes32 attestationHash)",
        verb: "elect", actorParam: "elector", contextParams: ["tokenId", "menuVersion"] },
    ],
  },
  {
    community: "stonk_brokers", label: "StonkNFTAMMVault — broker AMM trades",
    address: "0xe302733accf4800146e55fc45b46b4e4ffc032d2", chain: 4663, startBlock: 12493793,
    events: [
      { signature: "NFTBought(address indexed buyer, uint256 indexed tokenId, uint256 tokensIn, uint256 ethFeePaid, uint256 boosterShare, uint256 protocolShare, bool isSpecific)",
        verb: "buy_broker", actorParam: "buyer", amountParam: "tokensIn", contextParams: ["tokenId"] },
      { signature: "NFTSold(address indexed seller, uint256 indexed tokenId, uint256 tokensOut, uint256 ethFeePaid, uint256 boosterShare, uint256 protocolShare)",
        verb: "sell_broker", actorParam: "seller", amountParam: "tokensOut", contextParams: ["tokenId"] },
    ],
  },
  {
    community: "stonk_brokers", label: "StonkLoanVault — broker-collateral loans",
    address: "0xa7b9ac696b252b79568a5a01b2fd02177ef23664", chain: 4663, startBlock: 12493793,
    events: [
      { signature: "LoanCreated(address indexed borrower, uint256 indexed loanId, uint256 indexed tokenId, uint256 principal, uint256 duration, uint256 ethFeePaid, uint256 boosterShare, uint256 protocolShare)",
        verb: "borrow", actorParam: "borrower", amountParam: "principal", contextParams: ["tokenId", "loanId"] },
      { signature: "LoanRepaid(address indexed borrower, uint256 indexed loanId, uint256 principalRepaid, uint256 lateFeeEth)",
        verb: "repay", actorParam: "borrower", amountParam: "principalRepaid", contextParams: ["loanId"] },
    ],
  },
  {
    community: "stonk_brokers", label: "StonkCertificateCounter — exact-price stock buys",
    address: "0x2599882aaf5c14834562ee59ca7a3d1ffcc229d7", chain: 4663, startBlock: 12493793,
    events: [
      { signature: "CertificateBought(uint256 indexed tokenId, address indexed buyer, address indexed recipient, address stockToken, uint256 stockAmount, uint256 spendWei, uint256 feeWei, address wallet)",
        verb: "buy_certificate", actorParam: "buyer", amountParam: "spendWei", contextParams: ["stockToken", "stockAmount"] },
    ],
  },
  {
    community: "stonk_brokers", label: "StonkCertificate — certificate redemptions",
    address: "0xafbc48317dd946e3b9ce570b75e48a285862e6be", chain: 4663, startBlock: 12493793,
    events: [
      { signature: "CertificateRedeemed(uint256 indexed tokenId, address indexed to, address stockToken, uint256 amount)",
        verb: "redeem_certificate", actorParam: "to", amountParam: "amount", contextParams: ["stockToken"] },
    ],
  },
  // RingTheBellGacha ×9 (one per stock machine, all launched by
  // RingTheBellFactory 0x278d…d226). Bytecode differs per machine (constructor
  // immutables: stock token + USD feed), but all nine are Blockscout-verified
  // RingTheBellGacha with the IDENTICAL PullSettled signature (checked per
  // machine 2026-08-10). wonUsd8 (the outcome) is the amount; stockAmount and
  // multBps ride context.
  ...[
    ["0x8f1836209c42d4f6b6caa782c055ee13f8ac95b0", "GME"],
    ["0xf9bc0777c087af0fe7214de8a5360be6a71d0d44", "AAPL"],
    ["0x2829b754784352dd2beffa5eb26d5b499315b715", "AMZN"],
    ["0xc5e3e9c2a835ec9319fd8c1d516fd4323c5758a0", "NVDA"],
    ["0xff20b4b8e08beaa4064e3ca4cc5a2e40acac072f", "GOOGL"],
    ["0xfc253e0062eef614e20e0726e5f6ff7559c35402", "MSFT"],
    ["0x9d2c3355502be065975ad47ef5a902f02c772504", "SLV"],
    ["0xf58979d35c3f0ff6a6f7edd909fe8a95a2894609", "SPCX"],
    ["0x5b1282b6ad40b3dc294404a2b33ff7657b66c33c", "USO"],
  ].map(([address, stock]): ProtocolEntry => ({
    community: "stonk_brokers", label: `RingTheBellGacha — ${stock} machine`,
    address, chain: 4663, startBlock: 12493793,
    events: [
      { signature: "PullSettled(uint256 indexed roundId, address indexed player, uint32 multBps, uint256 wonUsd8, uint256 stockAmount, uint256 certificateId, address deliveredTo)",
        verb: "gacha_pull", actorParam: "player", amountParam: "wonUsd8", contextParams: ["multBps", "stockAmount"] },
    ],
  })),
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
