/**
 * helius-meter — in-process credit-burn counter for every Helius call the SVM lane makes.
 *
 * Why: KF-018 (#122) exhausted the monthly Helius quota with zero visibility into which call
 * class was burning it. This meter answers "credits/day by call type, per lane" so cadence and
 * provider decisions are made from a measured number, not the bill's total.
 *
 * Lane attribution comes free from process identity — the reconcile cron, the webhook, and the
 * ownership snapshot are separate processes, so per-process counters + a label at emit time is
 * the whole design. No storage: one `[helius-meter]` JSON line at process exit (Actions/Railway
 * logs are the ledger; scripts/svm-meter-report.sh aggregates), plus live counts on the webhook's
 * existing /health.
 *
 * `estimated_credits` = attempts × published list price (docs.helius.dev/billing/credits,
 * verified 2026-07-05: standard RPC 1 · DAS 10 · Enhanced Transactions 100). Attempts that fail
 * (e.g. 429) may not bill — treat the estimate as an upper bound, and reconcile weekly against
 * the dashboard's billed number.
 */

export type MeterKind = "rpc" | "das" | "enhanced";

export const CREDIT_WEIGHTS: Record<MeterKind, number> = { rpc: 1, das: 10, enhanced: 100 };

// The DAS method family per Helius billing docs — anything else on the JSON-RPC surface bills as
// standard RPC (1 credit).
const DAS_METHODS = new Set([
  "getAsset",
  "getAssetBatch",
  "getAssetProof",
  "getAssetProofBatch",
  "getAssetsByOwner",
  "getAssetsByAuthority",
  "getAssetsByCreator",
  "getAssetsByGroup",
  "searchAssets",
  "getSignaturesForAsset",
  "getTokenAccounts",
]);

export function classifyRpcMethod(method: string): MeterKind {
  return DAS_METHODS.has(method) ? "das" : "rpc";
}

const counts = new Map<string, number>(); // key: `${kind}:${method}`

/** Count one call attempt. Pure counter — never throws, never does I/O. */
export function meter(kind: MeterKind, method: string, n = 1): void {
  const key = `${kind}:${method}`;
  counts.set(key, (counts.get(key) ?? 0) + n);
}

export interface MeterSummary {
  calls: Record<string, number>;
  by_kind: Record<MeterKind, { calls: number; estimated_credits: number }>;
  estimated_credits: number;
}

export function meterSummary(): MeterSummary {
  const calls: Record<string, number> = {};
  const by_kind: MeterSummary["by_kind"] = {
    rpc: { calls: 0, estimated_credits: 0 },
    das: { calls: 0, estimated_credits: 0 },
    enhanced: { calls: 0, estimated_credits: 0 },
  };
  let total = 0;
  for (const [key, n] of counts) {
    calls[key] = n;
    const kind = key.slice(0, key.indexOf(":")) as MeterKind;
    const credits = n * CREDIT_WEIGHTS[kind];
    by_kind[kind].calls += n;
    by_kind[kind].estimated_credits += credits;
    total += credits;
  }
  return { calls, by_kind, estimated_credits: total };
}

/** One grep-able JSON line — the ledger row scripts/svm-meter-report.sh aggregates. */
export function logMeterSummary(label: string): void {
  console.log(`[helius-meter] ${JSON.stringify({ label, at: new Date().toISOString(), ...meterSummary() })}`);
}

let exitLogInstalled = false;
/**
 * Emit the summary when the process exits — INCLUDING crash paths. A KF-018-class run burns its
 * DAS credits and then dies; a success-only emit would meter exactly the runs that matter least.
 */
export function installMeterExitLog(label: string): void {
  if (exitLogInstalled) return;
  exitLogInstalled = true;
  process.on("exit", () => logMeterSummary(label));
  // BB HIGH (PR #123): 'exit' does NOT fire on unhandled POSIX signals, and Railway sends
  // SIGTERM on every deploy/restart — exactly when the long-running webhook's summary matters
  // most. Convert signals to a normal exit (which then fires the handler above), but only if
  // nobody else handles them (respect an app-level graceful-shutdown handler if one appears).
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    if (process.listenerCount(sig) === 0) {
      process.on(sig, () => process.exit(0));
    }
  }
}

/** Test seam. */
export function resetMeter(): void {
  counts.clear();
}
