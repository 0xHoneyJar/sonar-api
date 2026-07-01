import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeployModelBlock } from "../domain/beacon-v2.domain.js";
import type { ProbeResult } from "../domain/probe-result.domain.js";
import { unknown, verified } from "../domain/probe-result.domain.js";
import type { SelfMode } from "../domain/self-check.domain.js";
import {
  fetchRailwayDeployment,
  fetchRailwayViaCli,
  parseRailwayFixture,
} from "../live/railway.live.js";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/railway-services.json",
);

function loadFixture(): DeployModelBlock {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  return parseRailwayFixture(raw);
}

function withProbeSource(
  block: DeployModelBlock,
  probeSource: DeployModelBlock["probe_source"],
  status: DeployModelBlock["status"] = "verified",
  reason?: string,
): DeployModelBlock {
  return { ...block, status, probe_source: probeSource, ...(reason ? { reason } : {}) };
}

export async function probeDeployment(mode: SelfMode): Promise<ProbeResult<DeployModelBlock>> {
  if (mode === "offline") {
    return verified(withProbeSource(loadFixture(), "fixture"));
  }

  const hasToken = Boolean(process.env.RAILWAY_TOKEN && process.env.RAILWAY_PROJECT_ID);

  if (mode === "live" && !hasToken) {
    return unknown("deployment probe requires RAILWAY_TOKEN and RAILWAY_PROJECT_ID in live mode");
  }

  if (hasToken) {
    try {
      return verified(withProbeSource(await fetchRailwayDeployment(), "live"));
    } catch (e) {
      if (mode === "hybrid") {
        try {
          return verified(withProbeSource(await fetchRailwayViaCli(), "live"));
        } catch {
          const reason = e instanceof Error ? e.message : String(e);
          return {
            status: "unknown",
            value: withProbeSource(loadFixture(), "fixture", "unknown", reason),
            reason: `Railway GQL failed: ${reason}`,
          };
        }
      }
      return unknown(e instanceof Error ? e.message : String(e));
    }
  }

  if (mode === "hybrid") {
    try {
      return verified(withProbeSource(await fetchRailwayViaCli(), "live"));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return {
        status: "unknown",
        value: withProbeSource(loadFixture(), "fixture", "unknown", reason),
        reason: `deployment probe unavailable: ${reason}`,
      };
    }
  }

  return unknown("deployment probe unavailable");
}
