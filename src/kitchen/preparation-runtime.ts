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

export type PreparationDrainStrategy = "file" | "webhook" | "external_scale" | "none";

/** Once-per-process: ambiguous implicit drain env is fail-closed and noisy. */
let ambiguousDrainLogged = false;

function workerFlagEnabled(env: NodeJS.ProcessEnv): boolean {
  const workerFlag = env.KITCHEN_WORKER_ENABLED?.trim().toLowerCase();
  return workerFlag === "1" || workerFlag === "true" || workerFlag === "yes";
}

/**
 * Resolve how the worker materializes a claimed batch into Belt config.
 *
 * - `file`: mutate `KITCHEN_BELT_CONFIG_PATH` then optional restart webhook
 * - `webhook`: POST one batched patch plan to `KITCHEN_BELT_CONFIG_PATCH_WEBHOOK`
 * - `external_scale`: config is applied out-of-band (SCALE blue-green / PR);
 *   Kitchen leaves jobs queued until `POST …/ack` (or Hasura readiness completes)
 *
 * Explicit `KITCHEN_PREPARATION_DRAIN` always wins. When unset, implicit
 * detection precedence is: file path > webhook URL (else `none`).
 */
export function preparationDrainStrategyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PreparationDrainStrategy {
  const drain = env.KITCHEN_PREPARATION_DRAIN?.trim().toLowerCase();
  // Explicit drain name wins when set (file|webhook|external_scale|external).
  if (drain === "file") return "file";
  if (drain === "webhook") return "webhook";
  if (drain === "external_scale" || drain === "external") return "external_scale";

  const hasFile = Boolean(env.KITCHEN_BELT_CONFIG_PATH?.trim());
  const hasWebhook = Boolean(env.KITCHEN_BELT_CONFIG_PATCH_WEBHOOK?.trim());
  if (hasFile && hasWebhook) {
    // Ambiguous implicit config — fail closed until the operator picks one.
    if (!ambiguousDrainLogged) {
      ambiguousDrainLogged = true;
      console.error(
        "[kitchen] both KITCHEN_BELT_CONFIG_PATH and KITCHEN_BELT_CONFIG_PATCH_WEBHOOK are set; set KITCHEN_PREPARATION_DRAIN=file|webhook explicitly",
      );
    }
    return "none";
  }
  if (hasFile) return "file";
  if (hasWebhook) return "webhook";
  return "none";
}

export function preparationRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PreparationRuntimeState {
  const production = ["production", "prod"].includes(env.NODE_ENV?.trim().toLowerCase() ?? "");
  const workerEnabled = workerFlagEnabled(env);
  const port = env.KITCHEN_PREPARATION_PORT?.trim();

  if (!production && workerEnabled && port === "local_config") {
    return {
      available: true,
      mode: "local_config",
      reason: "non-production local config preparation seam enabled",
    };
  }

  // Production (and prod-like) durable drain: batch Belt config materialization.
  // Admission stays fail-closed unless an explicit drain strategy is configured
  // so jobs are never accepted into an immortal queue.
  if (workerEnabled && port === "belt_config_batch") {
    const strategy = preparationDrainStrategyFromEnv(env);
    if (strategy === "none") {
      return {
        available: false,
        mode: "unavailable",
        reason:
          "KITCHEN_PREPARATION_PORT=belt_config_batch requires KITCHEN_BELT_CONFIG_PATH, KITCHEN_BELT_CONFIG_PATCH_WEBHOOK, or KITCHEN_PREPARATION_DRAIN=external_scale",
      };
    }
    if (strategy === "file" && !env.KITCHEN_BELT_CONFIG_PATH?.trim()) {
      return {
        available: false,
        mode: "unavailable",
        reason:
          "KITCHEN_PREPARATION_DRAIN=file requires KITCHEN_BELT_CONFIG_PATH",
      };
    }
    if (strategy === "webhook" && !env.KITCHEN_BELT_CONFIG_PATCH_WEBHOOK?.trim()) {
      return {
        available: false,
        mode: "unavailable",
        reason:
          "KITCHEN_PREPARATION_DRAIN=webhook requires KITCHEN_BELT_CONFIG_PATCH_WEBHOOK",
      };
    }
    if (
      strategy === "webhook" &&
      production &&
      !env.KITCHEN_BELT_CONFIG_PATCH_WEBHOOK_TOKEN?.trim()
    ) {
      return {
        available: false,
        mode: "unavailable",
        reason:
          "production webhook drain requires KITCHEN_BELT_CONFIG_PATCH_WEBHOOK_TOKEN (Bearer auth on outbound patches)",
      };
    }
    return {
      available: true,
      mode: "belt_config_batch",
      reason: `durable batch preparation drain (${strategy})`,
    };
  }

  return UNAVAILABLE_PREPARATION_RUNTIME;
}
