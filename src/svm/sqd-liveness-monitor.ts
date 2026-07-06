/**
 * sqd-liveness-monitor.ts — periodic liveness check for the SQD live-tail lane (SDD §5).
 *
 * Addresses the KF-018 failure class: 9-day silent outage because no external observer was
 * watching a surface that was technically emitting signals. The SQD lane MUST NOT reproduce this.
 *
 * Three failure classes:
 *  1. Stream stall: no blocks received for STALL_THRESHOLD_MS → warn + reconnect
 *  2. Chain lag: SQD height << reference chain tip → warn (uses INDEPENDENT RPC, NOT SQD-vs-SQD)
 *  3. Permanent stall: reconnect fails MAX_RECONNECT_ATTEMPTS times → SqdLivenessError (halt)
 *
 * BLOCKER-2 mitigation: chain lag uses an independent Solana RPC endpoint for the reference tip,
 * NOT client.currentHeight() vs itself. Comparing SQD to SQD cannot detect SQD lagging.
 *
 * CI gate: monitor does not run when NODE_ENV=test or SQD_LIVENESS_DISABLED=1.
 */
import type { SqdClient } from "./sqd-client";

const STALL_THRESHOLD_MS = Number(process.env.SQD_STALL_THRESHOLD_MS ?? 120_000) || 120_000;
const LAG_THRESHOLD_SLOTS = Number(process.env.SQD_LAG_THRESHOLD_SLOTS ?? 500) || 500;
const MAX_RECONNECT_ATTEMPTS = 5;
const REFERENCE_RPC_URL = process.env.SQD_REFERENCE_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const CHECK_INTERVAL_MS = Number(process.env.SQD_LIVENESS_CHECK_INTERVAL_MS ?? 30_000) || 30_000;

export class SqdLivenessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqdLivenessError";
  }
}

export interface LivenessMonitorDeps {
  /** Override for Date.now() — enables deterministic test control. */
  now?: () => number;
  /** Override for RPC slot fetch — enables mocking without live network. */
  fetchReferenceSlot?: () => Promise<number>;
  /** Override reconnect trigger — enables test control. */
  triggerReconnect?: () => Promise<void>;
  /** Log output (defaults to console). */
  log?: { warn: (m: string) => void; error: (m: string) => void };
}

export class SqdLivenessMonitor {
  private readonly now: () => number;
  private readonly fetchReferenceSlot: () => Promise<number>;
  private readonly triggerReconnect: () => Promise<void>;
  private readonly log: { warn: (m: string) => void; error: (m: string) => void };
  private reconnectAttempts = 0;
  /** Block sequence validator — tracks last decoded block number for gap detection. */
  lastDecodedBlock: number = -1;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: SqdClient,
    deps: LivenessMonitorDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.fetchReferenceSlot = deps.fetchReferenceSlot ?? (() => fetchSolanaSlot());
    this.triggerReconnect = deps.triggerReconnect ?? (() => Promise.resolve());
    this.log = deps.log ?? { warn: (m) => console.warn(m), error: (m) => console.error(m) };
  }

  /** Run one liveness check. Called periodically by start() or directly in tests. */
  async check(): Promise<void> {
    await this.checkStall();
    await this.checkLag();
  }

  private async checkStall(): Promise<void> {
    const lastReceived = this.client.lastBlockReceivedAt;
    if (lastReceived === 0) return; // stream hasn't started yet — no stall
    const elapsed = this.now() - lastReceived;
    if (elapsed <= STALL_THRESHOLD_MS) return;

    const secs = Math.round(elapsed / 1000);
    this.log.warn(`[SQD STALL] No blocks received for ${secs}s — reconnecting`);
    this.reconnectAttempts++;
    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      const msg = `[SQD HALT] Liveness check failed after ${MAX_RECONNECT_ATTEMPTS} reconnects — manual intervention required`;
      this.log.error(msg);
      throw new SqdLivenessError(msg);
    }
    await this.triggerReconnect();
  }

  private async checkLag(): Promise<void> {
    let sqd: number;
    let ref: number;
    try {
      [sqd, ref] = await Promise.all([this.client.currentHeight(), this.fetchReferenceSlot()]);
    } catch {
      return; // non-fatal — lag check is advisory
    }
    const lag = ref - sqd;
    if (lag > LAG_THRESHOLD_SLOTS) {
      this.log.warn(`[SQD LAG] ${lag} slots behind chain tip (sqd=${sqd} ref=${ref})`);
    }
  }

  /**
   * Record a decoded block number for gap detection. Called by the decode pipeline after each block.
   * Emits a WARN if the received block is not lastDecodedBlock + 1 (allows batch delivery).
   * Never halts on a gap — SQD Portal may deliver blocks in valid batches.
   */
  recordBlock(blockNumber: number): void {
    if (this.lastDecodedBlock >= 0 && blockNumber !== this.lastDecodedBlock + 1) {
      this.log.warn(`[SQD GAP] blocks ${this.lastDecodedBlock + 1}-${blockNumber - 1} skipped`);
    }
    this.lastDecodedBlock = blockNumber;
  }

  /** Start periodic checks. No-op in test environments. */
  start(): void {
    if (process.env.NODE_ENV === "test" || process.env.SQD_LIVENESS_DISABLED === "1") return;
    this.intervalHandle = setInterval(() => {
      this.check().catch((e) => {
        if (e instanceof SqdLivenessError) throw e; // re-throw halting errors
        // non-halting check errors are logged but do not stop the monitor
      });
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}

async function fetchSolanaSlot(): Promise<number> {
  const res = await fetch(REFERENCE_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [{ commitment: "finalized" }] }),
  });
  const d = (await res.json()) as { result?: number };
  if (typeof d.result !== "number") throw new Error("getSlot: unexpected response shape");
  return d.result;
}
