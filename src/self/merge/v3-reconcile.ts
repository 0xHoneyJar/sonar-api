import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { BeaconV2Document } from "../domain/beacon-v2.domain.js";

export interface V3AcvpEntry {
  id: string;
  proof_artifact?: string;
  scope?: string;
}

export function loadV3AcvpIds(repoRoot: string): V3AcvpEntry[] {
  const path = resolve(repoRoot, "packages/protocol/beacon.yaml");
  const doc = parseYaml(readFileSync(path, "utf8")) as {
    acvp_invariants?: Array<{
      id: string;
      proof_artifact?: string;
      scope?: string;
    }>;
  };
  return (doc.acvp_invariants ?? []).map((i) => ({
    id: i.id,
    proof_artifact: i.proof_artifact,
    scope: i.scope,
  }));
}

export function reconcileV3Ids(
  committed: BeaconV2Document,
  repoRoot: string,
): string[] {
  const v3 = loadV3AcvpIds(repoRoot);
  const v3Ids = new Set(v3.map((i) => i.id));
  const v2Ids = new Set((committed.acvp_invariants ?? []).map((i) => i.id));

  const drifts: string[] = [];
  for (const id of v3Ids) {
    if (!v2Ids.has(id)) {
      drifts.push(`acvp_invariants: v3 declares ${id} missing from committed v2 beacon`);
    }
  }
  for (const id of v2Ids) {
    if (!v3Ids.has(id)) {
      drifts.push(`acvp_invariants: committed v2 declares ${id} missing from v3 beacon`);
    }
  }
  return drifts;
}
