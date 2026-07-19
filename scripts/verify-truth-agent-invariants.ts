import { existsSync, readFileSync } from "node:fs";

const failures: string[] = [];
const readRequired = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    failures.push(`required invariant source is missing or unreadable: ${path}`);
    return "";
  }
};
const requireMatch = (
  value: string,
  pattern: RegExp,
  failure: string,
): void => {
  if (!pattern.test(value)) failures.push(failure);
};

const config = readRequired("config.yaml");
requireMatch(
  config,
  /- id:\s*1\s*\n\s*start_block:\s*12287507(?:\s|#)/m,
  "Ethereum chain 1 start_block is not 12287507",
);
if (process.env.ENVIO_RESTART !== undefined) {
  failures.push("ENVIO_RESTART must remain unset");
}
const sprint = readRequired("grimoires/loa/sprint.md");
requireMatch(
  sprint,
  /Upstream Loa PR #1228 is pinned to\s+`bfb3d81cbe4121a9f652793b861a5af95bbfc5e3`/,
  "frozen Loa PR 1228 commit pin is missing or drifted",
);

const requiredFiles = [
  "src/truth-contract/consumption.ts",
  "src/truth-contract/schemas/consumption.ts",
  "src/truth-contract/schemas/inspection.ts",
  "src/truth-contract/status-reader.ts",
  "src/truth-contract/staged-proof.ts",
  "src/truth-contract/cli/sonar-truth.ts",
  "src/truth-contract/cli/mcp.ts",
];
for (const file of requiredFiles) {
  if (!existsSync(file)) failures.push(`required agent surface is missing: ${file}`);
}

const inspection = existsSync("src/truth-contract/schemas/inspection.ts")
  ? readFileSync("src/truth-contract/schemas/inspection.ts", "utf8")
  : "";
requireMatch(
  inspection,
  /Schema\.Literal\("STAGED_CURRENT"\)/,
  "inspection schema does not require STAGED_CURRENT",
);
requireMatch(
  inspection,
  /Schema\.Literal\(false\)/,
  "inspection schema can claim production authority",
);
requireMatch(
  inspection,
  /"reconciled_staged"/,
  "frozen reconciled_staged target is missing",
);

const agentBoundaryFiles = [
  "src/truth-contract/status-reader.ts",
  "src/truth-contract/cli/contract.ts",
  "src/truth-contract/cli/runtime.ts",
  "src/truth-contract/cli/sonar-truth.ts",
  "src/truth-contract/cli/mcp.ts",
].filter(existsSync);
const forbiddenImports =
  /(?:from\s+|require\(\s*|import\(\s*)["'](?:pg|viem|ethers|undici|ws|node:http|node:https|node:http2|node:net|node:tls|node:dgram)(?:\/[^"']*)?["']/;
const forbiddenNetworkGlobals = /\b(?:fetch|WebSocket)\s*\(/;
for (const file of agentBoundaryFiles) {
  const source = readFileSync(file, "utf8");
  if (forbiddenImports.test(source) || forbiddenNetworkGlobals.test(source)) {
    failures.push(`read-only agent boundary imports transport or database authority: ${file}`);
  }
}

const statusReader = existsSync("src/truth-contract/status-reader.ts")
  ? readFileSync("src/truth-contract/status-reader.ts", "utf8")
  : "";
requireMatch(
  statusReader,
  /depth > 32/,
  "agent dependency traversal does not enforce the frozen depth-32 limit",
);
requireMatch(
  statusReader,
  /STAGED_INSPECTION_SCORE_AUTHORITY_REFUSED/,
  "authority-shaped targets do not fail closed",
);

const stagedProof = existsSync("src/truth-contract/staged-proof.ts")
  ? readFileSync("src/truth-contract/staged-proof.ts", "utf8")
  : "";
const producerGeneration = existsSync("src/truth-contract/producer-generation.ts")
  ? readFileSync("src/truth-contract/producer-generation.ts", "utf8")
  : "";
requireMatch(
  `${stagedProof}\n${producerGeneration}`,
  /0x6666397dfe9a8c469bf65dc744cb1c733416c420/,
  "staged proof does not bind the exact Mibera address",
);
requireMatch(
  `${stagedProof}\n${producerGeneration}`,
  /Transfer\(address,address,uint256\)/,
  "staged proof does not bind the exact Transfer event",
);
if (/FIXTURE_VALID/.test(stagedProof)) {
  failures.push("staged proof may not relabel fixture-valid evidence");
}

const result = {
  schema_version: 1,
  gate: "sonar.truth-agent.invariants",
  status: failures.length === 0 ? "PASS" : "FAIL",
  production_authority: false,
  ethereum_start_block: "12287507",
  envio_restart: "unset",
  failures,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (failures.length > 0) process.exitCode = 1;
