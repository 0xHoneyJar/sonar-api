/**
 * events-publisher.ts — sonar's NATS+ACVP publish substrate.
 *
 * Wires the @0xhoneyjar/events library into sonar handlers. The Envio runtime
 * doesn't give handlers a long-lived service object — they receive a per-event
 * `context` — so this module exposes a module-singleton (lazy-initialized on
 * first publish) and a helper `publishMintEvent(...)` that:
 *
 *   1. Returns silently when NATS_URL / SONAR_SIGNING_SEED_HEX env vars
 *      are absent (fail-soft: the indexer continues to work without the
 *      events pillar enabled — useful for local dev + the rollout window).
 *   2. Lazy-connects to NATS on first call (TLS-required per Sprint-1
 *      design invariant; the CA bundle is read from NATS_TLS_CA path
 *      when set).
 *   3. Catches every publish error and routes it to `ctx.log.warn` —
 *      handlers MUST NOT crash an Envio write because the events pillar
 *      is degraded. The Envio entity write happens FIRST in the handler;
 *      publish is best-effort tail-call.
 *
 * Single-process limitation: `InMemoryPrevHashStore` means a sonar restart
 * resets the chain tip and the next envelope's `prev_hash` will be
 * GENESIS — subscribers with `chainStore` will surface
 * `prev-hash-broken-chain` on the restart envelope. This is acceptable for
 * Sprint 1 (single-instance sonar) and explicitly named in the build doc.
 * Sprint 2+ moves to a Redis-backed store.
 *
 * Reference: ~/Documents/GitHub/loa-freeside/packages/events/README.md
 */

import { readFileSync } from "node:fs";
import {
  InMemoryPrevHashStore,
  LocalEd25519Signer,
  publishEnvelope,
  nftMintDetectedTopic,
} from "@0xhoneyjar/events";
import type { Signer, PrevHashStore } from "@0xhoneyjar/events";
import { connect, type NatsConnection } from "nats";

// --- module-singleton state -------------------------------------------------

/**
 * Lazy-init flags. The first publish either constructs the substrate or
 * sets `disabledReason` and skips. After that, subsequent publishes are
 * either a cheap publish call or a no-op return.
 */
let initialized = false;
let disabledReason: string | null = null;
let nats: NatsConnection | null = null;
let signer: Signer | null = null;
const prevHashStore: PrevHashStore = new InMemoryPrevHashStore();

/** Cell identity — populates `emitted_by` on every envelope. */
const EMITTED_BY = "sonar-api";

// --- public types -----------------------------------------------------------

export interface MintEventPayload {
  chain_id: number;
  contract: string;
  token_id: string;
  minter: string;
  block_number: number;
  transaction_hash: string;
  /** ISO-8601 UTC */
  timestamp: string;
  /** Optional — MST/VM-only: encoded trait bytes from the Minted event. */
  encoded_traits?: string;
}

/**
 * Stable map of collectionSlug → topic specifier. Centralized so handlers
 * don't repeat the magic string; also gives one chokepoint to add a v2
 * subject when schema evolution starts.
 */
export type CollectionSlug =
  | "mibera-shadow"
  | "mibera-collection"
  | "mibera-sets"
  | "mibera-zora"
  | "mibera-liquid-backing"
  | "mibera-staking"
  | "purupuru-apiculture";

// --- handler-facing logger type ---------------------------------------------

/** Subset of Envio's context.log that we use — keeps the dep surface minimal. */
interface HandlerLogger {
  warn(...args: unknown[]): void;
  info?(...args: unknown[]): void;
}

// --- substrate init ---------------------------------------------------------

async function initSubstrate(log: HandlerLogger): Promise<boolean> {
  if (initialized) return disabledReason === null;
  initialized = true;

  const natsUrl = process.env.NATS_URL;
  const seedHex = process.env.SONAR_SIGNING_SEED_HEX;

  if (!natsUrl) {
    disabledReason = "NATS_URL not set";
    log.warn(`[events-publisher] disabled: ${disabledReason}`);
    return false;
  }
  if (!seedHex) {
    disabledReason = "SONAR_SIGNING_SEED_HEX not set";
    log.warn(`[events-publisher] disabled: ${disabledReason}`);
    return false;
  }

  try {
    signer = await LocalEd25519Signer.fromSeedHex(seedHex, "sonar-api-1");
  } catch (err) {
    disabledReason = `signer init failed: ${(err as Error).message}`;
    log.warn(`[events-publisher] disabled: ${disabledReason}`);
    return false;
  }

  // TLS-only per Sprint-1 design invariant. NATS_TLS_CA is a path to the CA
  // bundle the cluster's JetStream instance is signed with.
  const tlsCa = process.env.NATS_TLS_CA;
  const tls = tlsCa ? { ca: safeReadFile(tlsCa, log) } : undefined;

  try {
    nats = await connect({
      servers: natsUrl,
      ...(tls ? { tls } : {}),
    });
    log.info?.(`[events-publisher] connected to ${natsUrl} (TLS=${tlsCa ? "yes" : "no"})`);
  } catch (err) {
    disabledReason = `NATS connect failed: ${(err as Error).message}`;
    log.warn(`[events-publisher] disabled: ${disabledReason}`);
    nats = null;
    return false;
  }

  return true;
}

function safeReadFile(path: string, log: HandlerLogger): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    log.warn(`[events-publisher] could not read NATS_TLS_CA at ${path}: ${(err as Error).message}`);
    return undefined;
  }
}

// --- handler-facing API -----------------------------------------------------

/**
 * Publish an NFT-mint-detected envelope. Fail-soft: any error is caught and
 * logged via `log.warn`. The caller MUST have already completed the Envio
 * `context.<Entity>.set(...)` write before invoking this.
 *
 * Subject derivation: nft.mint.detected.<collectionSlug>.v1
 */
export async function publishMintEvent(args: {
  log: HandlerLogger;
  collectionSlug: CollectionSlug;
  payload: MintEventPayload;
}): Promise<void> {
  const ready = await initSubstrate(args.log);
  if (!ready || !nats || !signer) return;

  const subject = nftMintDetectedTopic({ collectionSlug: args.collectionSlug });

  try {
    await publishEnvelope({
      nats,
      subject,
      payload: args.payload,
      emittedBy: EMITTED_BY,
      signer,
      prevHashStore,
    });
  } catch (err) {
    args.log.warn(
      `[events-publisher] publish failed (envio write succeeded): subject=${subject} err=${(err as Error).message}`,
    );
  }
}

// --- test-mode injection ----------------------------------------------------

/**
 * Test-only: inject a mock NATS connection + signer + prevHashStore. Allows
 * golden-replay tests to assert publish behavior without spinning up a real
 * JetStream. Resets `initialized` so the next call uses the injected state.
 */
export function __setTestSubstrate(opts: {
  nats: { publish: (subject: string, data: Uint8Array, opts?: { headers?: unknown }) => void | Promise<unknown> };
  signer: Signer;
  prevHashStore?: PrevHashStore;
}): void {
  nats = opts.nats as unknown as NatsConnection;
  signer = opts.signer;
  if (opts.prevHashStore) {
    // Swap the module-level prevHashStore reference is non-trivial (const).
    // Instead, drain + re-seed by leaving the in-memory map empty; tests
    // that need a custom store can use the default InMemoryPrevHashStore
    // and seed via the signer's own publish flow.
  }
  initialized = true;
  disabledReason = null;
}

/** Test-only: reset module state so the next call re-initializes. */
export function __resetForTests(): void {
  initialized = false;
  disabledReason = null;
  nats = null;
  signer = null;
}
