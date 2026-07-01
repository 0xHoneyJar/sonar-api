import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export interface EnvioConfigShape {
  contracts?: unknown[];
  chains?: Array<{ id: number; hypersync_config?: unknown; rpc_config?: unknown }>;
}

export function readEnvioConfig(configPath: string): EnvioConfigShape {
  const abs = resolve(configPath);
  const raw = readFileSync(abs, "utf8");
  return parseYaml(raw) as EnvioConfigShape;
}

export function resolveConfigPath(repoRoot: string): string {
  const override = process.env.BELT_CONFIG;
  return resolve(repoRoot, override ?? "config.yaml");
}
