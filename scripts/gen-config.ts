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
 * Only two bindings exist, matching the only two handlers:
 *   erc721  → TrackedErc721.Transfer      (src/handlers/tracked-erc721.ts)
 *   seaport → Seaport.OrderFulfilled      (src/handlers/seaport.ts)
 *
 * Envio's per-contract `start_block` applies to the whole address list, so a
 * binding starts at the earliest startBlock among its addresses on that chain.
 * Starting earlier than a contract's deploy costs sync time, never correctness.
 */
import { writeFileSync } from "node:fs";
import { TRACKED_CONTRACTS, type ContractEntry } from "../src/registry/contracts";

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
  # Every tracked ERC-721. One handler, one binding, no per-community case.
  - name: TrackedErc721
    handler: src/EventHandlers.ts
    events:
      - event: Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
        field_selection:
          transaction_fields:
            - hash
            # Exact event identity on Action. blockNumber needs no selection
            # (block fields are always on the event); transactionIndex does.
            - transactionIndex
  # Seaport — OpenSea secondary sales. The OrderFulfilled ABI is stable across
  # versions, so one binding covers v1.1 through v1.6 on every chain.
  - name: Seaport
    handler: src/EventHandlers.ts
    events:
      - event: OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8,address,uint256,uint256)[] offer, (uint8,address,uint256,uint256,address)[] consideration)
        field_selection:
          transaction_fields:
            - hash
chains:
`;

/** Envio contract name for a registry entry. */
function binding(c: ContractEntry): string {
  return c.standard === "seaport" ? "Seaport" : "TrackedErc721";
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

const byChain = new Map<number, ContractEntry[]>();
for (const c of TRACKED_CONTRACTS) {
  byChain.set(c.chain, [...(byChain.get(c.chain) ?? []), c]);
}

const unordered = [...byChain.keys()].filter((id) => !ORDER.includes(id));
if (unordered.length > 0) {
  throw new Error(
    `chain ${unordered.join(", ")} is in the registry but not in ORDER — add it to scripts/gen-config.ts`,
  );
}

let out = HEADER;
for (const chainId of ORDER) {
  const entries = byChain.get(chainId);
  if (!entries) continue;

  out += `\n  # ${CHAIN_NAMES[chainId]}\n`;
  out += `  - id: ${chainId}\n`;
  out += `    start_block: ${Math.min(...entries.map((c) => c.startBlock))}\n`;
  out += CHAIN_EXTRAS[chainId] ?? "";
  out += `    contracts:\n`;

  for (const name of ["TrackedErc721", "Seaport"]) {
    const bound = entries.filter((c) => binding(c) === name);
    if (bound.length === 0) continue;
    out += `      - name: ${name}\n`;
    out += `        address:\n`;
    for (const c of bound) out += `          - "${c.address}" # ${c.community}\n`;
    out += `        start_block: ${Math.min(...bound.map((c) => c.startBlock))}\n`;
  }
}

/** The generated config.yaml text. Exported so the test can compare without shelling out. */
export const CONFIG_YAML = out;

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(new URL("../config.yaml", import.meta.url), CONFIG_YAML);
  console.log(`config.yaml: ${TRACKED_CONTRACTS.length} contracts across ${byChain.size} chains`);
}
