/**
 * verify-belt-config.js — Mibera belt config fidelity gate.
 *
 * SDD §5.3 / PRD FR-1 / AC-2 / AC-11. HyperIndex exposes only the
 * transaction/block fields a config's `field_selection` requests. A belt config
 * that drops a field a handler reads produces silently-wrong data and no crash
 * (e.g. omitting MiberaCollection.Transfer's `value` makes MintActivity.amountPaid
 * write 0n — SDD §5.1). This script makes that failure mode impossible to ship:
 *
 *   For each belt contract it asserts the contract definition (events +
 *   field_selection) in config.mibera.yaml is field-identical to config.yaml
 *   and start_block matches. Critical contract addresses remain identical.
 *   TrackedErc721 and EthTrackedErc721 are the expansion-safe generic community
 *   trackers: each non-empty belt address list must remain a subset of
 *   config.yaml, while the monolith may add communities outside the Score
 *   failback footprint.
 *
 * Exit 0 = identical, exit 1 = drift (mismatches printed to stderr).
 * Run locally from the repo root: `pnpm verify:belt-config`.
 * Exercised by test/verify-belt-config.test.ts.
 *
 * Zero dependencies by design — the repo ships no YAML parser, and a gate that
 * guards config fidelity should not introduce one. Extraction is deliberately
 * narrow: locate two named contracts by YAML indentation and compare their
 * blocks. Comments and trailing whitespace are normalized away; structure and
 * values are compared exactly.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Belt contracts whose fidelity is enforced, each tagged with the chain it is
 * referenced on. Event-definition (events + field_selection) fidelity is checked
 * once per unique contract name (chain-agnostic, vs the monolith top-level def);
 * address + start_block fidelity is checked per (contract, chain). TrackedErc721
 * is referenced on THREE chains (Ethereum Azuki kitchen E2E, Optimism lore, Berachain
 * lore/fractures), so it appears three times — its def is checked once, its
 * address/start_block per chain.
 */
export const BELT_CONTRACTS = [
  // Berachain (80094) — score-api footprint
  { name: "MiberaLiquidBacking", chainId: 80094 },
  { name: "MiberaCollection", chainId: 80094 },
  { name: "PaddleFi", chainId: 80094 },
  { name: "BgtToken", chainId: 80094 },
  { name: "CubBadges1155", chainId: 80094 },
  { name: "CandiesMarket1155", chainId: 80094 },
  { name: "GeneralMints", chainId: 80094 },
  { name: "TrackedErc721", chainId: 80094 },
  { name: "Seaport", chainId: 80094 }, // Mibera secondary sales (OpenSea)
  // Base (8453)
  { name: "FriendtechShares", chainId: 8453 },
  { name: "TrackedErc721", chainId: 8453 },
  { name: "TrackedErc20", chainId: 8453 },
  // Optimism (10)
  { name: "MiberaSets", chainId: 10 },
  { name: "MiberaZora1155", chainId: 10 },
  { name: "MirrorObservability", chainId: 10 },
  { name: "TrackedErc721", chainId: 10 },
  // Ethereum (1)
  { name: "MiladyCollection", chainId: 1 },
  { name: "EthTrackedErc721", chainId: 1 },
  { name: "Seaport", chainId: 1 }, // mainnet Azuki secondary sales (OpenSea, FR-6a)
];

/**
 * Generic collection trackers whose monolith address list may expand without
 * widening the Score failback belt. Keep this allowlist explicit: protocol
 * contracts such as PaddleFi and MiberaLiquidBacking require exact address
 * parity.
 */
export const ADDRESS_SUBSET_CONTRACTS = new Set([
  "TrackedErc721",
  "EthTrackedErc721",
]);

/** @deprecated belt is now multi-chain — use BELT_CONTRACTS[].chainId. Kept for back-compat. */
export const BELT_CHAIN_ID = 80094;

/**
 * Strip a trailing or whole-line YAML comment plus trailing whitespace.
 * A line that is only a comment collapses to ''.
 * @param {string} line
 * @returns {string}
 */
function stripComment(line) {
  const hash = line.indexOf("#");
  if (hash === -1) return line.replace(/\s+$/, "");
  if (line.slice(0, hash).trim() === "") return ""; // whole-line comment
  return line.slice(0, hash).replace(/\s+$/, "");
}

/**
 * Normalize a YAML block: drop comments and blank lines, rtrim each line.
 * @param {string[]} lines
 * @returns {string}
 */
function normalizeBlock(lines) {
  return lines
    .map(stripComment)
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Slice the top-level `contracts:` section (contract *definitions*), distinct
 * from the per-chain `contracts:` lists nested under `chains:`.
 * @param {string[]} lines
 * @returns {{ start: number, end: number } | null}
 */
function topLevelContractsSection(lines) {
  const start = lines.findIndex((l) => /^contracts:\s*$/.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start: start + 1, end };
}

/**
 * Extract a contract *definition* block from the top-level `contracts:` list,
 * normalized for comparison: comments, blank lines, and the `handler:` line are
 * stripped. The `handler:` line is excluded by design — a belt config points it
 * at a belt-scoped registration entrypoint (e.g. src/EventHandlers.mibera.ts)
 * while config.yaml uses the monolith barrel src/EventHandlers.ts. SDD §5.3
 * scopes this gate to field_selection / address / start_block fidelity, not
 * handler-path identity.
 * @param {string} text  full YAML file text
 * @param {string} contractName
 * @returns {string | null}  normalized block (name + events + field_selection), or null
 */
export function extractContractDefinition(text, contractName) {
  const lines = text.split("\n");
  const section = topLevelContractsSection(lines);
  if (!section) return null;
  const nameRe = new RegExp(`^  - name:\\s+${contractName}\\s*$`);
  let blockStart = -1;
  for (let i = section.start; i < section.end; i++) {
    if (nameRe.test(lines[i])) {
      blockStart = i;
      break;
    }
  }
  if (blockStart === -1) return null;
  let blockEnd = section.end;
  for (let i = blockStart + 1; i < section.end; i++) {
    if (/^  - /.test(lines[i])) {
      blockEnd = i;
      break;
    }
  }
  // Exclude the `handler:` line — see the function doc (SDD §5.3 scope).
  const block = lines
    .slice(blockStart, blockEnd)
    .filter((l) => !/^\s+handler:\s/.test(l));
  return normalizeBlock(block);
}

/**
 * Slice the chain entry for a given chain id from the `chains:` list.
 * @param {string[]} lines
 * @param {number} chainId
 * @returns {{ start: number, end: number } | null}
 */
function chainSection(lines, chainId) {
  const chainsAt = lines.findIndex((l) => /^chains:\s*$/.test(l));
  if (chainsAt === -1) return null;
  const idRe = new RegExp(`^  - id:\\s+${chainId}(?:\\s|$)`);
  let start = -1;
  for (let i = chainsAt + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break; // left the chains: block
    if (idRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) || /^  - /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * Extract a contract *reference* (address list + start_block) from a chain's
 * nested `contracts:` list.
 * @param {string} text  full YAML file text
 * @param {number} chainId
 * @param {string} contractName
 * @returns {{ address: string[], startBlock: string | null } | null}
 */
export function extractChainContractRef(text, chainId, contractName) {
  const lines = text.split("\n");
  const chain = chainSection(lines, chainId);
  if (!chain) return null;
  const nameRe = new RegExp(`^      - name:\\s+${contractName}\\s*$`);
  let refStart = -1;
  for (let i = chain.start; i < chain.end; i++) {
    if (nameRe.test(lines[i])) {
      refStart = i;
      break;
    }
  }
  if (refStart === -1) return null;
  let refEnd = chain.end;
  for (let i = refStart + 1; i < chain.end; i++) {
    if (/^      - /.test(lines[i])) {
      refEnd = i;
      break;
    }
  }
  const address = [];
  let startBlock = null;
  let inAddress = false;
  for (const raw of lines.slice(refStart, refEnd)) {
    const line = stripComment(raw);
    if (line === "") continue;
    const trimmed = line.trim();
    if (/^address:/.test(trimmed)) {
      inAddress = true;
      continue;
    }
    if (/^start_block:/.test(trimmed)) {
      inAddress = false;
      startBlock = trimmed.slice("start_block:".length).trim();
      continue;
    }
    if (inAddress && trimmed.startsWith("- ")) {
      address.push(trimmed.slice(2).trim());
      continue;
    }
    inAddress = false; // any other key ends the address list
  }
  return { address, startBlock };
}

/** Report the first differing normalized line between two blocks. */
function firstDiff(expected, actual) {
  const e = expected.split("\n");
  const a = actual.split("\n");
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] !== a[i]) {
      return (
        `\n      config.yaml: ${e[i] ?? "(end of block)"}` +
        `\n      belt config: ${a[i] ?? "(end of block)"}`
      );
    }
  }
  return "";
}

/**
 * Verify the belt config is field-identical to the monolith for all belt
 * contracts. Accepts file paths or pre-loaded text — text wins when both are
 * given (used by the test suite to inject mismatches).
 * @param {{
 *   beltConfigPath?: string,
 *   monolithConfigPath?: string,
 *   beltConfigText?: string,
 *   monolithConfigText?: string,
 * }} [opts]
 * @returns {{ ok: boolean, mismatches: string[] }}
 */
export function verifyBeltConfig(opts = {}) {
  const {
    beltConfigPath = "config.mibera.yaml",
    monolithConfigPath = "config.yaml",
    beltConfigText,
    monolithConfigText,
  } = opts;
  const beltText = beltConfigText ?? readFileSync(beltConfigPath, "utf8");
  const monoText =
    monolithConfigText ?? readFileSync(monolithConfigPath, "utf8");
  const mismatches = [];

  const seenDefs = new Set();
  for (const { name, chainId } of BELT_CONTRACTS) {
    // --- contract definition: events + field_selection (chain-agnostic; once per name) ---
    if (!seenDefs.has(name)) {
      seenDefs.add(name);
      const beltDef = extractContractDefinition(beltText, name);
      const monoDef = extractContractDefinition(monoText, name);
      if (monoDef === null) {
        mismatches.push(
          `${name}: not found in monolith ${monolithConfigPath} — cannot verify`,
        );
      } else if (beltDef === null) {
        mismatches.push(
          `${name}: missing from belt ${beltConfigPath} contracts: definitions`,
        );
      } else if (beltDef !== monoDef) {
        mismatches.push(
          `${name}: contract definition / field_selection differs from config.yaml${firstDiff(monoDef, beltDef)}`,
        );
      }
    }

    // --- chain reference: scoped address policy + exact start_block ---
    const beltRef = extractChainContractRef(beltText, chainId, name);
    const monoRef = extractChainContractRef(monoText, chainId, name);
    if (monoRef === null) {
      mismatches.push(
        `${name}: not referenced on chain ${chainId} in monolith — cannot verify`,
      );
    } else if (beltRef === null) {
      mismatches.push(`${name}: missing from belt chain ${chainId} contracts:`);
    } else {
      if (beltRef.address.length === 0) {
        mismatches.push(
          `${name} (chain ${chainId}): belt address list is empty`,
        );
      } else if (ADDRESS_SUBSET_CONTRACTS.has(name)) {
        const monoAddresses = new Set(
          monoRef.address.map((address) => address.toLowerCase()),
        );
        const missingAddresses = beltRef.address.filter(
          (address) => !monoAddresses.has(address.toLowerCase()),
        );
        if (missingAddresses.length > 0) {
          mismatches.push(
            `${name} (chain ${chainId}): belt address missing from config.yaml — [${missingAddresses.join(", ")}]`,
          );
        }
      } else if (beltRef.address.join(",") !== monoRef.address.join(",")) {
        mismatches.push(
          `${name} (chain ${chainId}): address differs — belt [${beltRef.address.join(", ")}] vs config.yaml [${monoRef.address.join(", ")}]`,
        );
      }
      if (beltRef.startBlock !== monoRef.startBlock) {
        mismatches.push(
          `${name} (chain ${chainId}): start_block differs — belt ${beltRef.startBlock} vs config.yaml ${monoRef.startBlock}`,
        );
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** CLI entrypoint — run only when invoked directly, not when imported. */
function main() {
  const result = verifyBeltConfig();
  if (result.ok) {
    const names = new Set(BELT_CONTRACTS.map((c) => c.name));
    const chains = new Set(BELT_CONTRACTS.map((c) => c.chainId));
    console.log(
      `✓ verify-belt-config: ${names.size} belt contracts across ${chains.size} chains field-identical with governed address fidelity`,
    );
    process.exit(0);
  }
  console.error("✗ verify-belt-config: belt config drifted from config.yaml");
  for (const m of result.mismatches) console.error(`  - ${m}`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
