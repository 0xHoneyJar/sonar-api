import type { PreparationRuntimeState } from "./types.js";

export const UNAVAILABLE_PREPARATION_RUNTIME: PreparationRuntimeState = {
  available: false,
  mode: "unavailable",
  reason: "no durable production preparation drain port is configured",
};

export const INJECTED_PREPARATION_RUNTIME: PreparationRuntimeState = {
  available: true,
  mode: "injected",
  reason: "hermetic preparation runtime injected",
};

export function preparationRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PreparationRuntimeState {
  const production = ["production", "prod"].includes(env.NODE_ENV?.trim().toLowerCase() ?? "");
  const workerFlag = env.KITCHEN_WORKER_ENABLED?.trim().toLowerCase();
  const workerEnabled = workerFlag === "1" || workerFlag === "true" || workerFlag === "yes";
  if (
    !production &&
    workerEnabled &&
    env.KITCHEN_PREPARATION_PORT?.trim() === "local_config"
  ) {
    return {
      available: true,
      mode: "local_config",
      reason: "non-production local config preparation seam enabled",
    };
  }
  return UNAVAILABLE_PREPARATION_RUNTIME;
}
