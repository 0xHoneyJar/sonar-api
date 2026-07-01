import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  DEFAULT_GENERATED_SECTIONS,
  type BeaconV2Document,
  type GeneratedSection,
  type SourcesBlock,
  type ReadSurfaceBlock,
  type DeployModelBlock,
  type AcvpInvariant,
} from "../domain/beacon-v2.domain.js";
import type { ProbeResult } from "../domain/probe-result.domain.js";
import { isProbeResult } from "../domain/probe-result.domain.js";
import type { SelfMode } from "../domain/self-check.domain.js";
import { probeDeployment } from "../probes/deployment.probe.js";
import { probeReadSurface } from "../probes/read-surface.probe.js";
import { parseSourcesFromConfig } from "../probes/sources.probe.js";
import { resolveAcvpStatuses } from "../acvp/proof-runner.js";
import { loadV3AcvpIds } from "./v3-reconcile.js";

function embedBlock<T extends { status: string; reason?: string }>(
  probe: ProbeResult<T>,
): T {
  if (probe.status === "verified" && probe.value) {
    return probe.value;
  }
  return {
    status: "unknown",
    reason: probe.reason ?? "probe failed",
  } as T;
}

function loadSeedOrExisting(repoRoot: string): BeaconV2Document {
  const rootBeacon = resolve(repoRoot, "beacon.yaml");
  const seedPath = resolve(repoRoot, "templates/beacon.v2.seed.yaml");

  const path = existsSync(rootBeacon) ? rootBeacon : seedPath;
  const doc = parseYaml(readFileSync(path, "utf8")) as BeaconV2Document;
  doc.schema_version = "2";
  doc._generated_sections = doc._generated_sections ?? [...DEFAULT_GENERATED_SECTIONS];
  return doc;
}

function mergeAcvpFromV3(
  existing: AcvpInvariant[],
  v3Ids: Array<{ id: string; proof_artifact?: string; scope?: string }>,
  statuses: Map<string, "aspirational" | "grounded">,
): AcvpInvariant[] {
  return v3Ids.map((v3) => {
    const prior = existing.find((e) => e.id === v3.id);
    return {
      id: v3.id,
      status: statuses.get(v3.id) ?? prior?.status ?? "aspirational",
      proof: v3.proof_artifact ?? prior?.proof,
      scope: v3.scope ?? prior?.scope,
    };
  });
}

export interface MergeInputs {
  repoRoot: string;
  mode: SelfMode;
  proveAcvp?: boolean;
}

export async function buildBeaconDraft(inputs: MergeInputs): Promise<BeaconV2Document> {
  const { repoRoot, mode, proveAcvp } = inputs;
  const base = loadSeedOrExisting(repoRoot);

  const sourcesProbe = parseSourcesFromConfig(repoRoot);
  const readSurfaceProbe = await probeReadSurface(mode);
  const deploymentProbe = await probeDeployment(mode);

  const sources = embedBlock<SourcesBlock>(sourcesProbe);
  const read_surface = embedBlock<ReadSurfaceBlock>(readSurfaceProbe);
  const deploy_model = embedBlock<DeployModelBlock>(deploymentProbe);

  if (sources.status === "verified") {
    base.identity.runtime = "envio-selfhost";
    base.identity.source_of_truth = "hypersync-postgres-hasura";
  }

  const v3 = loadV3AcvpIds(repoRoot);
  const statuses = await resolveAcvpStatuses(v3, repoRoot, Boolean(proveAcvp));

  const draft: BeaconV2Document = {
    ...base,
    sources,
    read_surface,
    deploy_model,
    acvp_invariants: mergeAcvpFromV3(base.acvp_invariants ?? [], v3, statuses),
  };

  return draft;
}

export function serializeBeacon(doc: BeaconV2Document): string {
  return stringifyYaml(doc, { lineWidth: 0 });
}

export function collectUnknownProbes(doc: BeaconV2Document): string[] {
  const unknowns: string[] = [];
  for (const section of doc._generated_sections) {
    const block = doc[section];
    if (isProbeResult(block)) {
      if (block.status === "unknown") unknowns.push(section);
      continue;
    }
    if (block && typeof block === "object" && "status" in block && block.status === "unknown") {
      unknowns.push(section);
    }
  }
  return unknowns;
}

export function pickGeneratedSnapshot(doc: BeaconV2Document): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of doc._generated_sections) {
    out[key] = normalizeForDiff(doc[key]);
  }
  out.acvp_invariants = (doc.acvp_invariants ?? []).map((i) => ({
    id: i.id,
    status: i.status,
  }));
  return out;
}

function normalizeForDiff(block: unknown): unknown {
  if (!block || typeof block !== "object") return block;
  const copy = structuredClone(block) as Record<string, unknown>;
  // Structural identity only — ephemeral deployment_status ids drift on every deploy.
  if (Array.isArray(copy.services)) {
    copy.services = (copy.services as Array<Record<string, unknown>>).map((s) => ({
      name: s.name,
      alias: s.alias,
    }));
  }
  delete copy.reason;
  return copy;
}
