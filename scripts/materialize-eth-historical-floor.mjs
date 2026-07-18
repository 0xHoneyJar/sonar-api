#!/usr/bin/env node
/**
 * Governance: materialize Ethereum chain start_block from the floor registry.
 *
 * Single source of truth = scripts/profiling/floor-registry.w1.json
 *   required_floor (source-backed creation / first event)
 * → Eth chain start_block = min(required_floor) over non-blocked EthTrackedErc721 members
 * → never a second hand-edited address list
 *
 * Usage:
 *   node scripts/materialize-eth-historical-floor.mjs           # write configs + registry
 *   node scripts/materialize-eth-historical-floor.mjs --check   # exit 1 if drift
 *
 * Does NOT wipe production Belt. Operator must run KF-013 re-init after merge/deploy
 * for the new floor to take effect on indexed state.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const registryPath = resolve(root, "scripts/profiling/floor-registry.w1.json");
const configPaths = [
  resolve(root, "config.yaml"),
  resolve(root, "config.mibera.yaml"),
  resolve(root, "config.bench.eth.yaml"),
];

function extractEthTrackedAddresses(yaml) {
  const lines = yaml.split("\n");
  const addrs = [];
  let inEth = false;
  let inContract = false;
  let chainStart = null;
  let chainStartLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s+- id: 1\s*$/.test(line)) {
      inEth = true;
      inContract = false;
      chainStart = null;
      chainStartLine = -1;
      continue;
    }
    if (inEth && /^\s+- id: \d+\s*$/.test(line)) {
      inEth = false;
      inContract = false;
    }
    if (inEth && chainStart == null) {
      const m = line.match(/^\s+start_block:\s*(\d+)/);
      if (m) {
        chainStart = Number(m[1]);
        chainStartLine = i;
      }
    }
    if (inEth && /name:\s*EthTrackedErc721\s*$/.test(line)) {
      inContract = true;
      continue;
    }
    if (inContract && /^\s+- name:\s+\S+/.test(line)) {
      inContract = false;
    }
    if (inContract) {
      const m = line.match(/^\s+- (0x[a-fA-F0-9]{40})\b/);
      if (m) addrs.push(m[1].toLowerCase());
    }
  }
  return { chainStart, chainStartLine, addrs, lines };
}

function patchChainStart(yaml, newStart, comment) {
  const { chainStart, chainStartLine, lines } = extractEthTrackedAddresses(yaml);
  if (chainStartLine < 0) {
    throw new Error("Ethereum start_block line not found");
  }
  const indent = lines[chainStartLine].match(/^(\s*)/)[1];
  lines[chainStartLine] = `${indent}start_block: ${newStart} # ${comment}`;
  // Fix stale "inherits chain floor N" comments in the Eth block.
  for (let i = 0; i < lines.length; i++) {
    lines[i] = lines[i].replace(
      /inherits chain floor \d+/g,
      `inherits chain floor ${newStart}`,
    );
  }
  return { yaml: lines.join("\n"), previous: chainStart };
}

if (!existsSync(registryPath)) {
  console.error(`materialize-eth-historical-floor: missing registry ${registryPath}`);
  process.exit(1);
}

const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const mainYaml = readFileSync(configPaths[0], "utf8");
const { addrs: ethTracked } = extractEthTrackedAddresses(mainYaml);
const ethSet = new Set(ethTracked);

const governing = registry.filter(
  (r) =>
    Number(r.chain_id) === 1 &&
    !r.blocked &&
    ethSet.has(String(r.contract).toLowerCase()) &&
    (r.required_floor ?? r.verified_contract_creation_block) != null,
);

if (governing.length === 0) {
  console.error(
    "materialize-eth-historical-floor: no governing floors (registry ∩ EthTrackedErc721)",
  );
  process.exit(1);
}

const floors = governing.map((r) => ({
  contract: String(r.contract).toLowerCase(),
  required: Number(r.required_floor ?? r.verified_contract_creation_block),
}));
const requiredStart = Math.min(...floors.map((f) => f.required));
const binding = floors.find((f) => f.required === requiredStart);
const comment =
  `Governance floor from floor-registry.w1.json — min required_floor ` +
  `(${binding.contract} @ ${requiredStart}); full_from_required_floor`;

const digests = {};
let drift = false;

for (const path of configPaths) {
  if (!existsSync(path)) continue;
  const before = readFileSync(path, "utf8");
  const { yaml: after, previous } = patchChainStart(before, requiredStart, comment);
  digests[path] = {
    previous,
    next: requiredStart,
    sha256_before: createHash("sha256").update(before).digest("hex"),
    sha256_after: createHash("sha256").update(after).digest("hex"),
  };
  if (previous !== requiredStart) drift = true;
  if (!checkOnly && previous !== requiredStart) {
    writeFileSync(path, after.endsWith("\n") ? after : after + "\n");
    console.log(`wrote ${path}: start_block ${previous} → ${requiredStart}`);
  } else if (checkOnly && previous !== requiredStart) {
    console.error(`DRIFT ${path}: start_block ${previous} != registry floor ${requiredStart}`);
  } else {
    console.log(`ok ${path}: start_block ${requiredStart}`);
  }
}

// Refresh registry configured_start / unsafe flags to match materialized floor.
const nextRegistry = registry.map((r) => {
  if (Number(r.chain_id) !== 1) return r;
  const required = r.required_floor ?? r.verified_contract_creation_block;
  const configured = requiredStart;
  const unsafe =
    !r.blocked &&
    required != null &&
    configured > Number(required) &&
    ethSet.has(String(r.contract).toLowerCase());
  return {
    ...r,
    configured_start_block: configured,
    coverage_gap_blocks:
      required == null ? r.coverage_gap_blocks : Math.max(0, configured - Number(required)),
    unsafe_under_current_floor: unsafe,
    coverage_mode: r.coverage_mode ?? "full_from_required_floor",
    governing_floor_contract: binding.contract,
    governing_floor_block: requiredStart,
  };
});

const evidence = {
  mission: "floor_correctness",
  action: checkOnly ? "check" : "materialize",
  capability: "ownership_index.v1",
  coverage_mode: "full_from_required_floor",
  governing_contract: binding.contract,
  required_start_block: requiredStart,
  eth_tracked_count: ethTracked.length,
  governing_count: governing.length,
  config_digests: Object.fromEntries(
    Object.entries(digests).map(([p, d]) => [p.replace(root + "/", ""), d]),
  ),
  operator_authorization: "session_operator_2026-07-18_lower_eth_floor",
  production_note:
    "Config-only until KF-013 wipe+resume reindex; ENVIO_RESTART must be cleared after seed.",
};

const evidencePath = resolve(root, ".run/evidence/mission-02-floor-materialize.json");
if (!checkOnly) {
  writeFileSync(registryPath, JSON.stringify(nextRegistry, null, 2) + "\n");
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`updated registry ${registryPath}`);
  console.log(`wrote evidence ${evidencePath}`);
}

if (checkOnly && drift) {
  process.exit(1);
}

console.log(
  `materialize-eth-historical-floor: ${checkOnly ? "check ok" : "applied"} — floor ${requiredStart} (${binding.contract})`,
);
process.exit(0);
