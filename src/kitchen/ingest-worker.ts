import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { mapPool } from "./async-pool.js";
import { patchConfigForKitchenIngest } from "./config-patcher.js";
import type { IngestJobStorePort } from "./ingest-store.js";
import { collectionKeyId } from "./normalize.js";
import {
  preparationDrainStrategyFromEnv,
  preparationRuntimeFromEnv,
  type PreparationDrainStrategy,
} from "./preparation-runtime.js";
import { BATCH_PREPARATION_MAX_ITEMS } from "./protocol.js";
import { isIndexedSnapshotReady, type CollectionStatusReader } from "./status.js";
import type { IngestJobRecord } from "./types.js";

/** Bounded fan-out for per-job store / Hasura I/O inside a worker tick. */
const STORE_IO_CONCURRENCY = 16;

async function readJobSnapshots(
  reader: CollectionStatusReader,
  jobs: IngestJobRecord[],
) {
  const keys = jobs.flatMap((job) => (job.key ? [job.key] : []));
  if (reader.readIndexedSnapshots) {
    return reader.readIndexedSnapshots(keys);
  }
  const rows = await mapPool(keys, STORE_IO_CONCURRENCY, async (key) => [
    collectionKeyId(key),
    await reader.readIndexedSnapshot(key),
  ] as const);
  return new Map(rows);
}

export function beltConfigPathFromEnv(): string {
  return process.env.KITCHEN_BELT_CONFIG_PATH?.trim() || "config.yaml";
}

export function kitchenBatchClaimLimitFromEnv(): number {
  const raw = process.env.KITCHEN_BATCH_CLAIM_LIMIT?.trim();
  if (!raw) return BATCH_PREPARATION_MAX_ITEMS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return BATCH_PREPARATION_MAX_ITEMS;
  return Math.min(BATCH_PREPARATION_MAX_ITEMS, Math.max(1, Math.floor(parsed)));
}

/** Per-tick scan depth for unleased queued → completed via Hasura readiness. */
export function kitchenReadinessScanLimitFromEnv(): number {
  const raw = process.env.KITCHEN_READINESS_SCAN_LIMIT?.trim();
  if (!raw) return 500;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 500;
  return Math.min(5_000, Math.max(1, Math.floor(parsed)));
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

/** Log upstream webhook bodies for operators; never persist them on job records. */
async function logWebhookErrorBody(response: Response, cap = 500): Promise<void> {
  try {
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (text.length < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length >= cap) break;
    }
    await reader.cancel().catch(() => undefined);
    text = text.trim().slice(0, cap);
    if (!text) return;
    console.warn("[kitchen] webhook error body (status=%s): %s", response.status, text);
  } catch {
    // ignore body read failures
  }
}

function webhookIdempotencyKey(plan: BeltConfigPatchPlanItem[]): string {
  // Optional epoch lets operators force a re-apply after Belt rollback
  // (same contract set → new key) without disabling webhook dedupe.
  const epoch = process.env.KITCHEN_BELT_PATCH_IDEMPOTENCY_EPOCH?.trim() ?? "";
  const material = [
    `epoch=${epoch}`,
    ...plan
      .map((item) => `${item.chain_id}:${item.contract_name}:${item.contract.toLowerCase()}`)
      .sort(),
  ].join("\n");
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 32);
  return `belt-patch-${digest}`;
}

function bearerAuthHeader(token: string | undefined): Record<string, string> {
  const trimmed = token?.trim();
  if (!trimmed) return {};
  return { authorization: `Bearer ${trimmed}` };
}

async function notifyIndexerRestart(): Promise<void> {
  const webhook = process.env.KITCHEN_INDEXER_RESTART_WEBHOOK?.trim();
  if (!webhook) return;
  const response = await /* @non-metadata-fetch kitchen webhook */ fetch(webhook, {
    method: "POST",
    headers: bearerAuthHeader(process.env.KITCHEN_INDEXER_RESTART_WEBHOOK_TOKEN),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await logWebhookErrorBody(response);
    throw new Error(`indexer restart webhook HTTP ${response.status}`);
  }
}

async function postBeltConfigPatchWebhook(plan: BeltConfigPatchPlanItem[]): Promise<void> {
  const webhook = process.env.KITCHEN_BELT_CONFIG_PATCH_WEBHOOK?.trim();
  if (!webhook) {
    throw new Error("missing_patch_webhook: KITCHEN_BELT_CONFIG_PATCH_WEBHOOK is required");
  }
  const idempotencyKey = webhookIdempotencyKey(plan);
  const response = await /* @non-metadata-fetch kitchen patch webhook */ fetch(webhook, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      ...bearerAuthHeader(process.env.KITCHEN_BELT_CONFIG_PATCH_WEBHOOK_TOKEN),
    },
    body: JSON.stringify({
      schema_version: 1,
      drain: "belt_config_batch",
      idempotency_key: idempotencyKey,
      patches: plan,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await logWebhookErrorBody(response);
    throw new Error(`config patch webhook HTTP ${response.status}`);
  }
}

/**
 * After a successful patch webhook, also POST KITCHEN_INDEXER_RESTART_WEBHOOK.
 * Default false (patch webhook owns apply+bounce). Opt in via
 * KITCHEN_BELT_ALSO_NOTIFY_RESTART=true, or legacy
 * KITCHEN_BELT_WEBHOOK_OWNS_RESTART=false.
 */
export function alsoNotifyIndexerRestart(env: NodeJS.ProcessEnv = process.env): boolean {
  const also = env.KITCHEN_BELT_ALSO_NOTIFY_RESTART?.trim().toLowerCase();
  if (also === "1" || also === "true" || also === "yes") return true;
  const legacyOwns = env.KITCHEN_BELT_WEBHOOK_OWNS_RESTART?.trim().toLowerCase();
  if (legacyOwns === "0" || legacyOwns === "false" || legacyOwns === "no") {
    console.warn(
      "[kitchen] KITCHEN_BELT_WEBHOOK_OWNS_RESTART=false is deprecated; prefer KITCHEN_BELT_ALSO_NOTIFY_RESTART=true",
    );
    return true;
  }
  return false;
}

async function renewJobs(args: {
  store: IngestJobStorePort;
  jobs: IngestJobRecord[];
  nowMs?: number;
}): Promise<IngestJobRecord[]> {
  const candidates = args.jobs.filter((job) => {
    if (!job.leaseOwner || job.leaseUntilMs === undefined) {
      console.warn("[kitchen] skip renew — job %s missing lease", job.physicalJobId);
      return false;
    }
    return true;
  });
  const renewed = await mapPool(candidates, STORE_IO_CONCURRENCY, async (job) => {
    try {
      const next = await args.store.renewLease({
        physicalJobId: job.physicalJobId,
        lease: { owner: job.leaseOwner!, epoch: job.leaseEpoch },
        nowMs: args.nowMs,
      });
      if (!next) {
        console.warn(
          "[kitchen] renewLease CAS miss for %s (owner=%s epoch=%s)",
          job.physicalJobId,
          job.leaseOwner,
          job.leaseEpoch,
        );
      }
      return next;
    } catch (error) {
      console.warn(
        "[kitchen] renewLease threw for %s — skipping item (%s)",
        job.physicalJobId,
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    }
  });
  return renewed.filter((job): job is IngestJobRecord => Boolean(job));
}

async function markBatchIndexing(args: {
  store: IngestJobStorePort;
  jobs: IngestJobRecord[];
  nowMs?: number;
}): Promise<void> {
  const candidates = args.jobs.filter((job) => Boolean(job.leaseOwner));
  await mapPool(candidates, STORE_IO_CONCURRENCY, async (job) => {
    const updated = await args.store.updateStatus(job.physicalJobId, "indexing", {
      nowMs: args.nowMs,
      expectedLease: { owner: job.leaseOwner!, epoch: job.leaseEpoch },
      expectedStatus: "queued",
    });
    if (!updated) {
      console.warn(
        "[kitchen] markBatchIndexing CAS miss for %s (owner=%s epoch=%s) — config may already be applied",
        job.physicalJobId,
        job.leaseOwner,
        job.leaseEpoch,
      );
    }
  });
}

async function markBatchFailed(args: {
  store: IngestJobStorePort;
  jobs: IngestJobRecord[];
  errorCode: string;
  errorMessage: string;
  expectedStatus: "queued" | "indexing";
  nowMs?: number;
}): Promise<void> {
  const candidates = args.jobs.filter((job) => Boolean(job.leaseOwner));
  await mapPool(candidates, STORE_IO_CONCURRENCY, async (job) => {
    const updated = await args.store.updateStatus(job.physicalJobId, "failed", {
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
      nowMs: args.nowMs,
      expectedLease: { owner: job.leaseOwner!, epoch: job.leaseEpoch },
      expectedStatus: args.expectedStatus,
    });
    if (!updated) {
      console.warn(
        "[kitchen] markBatchFailed CAS miss for %s (expectedStatus=%s owner=%s epoch=%s)",
        job.physicalJobId,
        args.expectedStatus,
        job.leaseOwner,
        job.leaseEpoch,
      );
    }
  });
}

/** Release leases while remaining queued (external_scale awaiting SCALE ack). */
async function releaseBatchLeases(args: {
  store: IngestJobStorePort;
  jobs: IngestJobRecord[];
  nowMs?: number;
}): Promise<void> {
  const candidates = args.jobs.filter((job) => Boolean(job.leaseOwner));
  await mapPool(candidates, STORE_IO_CONCURRENCY, async (job) => {
    const updated = await args.store.updateStatus(job.physicalJobId, "queued", {
      nowMs: args.nowMs,
      expectedLease: { owner: job.leaseOwner!, epoch: job.leaseEpoch },
      expectedStatus: "queued",
      releaseLease: true,
    });
    if (!updated) {
      console.warn(
        "[kitchen] releaseBatchLeases CAS miss for %s (owner=%s epoch=%s)",
        job.physicalJobId,
        job.leaseOwner,
        job.leaseEpoch,
      );
    }
  });
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

  let renewed: IngestJobRecord[];
  try {
    renewed = await renewJobs({
      store: args.store,
      jobs: args.jobs,
      nowMs: args.nowMs,
    });
  } catch (error) {
    console.warn(
      "[kitchen] renewJobs failed — leaving leases for TTL reclaim (%s)",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
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
      // webhook with KITCHEN_BELT_ALSO_NOTIFY_RESTART=true.
      if (alsoNotifyIndexerRestart()) {
        await (args.restart ?? notifyIndexerRestart)();
      }
    } else {
      // `none` and unknown strategies fail closed — never silently mutate config.
      throw new Error(`unsupported_drain: ${strategy}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await markBatchFailed({
        store: args.store,
        jobs: renewed,
        errorCode: extractErrorCode(message, "preparation_failed"),
        errorMessage: message,
        expectedStatus: "queued",
        nowMs: args.nowMs,
      });
    } catch (failError) {
      console.warn(
        "[kitchen] markBatchFailed after drain failure also failed — original=%s secondary=%s",
        message,
        failError instanceof Error ? failError.message : String(failError),
      );
    }
    return;
  }

  try {
    await markBatchIndexing({ store: args.store, jobs: renewed, nowMs: args.nowMs });
  } catch (error) {
    // Config/webhook already applied — never mark failed (would invite
    // duplicate rematerialize on reclaim). Release leases; leave queued so
    // readiness/ack or a later tick can advance status. Drain paths must be
    // idempotent (file rewrite is; webhook handlers must tolerate repeats).
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      "[kitchen] status_advance_failed after successful drain — releasing leases (%s)",
      message,
    );
    try {
      await releaseBatchLeases({ store: args.store, jobs: renewed, nowMs: args.nowMs });
    } catch (releaseError) {
      console.warn(
        "[kitchen] lease release after status_advance_failed also failed — leases will expire by TTL (%s)",
        releaseError instanceof Error ? releaseError.message : String(releaseError),
      );
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
  // Wider than a claim wave so external_scale backlogs still advance when
  // Hasura is already ready (override via KITCHEN_READINESS_SCAN_LIMIT).
  const jobs = await args.store.listByStatus("queued", kitchenReadinessScanLimitFromEnv(), {
    unleasedOnly: true,
  });
  const candidates = jobs.filter((job) => Boolean(job.key));
  const snapshots = await readJobSnapshots(args.reader, candidates);
  // Status advances stay per-job CAS even though evidence is bulk-read.
  await mapPool(candidates, STORE_IO_CONCURRENCY, async (job) => {
    const indexed = snapshots.get(collectionKeyId(job.key!));
    if (!indexed) return;
    if (!isIndexedSnapshotReady(indexed)) return;
    const updated = await args.store.updateStatus(job.physicalJobId, "completed", {
      nowMs,
      expectedStatus: "queued",
      expectedAbsentLease: true,
    });
    if (!updated) {
      console.warn(
        "[kitchen] queued readiness complete CAS miss for %s (claimed between list and update)",
        job.physicalJobId,
      );
    }
  });
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
  const snapshots = await readJobSnapshots(args.reader, jobs);

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
    const indexed = snapshots.get(collectionKeyId(job.key));
    if (!indexed) continue;
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
      "[kitchen] claimed %d jobs but no drain strategy is configured — releasing leases",
      queued.length,
    );
    await releaseBatchLeases({ store: args.store, jobs: queued, nowMs });
  }
  // external_scale: ack optional shortcut. Also run when drain is misconfigured
  // so prior unleased queued jobs can still complete. Skip on healthy file/webhook
  // ticks to keep Hasura fan-out off the hot path.
  if (effectiveDrain === "external_scale" || effectiveDrain === null) {
    try {
      await advanceQueuedJobsViaReadiness({ store: args.store, reader: args.reader, nowMs });
    } catch (error) {
      console.warn(
        "[kitchen] advanceQueuedJobsViaReadiness failed — continuing tick (%s)",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  try {
    await advanceIndexingJobs({ store: args.store, reader: args.reader, nowMs });
  } catch (error) {
    console.warn(
      "[kitchen] advanceIndexingJobs failed — continuing tick (%s)",
      error instanceof Error ? error.message : String(error),
    );
  }
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
