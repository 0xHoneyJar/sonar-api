import type { CollectionKey } from "./types.js";

const CHAIN_HEADER = /^  - id: (\d+)\s*$/m;

function normalizeAddress(contract: string): string {
  return contract.toLowerCase();
}

/** Safe for YAML `# comment` suffix — strips structure-breaking characters. */
export function sanitizeKitchenLabel(label: string): string {
  const trimmed = label.trim();
  const sanitized = trimmed.replace(/[^A-Za-z0-9 _-]/g, "_").replace(/_+/g, "_");
  return sanitized.slice(0, 80) || "kitchen_collection";
}

/** Returns the slice of config.yaml belonging to one chain block (from `- id:` through next chain). */
export function extractChainBlock(configYaml: string, chainId: number): string | undefined {
  const lines = configYaml.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^  - id: (\d+)\s*$/);
    if (match && Number(match[1]) === chainId) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  - id: \d+\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export function contractListedInChainBlock(chainBlock: string, contract: `0x${string}`): boolean {
  const needle = normalizeAddress(contract);
  return chainBlock
    .split("\n")
    .some((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("- 0x")) return false;
      const addr = trimmed.slice(2).split(/\s/)[0]?.trim();
      return addr !== undefined && normalizeAddress(addr) === needle;
    });
}

export function appendTrackedErc721ToChainBlock(
  chainBlock: string,
  contract: `0x${string}`,
  label: string,
): string {
  const addressLine = `          - ${normalizeAddress(contract)} # ${label}`;
  const trackedHeader = "      - name: TrackedErc721";

  if (chainBlock.includes(trackedHeader)) {
    const lines = chainBlock.split("\n");
    let insertAt = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(trackedHeader)) {
        for (let j = i + 1; j < lines.length; j++) {
          if (/^      - name: /.test(lines[j]) && !lines[j].includes("TrackedErc721")) {
            insertAt = j;
            break;
          }
          if (/^  - id: /.test(lines[j])) {
            insertAt = j;
            break;
          }
        }
        if (insertAt === lines.length) {
          insertAt = i + 1;
          while (insertAt < lines.length && /^\s+- 0x/i.test(lines[insertAt])) {
            insertAt++;
          }
        }
        break;
      }
    }
    lines.splice(insertAt, 0, addressLine);
    return lines.join("\n");
  }

  const block = [
    "      # Kitchen ingest — community onboarding ERC-721 holder tracking",
    "      - name: TrackedErc721",
    "        address:",
    addressLine,
  ].join("\n");
  return `${chainBlock}\n${block}`;
}

export function patchConfigForKitchenIngest(args: {
  configYaml: string;
  key: CollectionKey;
  label?: string;
}): { changed: boolean; configYaml: string } {
  const chainBlock = extractChainBlock(args.configYaml, args.key.chainId);
  if (!chainBlock) {
    throw new Error(`chain ${args.key.chainId} not found in belt config`);
  }
  if (contractListedInChainBlock(chainBlock, args.key.contract)) {
    return { changed: false, configYaml: args.configYaml };
  }

  const label = sanitizeKitchenLabel(
    args.label?.trim() ||
      `kitchen_${args.key.chainId}_${args.key.contract.slice(2, 10)}`,
  );
  const patchedBlock = appendTrackedErc721ToChainBlock(chainBlock, args.key.contract, label);
  const lines = args.configYaml.split("\n");
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(CHAIN_HEADER);
    if (match && Number(match[1]) === args.key.chainId) {
      start = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^  - id: \d+\s*$/.test(lines[j])) {
          end = j;
          break;
        }
      }
      break;
    }
  }
  if (start < 0) {
    throw new Error(`chain ${args.key.chainId} not found in belt config`);
  }

  const newYaml = [...lines.slice(0, start), ...patchedBlock.split("\n"), ...lines.slice(end)].join(
    "\n",
  );
  return { changed: true, configYaml: newYaml };
}
