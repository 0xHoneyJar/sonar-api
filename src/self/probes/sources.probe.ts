import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  CHAIN_NAMES,
  type SourcesBlock,
} from "../domain/beacon-v2.domain.js";
import type { ProbeResult } from "../domain/probe-result.domain.js";
import { unknown, verified } from "../domain/probe-result.domain.js";
import { readEnvioConfig, resolveConfigPath } from "../live/config-reader.live.js";

const EXPECTED_CHAIN_IDS = [1, 10, 42161, 7777777, 8453, 80094];

function detectTransport(
  chains: Array<{ hypersync_config?: unknown; rpc_config?: unknown }>,
): SourcesBlock["transport"] {
  const hasHypersync = chains.some((c) => c.hypersync_config);
  const hasRpc = chains.some((c) => c.rpc_config);
  if (hasHypersync && hasRpc) return "mixed";
  if (hasHypersync) return "hypersync";
  if (hasRpc) return "rpc";
  return "hypersync";
}

export function parseSourcesFromConfig(
  repoRoot: string,
  configPath?: string,
): ProbeResult<SourcesBlock> {
  const path = configPath ?? resolveConfigPath(repoRoot);
  if (!existsSync(path)) {
    return unknown(`config not found at ${path}`);
  }

  try {
    const config = readEnvioConfig(path);
    const chainEntries = config.chains ?? [];
    const chains = chainEntries
      .filter((c) => typeof c.id === "number")
      .map((c) => ({
        id: c.id,
        name: CHAIN_NAMES[c.id],
      }))
      .sort((a, b) => a.id - b.id);

    const contract_source_count = Array.isArray(config.contracts)
      ? config.contracts.length
      : 0;

    const svmDir = resolve(repoRoot, "src/svm");
    const svm = existsSync(svmDir)
      ? {
          lane: "src/svm/*",
          transport: "webhook",
          status: "verified" as const,
        }
      : undefined;

    const block: SourcesBlock = {
      status: "verified",
      probe_source: "commit",
      transport: detectTransport(chainEntries),
      chains,
      contract_source_count,
      svm,
    };

    const missing = EXPECTED_CHAIN_IDS.filter(
      (id) => !chains.some((c) => c.id === id),
    );
    if (missing.length > 0) {
      return {
        status: "unknown",
        reason: `missing expected chain ids: ${missing.join(", ")}`,
        value: block,
      };
    }

    return verified(block);
  } catch (e) {
    return unknown(e instanceof Error ? e.message : String(e));
  }
}
