import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReadSurfaceBlock } from "../domain/beacon-v2.domain.js";
import type { ProbeResult } from "../domain/probe-result.domain.js";
import { unknown, verified } from "../domain/probe-result.domain.js";
import {
  defaultGraphqlEndpoint,
  graphqlAliasFromEndpoint,
  introspectQueryRoot,
} from "../live/graphql-introspect.live.js";
import type { SelfMode } from "../domain/self-check.domain.js";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/gateway-introspection.json",
);

function loadFixture(): string[] {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
    fields: string[];
  };
  return raw.fields;
}

function toReadSurfaceBlock(
  endpoint: string,
  fields: string[],
  probeSource: ReadSurfaceBlock["probe_source"],
  status: ReadSurfaceBlock["status"] = "verified",
  reason?: string,
): ReadSurfaceBlock {
  return {
    status,
    probe_source: probeSource,
    ...(reason ? { reason } : {}),
    graphql: {
      alias: graphqlAliasFromEndpoint(endpoint),
      endpoint,
      schema_hint: fields,
    },
    auth: { kind: "none" },
    mcp: {
      shape: "proxy",
      tools: ["graphql"],
    },
  };
}

export async function probeReadSurface(mode: SelfMode): Promise<ProbeResult<ReadSurfaceBlock>> {
  const endpoint = defaultGraphqlEndpoint();

  if (mode === "offline") {
    return verified(toReadSurfaceBlock(endpoint, loadFixture(), "fixture"));
  }

  try {
    const { fields } = await introspectQueryRoot(endpoint);
    if (fields.length === 0) {
      return unknown("introspection returned empty query root");
    }
    return verified(toReadSurfaceBlock(endpoint, fields, "live"));
  } catch (e) {
    if (mode === "hybrid") {
      const reason = e instanceof Error ? e.message : String(e);
      return {
        status: "unknown",
        value: toReadSurfaceBlock(endpoint, loadFixture(), "fixture", "unknown", reason),
        reason: `live introspection failed: ${reason}`,
      };
    }
    return unknown(e instanceof Error ? e.message : String(e));
  }
}
