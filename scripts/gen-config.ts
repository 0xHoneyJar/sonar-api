/*
 * gen-config.ts — config.yaml is GENERATED from src/registry/contracts.ts.
 *
 * The registry is the single declaration site (bd-dwq5.3). Before this, a
 * contract had to be written twice — once in the top-level `contracts:` block
 * and once under `chains[].contracts` — and the two had drifted (41 vs 50).
 *
 * Adding a community is one entry in the registry, then:
 *
 *     pnpm gen:config
 *
 * test/contract-registry.test.ts fails if the checked-in config.yaml is not
 * byte-identical to this script's output, so the two cannot drift again.
 *
 * One binding per lane, each matching exactly one handler:
 *   erc721  → TrackedErc721.Transfer                      (tracked-erc721.ts)
 *   erc1155 → TrackedErc1155.TransferSingle/TransferBatch (tracked-erc1155.ts)
 *   erc20   → TrackedErc20.Transfer                       (tracked-erc20.ts)
 *   seaport → Seaport.OrderFulfilled                      (seaport.ts)
 *
 * Every binding is declared in the top-level `contracts:` block ALWAYS, even
 * when the registry has no entry of that standard yet. That is deliberate: the
 * handlers self-register unconditionally, and scripts/check-onevent-bijection.mjs
 * fails an `onEvent` call site with no matching config pair. Declaring the pair
 * with no addresses keeps the bijection intact and costs nothing — envio indexes
 * nothing for a contract bound on no chain (verified: codegen exits 0).
 *
 * Per-chain address lists are emitted only for standards that HAVE entries, so
 * adding the first ERC-1155 or ERC-20 contract needs no change here.
 *
 * Envio's per-contract `start_block` applies to the whole address list, so a
 * binding starts at the earliest startBlock among its addresses on that chain.
 * Starting earlier than a contract's deploy costs sync time, never correctness.
 */
import { writeFileSync } from "node:fs";
import {
  TRACKED_CONTRACTS,
  type TokenStandard,
} from "../src/registry/contracts";
import { MARKETPLACES, type Marketplace } from "../src/registry/marketplaces";

const HEADER = `# yaml-language-server: $schema=./node_modules/envio/evm.schema.json
#
# GENERATED FILE — do not edit by hand.
# Source of truth: src/registry/contracts.ts. Regenerate with \`pnpm gen:config\`.
# test/contract-registry.test.ts fails if this file drifts from the registry.
#
# Runtime env vars (read by handlers, not by envio):
#   NATS_URL                  — JetStream connection URI (TLS-only)
#   NATS_TLS_CA               — path to CA bundle for the cluster's NATS instance
#   SONAR_SIGNING_SEED_HEX    — 32-byte (64 hex chars) Ed25519 seed for the
#                               events-pillar signer. Absent → publish layer
#                               stays disabled (fail-soft).
name: thj-indexer
contracts:
`;

/**
 * The lanes. One entry per standard; adding a standard is an entry here, a
 * handler file, and a `TokenStandard` union member — nothing else.
 *
 * `identityFields` selects transactionIndex for lanes whose handler writes
 * `Action`, which carries exact event identity. Seaport writes MintActivity
 * (blockNumber already a column) and never Action, so it does not need it.
 */
interface Lane {
  readonly name: string;
  readonly comment: string;
  readonly events: readonly string[];
  /** transaction fields this lane needs selected. `hash` is always required. */
  readonly txFields: readonly string[];
  /** Addresses on `chainId`, as `address → label` (label becomes the YAML comment). */
  readonly addresses: (chainId: number) => Array<{ address: string; label: string; startBlock: number }>;
}

const tokenLane = (standard: TokenStandard) => (chainId: number) =>
  TRACKED_CONTRACTS.filter((c) => c.chain === chainId && c.standard === standard).map((c) => ({
    address: c.address,
    label: c.community,
    startBlock: c.startBlock,
  }));

const marketLane = (marketplace: Marketplace) => (chainId: number) =>
  MARKETPLACES.filter((m) => m.chain === chainId && m.marketplace === marketplace).map((m) => ({
    address: m.address,
    label: m.label,
    startBlock: m.startBlock,
  }));

const LANES: readonly Lane[] = [
  {
    name: "TrackedErc721",
    addresses: tokenLane("erc721"),
    comment: "Every tracked ERC-721. One handler, one binding, no per-community case.",
    events: [
      "Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
    ],
    txFields: ["hash", "transactionIndex"],
  },
  {
    name: "TrackedErc1155",
    addresses: tokenLane("erc1155"),
    comment:
      "Every tracked ERC-1155. Balances are per (contract, chain, tokenId, wallet);\n  # TransferBatch is folded into the same path as TransferSingle.",
    events: [
      "TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
      "TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
    ],
    txFields: ["hash", "transactionIndex"],
  },
  {
    name: "TrackedErc20",
    addresses: tokenLane("erc20"),
    comment:
      "Every tracked ERC-20. Same topic0 as ERC-721's Transfer — the third arg is\n  # un-indexed here, so a contract registered under the wrong standard decodes garbage.",
    events: ["Transfer(address indexed from, address indexed to, uint256 value)"],
    txFields: ["hash", "transactionIndex"],
  },
  {
    name: "Seaport",
    addresses: marketLane("seaport"),
    comment:
      "Seaport (OpenSea) — secondary sales. The OrderFulfilled ABI is stable across\n  # versions, so one binding covers v1.1 through v1.6 on every chain.",
    events: [
      "OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8,address,uint256,uint256)[] offer, (uint8,address,uint256,uint256,address)[] consideration)",
    ],
    txFields: ["hash"],
  },
  {
    name: "Blur",
    addresses: marketLane("blur"),
    comment:
      "Blur v1 — Ethereum only, near-dormant now but carries Blur's 2022-23 volume.\n  # One matched pair is one NFT; the order carries its own price and currency.",
    events: [
      "OrdersMatched(address indexed maker, address indexed taker, (address,uint8,address,address,uint256,uint256,address,uint256,uint256,uint256,(uint16,address)[],uint256,bytes) sell, bytes32 sellHash, (address,uint8,address,address,uint256,uint256,address,uint256,uint256,uint256,(uint16,address)[],uint256,bytes) buy, bytes32 buyHash)",
    ],
    txFields: ["hash"],
  },
  {
    name: "BlurV2",
    addresses: marketLane("blur_v2"),
    comment:
      "Blur v2 — where all current Blur volume is. Fields are BIT-PACKED into two\n  # uint256s and only ONE party is on the log, so `from` is selected: the\n  # counterparty is the transaction sender (verified against 16 real fills).",
    events: [
      "Execution721Packed(bytes32 orderHash, uint256 tokenIdListingIndexTrader, uint256 collectionPriceSide)",
    ],
    txFields: ["hash", "from"],
  },
];

/** The top-level `contracts:` block — every lane, always. */
function contractsBlock(): string {
  let s = "";
  for (const lane of LANES) {
    s += `  # ${lane.comment}\n`;
    s += `  - name: ${lane.name}\n`;
    s += `    handler: src/EventHandlers.ts\n`;
    s += `    events:\n`;
    for (const ev of lane.events) {
      s += `      - event: ${ev}\n`;
      s += `        field_selection:\n`;
      s += `          transaction_fields:\n`;
      for (const f of lane.txFields) s += `            - ${f}\n`;
    }
  }
  return s;
}

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum Mainnet",
  10: "Optimism",
  8453: "Base",
  42161: "Arbitrum",
  80094: "Berachain Mainnet",
  7777777: "Zora",
};

/** Chain-level extras that are not derivable from the registry. */
const CHAIN_EXTRAS: Record<number, string> = {
  // Auto-discovery misses Berachain; managed Cloud bundles HyperSync.
  80094: "    hypersync_config:\n      url: https://berachain.hypersync.xyz\n",
};

const ORDER = [1, 42161, 7777777, 10, 8453, 80094];

// A chain appears in config.yaml if EITHER registry places something on it.
const CHAIN_IDS = [
  ...new Set([...TRACKED_CONTRACTS.map((c) => c.chain), ...MARKETPLACES.map((m) => m.chain)]),
];

const unordered = CHAIN_IDS.filter((id) => !ORDER.includes(id));
if (unordered.length > 0) {
  throw new Error(
    `chain ${unordered.join(", ")} is in the registry but not in ORDER — add it to scripts/gen-config.ts`,
  );
}

let out = HEADER + contractsBlock() + "chains:\n";
for (const chainId of ORDER) {
  if (!CHAIN_IDS.includes(chainId)) continue;
  const bound = LANES.map((lane) => ({ lane, addrs: lane.addresses(chainId) })).filter(
    (b) => b.addrs.length > 0,
  );
  if (bound.length === 0) continue;

  const earliest = Math.min(...bound.flatMap((b) => b.addrs.map((a) => a.startBlock)));
  out += `\n  # ${CHAIN_NAMES[chainId]}\n`;
  out += `  - id: ${chainId}\n`;
  out += `    start_block: ${earliest}\n`;
  out += CHAIN_EXTRAS[chainId] ?? "";
  out += `    contracts:\n`;

  for (const { lane, addrs } of bound) {
    out += `      - name: ${lane.name}\n`;
    out += `        address:\n`;
    for (const a of addrs) out += `          - "${a.address}" # ${a.label}\n`;
    out += `        start_block: ${Math.min(...addrs.map((a) => a.startBlock))}\n`;
  }
}

/** The generated config.yaml text. Exported so the test can compare without shelling out. */
export const CONFIG_YAML = out;

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(new URL("../config.yaml", import.meta.url), CONFIG_YAML);
  console.log(
    `config.yaml: ${TRACKED_CONTRACTS.length} contracts + ${MARKETPLACES.length} marketplace deployments across ${CHAIN_IDS.length} chains`,
  );
}
