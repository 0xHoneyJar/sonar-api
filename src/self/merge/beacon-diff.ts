import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { BeaconV2Document } from "../domain/beacon-v2.domain.js";
import { pickGeneratedSnapshot } from "./beacon-merge.js";
import { reconcileV3Ids } from "./v3-reconcile.js";

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (v as Record<string, unknown>)[key];
          return acc;
        }, {});
    }
    return v;
  });
}

function diffObjects(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  prefix = "",
): string[] {
  const drifts: string[] = [];
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of [...keys].sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const a = left[key];
    const b = right[key];
    if (a === undefined) {
      drifts.push(`${path}: missing in committed beacon`);
      continue;
    }
    if (b === undefined) {
      drifts.push(`${path}: extra in committed beacon`);
      continue;
    }
    if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
      if (Array.isArray(a) || Array.isArray(b)) {
        if (stableStringify(a) !== stableStringify(b)) {
          drifts.push(`${path}: array drift`);
        }
      } else {
        drifts.push(
          ...diffObjects(
            a as Record<string, unknown>,
            b as Record<string, unknown>,
            path,
          ),
        );
      }
      continue;
    }
    if (a !== b) {
      drifts.push(`${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    }
  }
  return drifts;
}

export function diffBeacon(
  committed: BeaconV2Document,
  live: BeaconV2Document,
  repoRoot: string,
): string[] {
  const drifts = diffObjects(
    pickGeneratedSnapshot(committed),
    pickGeneratedSnapshot(live),
  );

  const v3Drifts = reconcileV3Ids(committed, repoRoot);
  return [...drifts, ...v3Drifts];
}

export function loadCommittedBeacon(repoRoot: string): BeaconV2Document | null {
  const path = resolve(repoRoot, "beacon.yaml");
  if (!existsSync(path)) return null;
  return parseYaml(readFileSync(path, "utf8")) as BeaconV2Document;
}
