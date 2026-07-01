import { readFileSync, writeFileSync } from "node:fs";

import { patchConfigForKitchenIngest } from "./config-patcher.js";
import type { IngestJobStorePort } from "./ingest-store.js";
import type { CollectionStatusReader } from "./status.js";
import type { IngestJobRecord } from "./types.js";

export function beltConfigPathFromEnv(): string {
  return process.env.KITCHEN_BELT_CONFIG_PATH?.trim() || "config.yaml";
}

export function kitchenWorkerEnabled(): boolean {
  const raw = process.env.KITCHEN_WORKER_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function kitchenWorkerIntervalMs(): number {
  const parsed = Number(process.env.KITCHEN_WORKER_INTERVAL_MS ?? 30_000);
  return Number.isFinite(parsed) && parsed >= 5_000 ? parsed : 30_000;
}

export function kitchenIngestTimeoutMs(): number {
  const parsed = Number(process.env.KITCHEN_INGEST_TIMEOUT_MS ?? 86_400_000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 86_400_000;
}

export function applyBeltConfigPatch(args: {
  configPath: string;
  job: IngestJobRecord;
  readFile?: (path: string) => string;
  writeFile?: (path: string, contents: string) => void;
}): { changed: boolean } {
  const readFile = args.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const writeFile = args.writeFile ?? ((path: string, contents: string) => {
    writeFileSync(path, contents, "utf8");
  });

  const current = readFile(args.configPath);
  const label =
    args.job.communityName?.trim() ||
    `kitchen_order_${args.job.orderId.slice(0, 8)}`;
  const { changed, configYaml } = patchConfigForKitchenIngest({
    configYaml: current,
    key: args.job.key,
    label,
  });
  if (changed) {
    writeFile(args.configPath, configYaml);
  }
  return { changed };
}

async function notifyIndexerRestart(): Promise<void> {
  const webhook = process.env.KITCHEN_INDEXER_RESTART_WEBHOOK?.trim();
  if (!webhook) return;
  const response = await fetch(webhook, { method: "POST" });
  if (!response.ok) {
    throw new Error(`indexer restart webhook HTTP ${response.status}`);
  }
}

export async function processQueuedIngestJob(args: {
  job: IngestJobRecord;
  store: IngestJobStorePort;
  configPath?: string;
  readFile?: (path: string) => string;
  writeFile?: (path: string, contents: string) => void;
}): Promise<void> {
  const configPath = args.configPath ?? beltConfigPathFromEnv();
  try {
    applyBeltConfigPatch({
      configPath,
      job: args.job,
      readFile: args.readFile,
      writeFile: args.writeFile,
    });
    await notifyIndexerRestart();
    await args.store.updateStatus(args.job.key, "indexing");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await args.store.updateStatus(args.job.key, "failed", { errorMessage: message });
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
    const indexed = await args.reader.readIndexedSnapshot(job.key);
    if (indexed.holderCount > 0) {
      await args.store.updateStatus(job.key, "completed", { nowMs });
      continue;
    }
    if (nowMs - job.updatedAtMs > timeoutMs) {
      await args.store.updateStatus(job.key, "failed", {
        nowMs,
        errorMessage: `indexing timeout after ${timeoutMs}ms (holder_count still 0)`,
      });
    }
  }
}

export async function runKitchenIngestWorkerTick(args: {
  store: IngestJobStorePort;
  reader: CollectionStatusReader;
  configPath?: string;
  readFile?: (path: string) => string;
  writeFile?: (path: string, contents: string) => void;
}): Promise<void> {
  const queued = await args.store.listByStatus("queued", 10);
  for (const job of queued) {
    await processQueuedIngestJob({
      job,
      store: args.store,
      configPath: args.configPath,
      readFile: args.readFile,
      writeFile: args.writeFile,
    });
  }
  await advanceIndexingJobs({ store: args.store, reader: args.reader });
}

export function startKitchenIngestWorker(args: {
  store: IngestJobStorePort;
  reader: CollectionStatusReader;
}): () => void {
  const intervalMs = kitchenWorkerIntervalMs();
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runKitchenIngestWorkerTick(args);
    } catch (error) {
      console.error("[kitchen-worker] tick failed:", error);
    } finally {
      running = false;
    }
  };

  void tick();
  const handle = setInterval(() => {
    void tick();
  }, intervalMs);

  return () => clearInterval(handle);
}
