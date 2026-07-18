import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { patchConfigForKitchenIngest } from "./config-patcher.js";
import type { IngestJobStorePort } from "./ingest-store.js";
import {
  preparationDrainStrategyFromEnv,
  preparationRuntimeFromEnv,
  type PreparationDrainStrategy,
} from "./preparation-runtime.js";
import { BATCH_PREPARATION_MAX_ITEMS } from "./protocol.js";
import { isIndexedSnapshotReady, type CollectionStatusReader } from "./status.js";
import type { IngestJobRecord } from "./types.js";

export function beltConfigPathFromEnv(): string {
  return process.env.KITCHEN_BELT_CONFIG_PATH?.trim() || "config.yaml";
}

export function kitchenBatchClaimLimitFromEnv(): number {
  const parsed = Number(process.env.KITCHEN_BATCH_CLAIM_LIMIT ?? BATCH_PREPARATION_MAX_ITEMS);
  if (!Number.isFinite(parsed)) return BATCH_PREPARATION_MAX_ITEMS;
  return Math.min(BATCH_PREPARATION_MAX_ITEMS, Math.max(1, Math.floor(parsed)));
}

/**
 * Async preparation stays off unless the operator explicitly selects a
 * preparation port. `local_config` is non-production only; production uses
 * `belt_config_batch` with an explicit drain strategy.
 */
export function kitchenWorkerEnabled(): boolean {
  const mode = preparationRuntimeFromEnv().mode;
  return mode === "local_config" || mode === "belt_config_batch";
}

export function kitchenWorkerIntervalMs(): number {
  const parsed = Number(process.env.KITCHEN_WORKER_INTERVAL_MS ?? 30_000);
  return Number.isFinite(parsed) && parsed >= 5_000 ? parsed : 30_000;
}

export function kitchenIngestTimeoutMs(): number {
  const parsed = Number(process.env.KITCHEN_INGEST_TIMEOUT_MS ?? 86_400_000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 86_400_000;
}

function deterministicJobLabel(job: IngestJobRecord): string {
  const network = job.deployment.network;
  return `kitchen_${network.network_namespace}_${network.network_reference}_${job.deployment.deployment_id.digest.slice(0, 12)}`;
}

export function applyBeltConfigPatch(args: {
  configPath: string;
  job: IngestJobRecord;
  readFile?: (path: string) => string;
  writeFile?: (path: string, contents: string) => void;
}): { changed: boolean } {
  const result = applyBeltConfigPatchesBatch({
    configPath: args.configPath,
    jobs: [args.job],
    readFile: args.readFile,
    writeFile: args.writeFile,
  });
  return { changed: result.changed };
}

/** Shared belt-mutation guard for batch patch + webhook plan builders. */
export function validateBeltJob(job: IngestJobRecord): void {
  if (job.tokenStandard !== "erc721" || !job.key) {
    throw new Error(`unsupported_standard: ${job.tokenStandard} cannot mutate Belt config`);
  }
  if (
    job.prepareAdapterId !== "belt.eth-erc721" &&
    job.prepareAdapterId !== "belt.evm-erc721"
  ) {
    throw new Error(`unsupported_adapter: ${job.prepareAdapterId}`);
  }
}

/** Apply many ERC-721 Tracked* address patches in one config rewrite. */
export function applyBeltConfigPatchesBatch(args: {
  configPath: string;
  jobs: IngestJobRecord[];
  readFile?: (path: string) => string;
  writeFile?: (path: string, contents: string) => void;
}): { changed: boolean; patchedJobIds: string[] } {
  // Validate the whole batch before touching the filesystem so a bad item
  // cannot leave a partial rewrite and never triggers a spurious read.
  for (const job of args.jobs) validateBeltJob(job);

  const readFile = args.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const writeFile = args.writeFile ?? ((path: string, contents: string) => {
    writeFileSync(path, contents, "utf8");
  });

  let configYaml = readFile(args.configPath);
  let changed = false;
  const patchedJobIds: string[] = [];

  for (const job of args.jobs) {
    const patched = patchConfigForKitchenIngest({
      configYaml,
      key: job.key!,
      label: deterministicJobLabel(job),
      contractName:
        job.prepareAdapterId === "belt.eth-erc721" ? "EthTrackedErc721" : "TrackedErc721",
    });
    if (patched.changed) {
      changed = true;
      configYaml = patched.configYaml;
      patchedJobIds.push(job.physicalJobId);
    }
  }

  if (changed) writeFile(args.configPath, configYaml);
  // patchedJobIds: net-new addresses in this rewrite (idempotent skips omitted).
  return { changed, patchedJobIds };
}

export type BeltConfigPatchPlanItem = {
  physical_job_id: string;
  chain_id: number;
  contract: `0x${string}`;
  label: string;
  contract_name: "EthTrackedErc721" | "TrackedErc721";
};

export function buildBeltConfigPatchPlan(jobs: IngestJobRecord[]): BeltConfigPatchPlanItem[] {
  const items: BeltConfigPatchPlanItem[] = [];
  for (const job of jobs) {
    validateBeltJob(job);
    items.push({
      physical_job_id: job.physicalJobId,
      chain_id: job.key!.chainId,
      contract: job.key!.contract,
      label: deterministicJobLabel(job),
      contract_name:
        job.prepareAdapterId === "belt.eth-erc721" ? "EthTrackedErc721" : "TrackedErc721",
    });
  }
  return items;
}

function extractErrorCode(message: string, fallback: string): string {
  // Only accept snake_case / identifier codes before the first colon.
  const match = /^([a-z][a-z0-9_]{0,63}):/.exec(message);
  return match?.[1] ?? fallback;
}

async function notifyIndexerRestart(): Promise<void> {
  const webhook = process.env.KITCHEN_INDEXER_RESTART_WEBHOOK?.trim();
  if (!webhook) return;
  const response = await /* @non-metadata-fetch kitchen webhook */ fetch(webhook, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`indexer restart webhook HTTP ${response.status}`);
  }
}

async function postBeltConfigPatchWebhook(plan: BeltConfigPatchPlanItem[]): Promise<void> {
  const webhook = process.env.KITCHEN_BELT_CONFIG_PATCH_WEBHOOK?.trim();
  if (!webhook) {
    throw new Error("missing_patch_webhook: KITCHEN_BELT_CONFIG_PATCH_WEBHOOK is required");
  }
  const response = await /* @non-metadata-fetch kitchen patch webhook */ fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: 1,
      drain: "belt_config_batch",
      patches: plan,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`config patch webhook HTTP ${response.status}`);
  }
}

function webhookOwnsRestart(): boolean {
  const raw = process.env.KITCHEN_BELT_WEBHOOK_OWNS_RESTART?.trim().toLowerCase();
  // Default: webhook drain owns restart (patch webhook is expected to apply + bounce).
  return raw !== "0" && raw !== "false" && raw !== "no";
}

async function renewJobs(args: {
  store: IngestJobStorePort;
  jobs: IngestJobRecord[];
  nowMs?: number;
}): Promise<IngestJobRecord[]> {
  const renewed: IngestJobRecord[] = [];
  for (const job of args.jobs) {
    if (!job.leaseOwner || job.leaseUntilMs === undefined) {
      console.warn("[kitchen] skip renew — job %s missing lease", job.physicalJobId);
      continue;
    }
    const next = await args.store.renewLease({
      physicalJobId: job.physicalJobId,
      lease: { owner: job.leaseOwner, epoch: job.leaseEpoch },
      nowMs: args.nowMs,
    });
    if (next) renewed.push(next);
    else {
      console.warn(
        "[kitchen] renewLease CAS miss for %s (owner=%s epoch=%s)",
        job.physicalJobId,
        job.leaseOwner,
        job.leaseEpoch,
      );
    }
  }
  return renewed;
}

async function markBatchIndexing(args: {
  store: IngestJobStorePort;
  jobs: IngestJobRecord[];
  nowMs?: number;
}): Promise<void> {
  for (const job of args.jobs) {
    if (!job.leaseOwner) continue;
    await args.store.updateStatus(job.physicalJobId, "indexing", {
      nowMs: args.nowMs,
      expectedLease: { owner: job.leaseOwner, epoch: job.leaseEpoch },
      expectedStatus: "queued",
    });
  }
}

async function markBatchFailed(args: {
  store: IngestJobStorePort;
  jobs: IngestJobRecord[];
  errorCode: string;
  errorMessage: string;
  expectedStatus: "queued" | "indexing";
  nowMs?: number;
}): Promise<void> {
  for (const job of args.jobs) {
    if (!job.leaseOwner) continue;
    await args.store.updateStatus(job.physicalJobId, "failed", {
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
      nowMs: args.nowMs,
      expectedLease: { owner: job.leaseOwner, epoch: job.leaseEpoch },
      expectedStatus: args.expectedStatus,
    });
  }
}

/** Release leases while remaining queued (external_scale awaiting SCALE ack). */
async function releaseBatchLeases(args: {
  store: IngestJobStorePort;
  jobs: IngestJobRecord[];
  nowMs?: number;
}): Promise<void> {
  for (const job of args.jobs) {
    if (!job.leaseOwner) continue;
    await args.store.updateStatus(job.physicalJobId, "queued", {
      nowMs: args.nowMs,
      expectedLease: { owner: job.leaseOwner, epoch: job.leaseEpoch },
      expectedStatus: "queued",
      releaseLease: true,
    });
  }
}

/**
 * Drain one claimed batch: single config materialization + single restart.
 * Prefer this over per-job processQueuedIngestJob for production scaling.
 *
 * Phase split (BB F-002): materialize first; only then advance status. Catch
 * handlers use the phase-appropriate expectedStatus so partial advances are
 * recoverable.
 */
export async function processQueuedIngestBatch(args: {
  jobs: IngestJobRecord[];
  store: IngestJobStorePort;
  drainStrategy?: PreparationDrainStrategy;
  configPath?: string;
  readFile?: (path: string) => string;
  writeFile?: (path: string, contents: string) => void;
  restart?: () => Promise<void>;
  postPatchWebhook?: (plan: BeltConfigPatchPlanItem[]) => Promise<void>;
  nowMs?: number;
}): Promise<void> {
  if (args.jobs.length === 0) return;

  const renewed = await renewJobs({
    store: args.store,
    jobs: args.jobs,
    nowMs: args.nowMs,
  });
  if (renewed.length === 0) return;

  const strategy = args.drainStrategy ?? preparationDrainStrategyFromEnv();

  // external_scale: config is applied out-of-band. Do NOT mark indexing here —
  // jobs stay queued until POST /v2/collection-preparations/ack (or Hasura
  // readiness completes them directly from queued).
  if (strategy === "external_scale") {
    await releaseBatchLeases({ store: args.store, jobs: renewed, nowMs: args.nowMs });
    return;
  }

  try {
    if (strategy === "file") {
      const applied = applyBeltConfigPatchesBatch({
        configPath: args.configPath ?? beltConfigPathFromEnv(),
        jobs: renewed,
        readFile: args.readFile,
        writeFile: args.writeFile,
      });
      if (applied.changed) {
        console.log(
          "[kitchen] belt_config_batch file drain patched %d/%d jobs",
          applied.patchedJobIds.length,
          renewed.length,
        );
      }
      await (args.restart ?? notifyIndexerRestart)();
    } else if (strategy === "webhook") {
      const plan = buildBeltConfigPatchPlan(renewed);
      await (args.postPatchWebhook ?? postBeltConfigPatchWebhook)(plan);
      // Webhook drain owns apply+bounce by default; opt into a second restart
      // webhook with KITCHEN_BELT_WEBHOOK_OWNS_RESTART=false.
      if (!webhookOwnsRestart()) {
        await (args.restart ?? notifyIndexerRestart)();
      }
    } else {
      // `none` and unknown strategies fail closed — never silently mutate config.
      throw new Error(`unsupported_drain: ${strategy}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markBatchFailed({
      store: args.store,
      jobs: renewed,
      errorCode: extractErrorCode(message, "preparation_failed"),
      errorMessage: message,
      expectedStatus: "queued",
      nowMs: args.nowMs,
    });
    return;
  }

  try {
    await markBatchIndexing({ store: args.store, jobs: renewed, nowMs: args.nowMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = extractErrorCode(message, "status_advance_failed");
    // Per-job: fail only those still queued; already-indexing jobs keep their
    // lease/status and rely on the indexing timeout watchdog (BB F-002).
    for (const job of renewed) {
      if (!job.leaseOwner) continue;
      const current = await args.store.getByPhysicalJobId(job.physicalJobId);
      if (!current || current.status !== "queued") continue;
      await args.store.updateStatus(job.physicalJobId, "failed", {
        errorCode,
        errorMessage: message,
        nowMs: args.nowMs,
        expectedLease: { owner: job.leaseOwner, epoch: job.leaseEpoch },
        expectedStatus: "queued",
      });
    }
  }
}

/** @deprecated Prefer processQueuedIngestBatch — kept for unit tests of single-job adapters. */
export async function processQueuedIngestJob(args: {
  job: IngestJobRecord;
  store: IngestJobStorePort;
  configPath?: string;
  readFile?: (path: string) => string;
  writeFile?: (path: string, contents: string) => void;
  restart?: () => Promise<void>;
  nowMs?: number;
}): Promise<void> {
  await processQueuedIngestBatch({
    jobs: [args.job],
    store: args.store,
    drainStrategy: "file",
    configPath: args.configPath,
    readFile: args.readFile,
    writeFile: args.writeFile,
    restart: args.restart,
    nowMs: args.nowMs,
  });
}

/**
 * Complete jobs that already have Hasura readiness evidence while still
 * queued (external_scale awaiting ack, or ack skipped after SCALE apply).
 */
export async function advanceQueuedJobsViaReadiness(args: {
  store: IngestJobStorePort;
  reader: CollectionStatusReader;
  nowMs?: number;
}): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  // Same cap as BATCH_PREPARATION_MAX_ITEMS / claim batch — one drain wave.
  const jobs = await args.store.listByStatus("queued", kitchenBatchClaimLimitFromEnv());
  for (const job of jobs) {
    if (!job.key) continue;
    // Skip actively leased jobs — worker owns them until release.
    if (job.leaseOwner) continue;
    const indexed = await args.reader.readIndexedSnapshot(job.key);
    if (!isIndexedSnapshotReady(indexed)) continue;
    const updated = await args.store.updateStatus(job.physicalJobId, "completed", {
      nowMs,
      expectedStatus: "queued",
    });
    if (!updated) {
      console.warn(
        "[kitchen] queued readiness complete CAS miss for %s (claimed between list and update)",
        job.physicalJobId,
      );
    }
  }
}

export async function advanceIndexingJobs(args: {
  store: IngestJobStorePort;
  reader: CollectionStatusReader;
  nowMs?: number;
  timeoutMs?: number;
}): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  const timeoutMs = args.timeoutMs ?? kitchenIngestTimeoutMs();
  const jobs = await args.store.listByStatus("indexing", 100);

  for (const job of jobs) {
    if (!job.key) {
      await args.store.updateStatus(job.physicalJobId, "failed", {
        nowMs,
        errorCode: "readiness_unsupported",
        errorMessage: "no readiness adapter exists for this deployment",
        expectedStatus: "indexing",
      });
      continue;
    }
    const indexed = await args.reader.readIndexedSnapshot(job.key);
    if (isIndexedSnapshotReady(indexed)) {
      // Readiness completion is an intentional coordinator transition after
      // preparation has reached indexing; it is not publication by the former
      // queued-job lease holder.
      await args.store.updateStatus(job.physicalJobId, "completed", {
        nowMs,
        expectedStatus: "indexing",
      });
      continue;
    }
    if (nowMs - job.updatedAtMs > timeoutMs) {
      await args.store.updateStatus(job.physicalJobId, "failed", {
        nowMs,
        errorCode: "indexing_timeout",
        errorMessage: `indexing timeout after ${timeoutMs}ms (no explicit readiness evidence)`,
        expectedStatus: "indexing",
      });
    }
  }
}

export async function runKitchenIngestWorkerTick(args: {
  store: IngestJobStorePort;
  reader: CollectionStatusReader;
  workerId?: string;
  configPath?: string;
  readFile?: (path: string) => string;
  writeFile?: (path: string, contents: string) => void;
  restart?: () => Promise<void>;
  nowMs?: number;
}): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  await args.store.reconcileUnbackfilledActiveJobs(nowMs);
  const queued = await args.store.claimQueued({
    workerId: args.workerId ?? `kitchen-${randomUUID()}`,
    limit: kitchenBatchClaimLimitFromEnv(),
    nowMs,
  });
  // One tick = one drain batch (single config rewrite / webhook / restart).
  const runtime = preparationRuntimeFromEnv();
  const drainStrategy = preparationDrainStrategyFromEnv();
  // local_config hermetic seam implies file drain; production never invents one.
  const effectiveDrain: PreparationDrainStrategy | null =
    drainStrategy !== "none"
      ? drainStrategy
      : runtime.mode === "local_config"
        ? "file"
        : null;
  if (effectiveDrain) {
    await processQueuedIngestBatch({
      jobs: queued,
      store: args.store,
      drainStrategy: effectiveDrain,
      configPath: args.configPath,
      readFile: args.readFile,
      writeFile: args.writeFile,
      restart: args.restart,
      nowMs,
    });
  } else if (queued.length > 0) {
    console.warn(
      "[kitchen] claimed %d jobs but no drain strategy is configured — leaving queued",
      queued.length,
    );
  }
  // Queued→completed via Hasura is only for external_scale (ack optional shortcut).
  if (effectiveDrain === "external_scale") {
    await advanceQueuedJobsViaReadiness({ store: args.store, reader: args.reader, nowMs });
  }
  await advanceIndexingJobs({ store: args.store, reader: args.reader, nowMs });
}

export function startKitchenIngestWorker(args: {
  store: IngestJobStorePort;
  reader: CollectionStatusReader;
}): () => void {
  const intervalMs = kitchenWorkerIntervalMs();
  const workerId = `kitchen-${randomUUID()}`;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runKitchenIngestWorkerTick({ ...args, workerId });
    } catch (error) {
      console.error("[kitchen-worker] tick failed:", error);
    } finally {
      running = false;
    }
  };
  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(handle);
}
