import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import type { V3AcvpEntry } from "../merge/v3-reconcile.js";

function spawnVitest(proofPath: string, repoRoot: string): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn("pnpm", ["exec", "vitest", "run", proofPath], {
      cwd: repoRoot,
      stdio: "ignore",
      shell: false,
    });
    child.on("close", (code) => resolveExit(code ?? 1));
    child.on("error", () => resolveExit(1));
  });
}

export async function resolveAcvpStatuses(
  invariants: V3AcvpEntry[],
  repoRoot: string,
  proveAcvp: boolean,
): Promise<Map<string, "aspirational" | "grounded">> {
  const map = new Map<string, "aspirational" | "grounded">();

  for (const inv of invariants) {
    const proof = inv.proof_artifact;
    if (!proof) {
      map.set(inv.id, "aspirational");
      continue;
    }
    const abs = resolve(repoRoot, proof);
    if (!existsSync(abs)) {
      map.set(inv.id, "aspirational");
      continue;
    }
    if (!proveAcvp) {
      map.set(inv.id, "aspirational");
      continue;
    }
    const code = await spawnVitest(proof, repoRoot);
    map.set(inv.id, code === 0 ? "grounded" : "aspirational");
  }

  return map;
}
