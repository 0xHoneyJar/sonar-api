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
 * Failure-kind discipline (BB#24 F-001 closed):
 *   - **Permanent (config-disabled)**: env vars missing, scheme rejected,
 *     CA unreadable, signer init failed. These cache `initialized=true` and
 *     never retry — operator must fix config + restart sonar.
 *   - **Transient (connection-failed)**: NATS broker unreachable, TLS
 *     handshake failed, socket dropped. These keep `initialized=false` so
 *     the NEXT publish call retries — with a small backoff window so a
 *     burst of mint events doesn't hammer the broker during outage.
 *
 * TLS enforcement (BB#24 F-002 / F-003 closed):
 *   - NATS_URL MUST have a TLS scheme (`tls://` or `nats+tls://` — also
 *     accepts the cluster's `nats://` form when NATS_TLS_CA is provided
 *     because the underlying nats.js client upgrades that to TLS when a
 *     `tls` option is passed). Plaintext-only schemes without CA → refuse.
 *   - NATS_TLS_CA, when set, MUST be readable. Unreadable CA → refuse
 *     (config-disabled). The old warn-and-continue path is closed.
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
 * Lazy-init state. The first publish either constructs the substrate or
 * sets `disabledReason` and skips. After that, subsequent publishes are
 * either a cheap publish call or a no-op return.
 *
 * `disabledKind` distinguishes permanent failures (cache + never retry) from
 * transient failures (allow retry on the next publish, with backoff). See
 * BB#24 F-001 for the bug class this closes.
 */
let initialized = false;
let disabledReason: string | null = null;
let disabledKind: "permanent" | "transient" | null = null;
let lastTransientFailAtMs = 0;
let nats: NatsConnection | null = null;
let signer: Signer | null = null;
// `let` (not `const`) so __resetForTests can swap the instance for test
// isolation (BB#24 F-005) and __setTestSubstrate can honor an injected
// store (BB#24 F-006). Previous shape captured the store as `const` and
// the test hooks couldn't replace it.
let prevHashStore: PrevHashStore = new InMemoryPrevHashStore();

/** Cell identity — populates `emitted_by` on every envelope. */
const EMITTED_BY = "sonar-api";

/**
 * Backoff window for transient NATS connect failures. A burst of mint
 * events arrives in tight bunches (e.g. when Envio catches up on a chain
 * range); without backoff, every event would attempt a fresh connect and
 * hammer the broker during outage. 5s is conservative and operator-friendly.
 */
const TRANSIENT_BACKOFF_MS = 5_000;

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

// --- TLS scheme validation (BB#24 F-002) ------------------------------------

/**
 * Returns the failure reason if NATS_URL is insecure, else null.
 *
 * Accepts:
 *   - `tls://...` or `nats+tls://...` — explicit TLS scheme
 *   - `nats://...` ONLY when NATS_TLS_CA is provided (nats.js upgrades to TLS)
 *
 * Rejects:
 *   - `nats://...` without NATS_TLS_CA — plaintext
 *   - Missing scheme — ambiguous; refuse rather than guess
 *   - Any other scheme — refuse
 */
function validateTlsPosture(natsUrl: string, natsTlsCa: string | undefined): string | null {
  let parsed: URL;
  try {
    parsed = new URL(natsUrl);
  } catch {
    return `NATS_URL "${natsUrl}" is not a valid URL`;
  }
  const scheme = parsed.protocol.replace(":", "");
  if (scheme === "tls" || scheme === "nats+tls") {
    // Explicit TLS scheme — fine even without a custom CA (nats.js uses
    // system roots). But if NATS_TLS_CA is set we still want it readable
    // (F-003 — checked separately).
    return null;
  }
  if (scheme === "nats") {
    if (!natsTlsCa) {
      return `NATS_URL "${natsUrl}" uses plaintext "nats://" scheme without NATS_TLS_CA — refusing to connect (TLS-only per Sprint-1 design rule)`;
    }
    // nats://+CA → nats.js upgrades to TLS via the tls config option.
    return null;
  }
  return `NATS_URL "${natsUrl}" uses unsupported scheme "${scheme}://" — expected tls://, nats+tls://, or nats:// with NATS_TLS_CA`;
}

// --- substrate init ---------------------------------------------------------

/**
 * Mark the substrate disabled (permanent). Cached for the process lifetime;
 * operator must fix config + restart.
 */
function markPermanentDisabled(reason: string, log: HandlerLogger): false {
  initialized = true;
  disabledReason = reason;
  disabledKind = "permanent";
  log.warn(`[events-publisher] permanently disabled: ${reason}`);
  return false;
}

/**
 * Mark a transient failure. Does NOT cache initialized=true so the next
 * publish will retry (subject to the backoff window). BB#24 F-001 close.
 */
function markTransientFailure(reason: string, log: HandlerLogger): false {
  initialized = false;
  disabledReason = reason;
  disabledKind = "transient";
  lastTransientFailAtMs = Date.now();
  signer = null;
  nats = null;
  log.warn(`[events-publisher] transient failure (will retry after ${TRANSIENT_BACKOFF_MS}ms): ${reason}`);
  return false;
}

async function initSubstrate(log: HandlerLogger): Promise<boolean> {
  if (initialized) return disabledReason === null;

  // Transient backoff: if we just had a transient failure, skip this attempt.
  // The flag `initialized=false` means a future call after the backoff window
  // will go through full init again.
  if (disabledKind === "transient" && Date.now() - lastTransientFailAtMs < TRANSIENT_BACKOFF_MS) {
    return false;
  }

  const natsUrl = process.env.NATS_URL;
  const seedHex = process.env.SONAR_SIGNING_SEED_HEX;
  const natsTlsCa = process.env.NATS_TLS_CA;

  // --- PERMANENT-DISABLED checks (cache + never retry) ----------------------

  if (!natsUrl) return markPermanentDisabled("NATS_URL not set", log);
  if (!seedHex) return markPermanentDisabled("SONAR_SIGNING_SEED_HEX not set", log);

  const tlsReason = validateTlsPosture(natsUrl, natsTlsCa);
  if (tlsReason) return markPermanentDisabled(tlsReason, log);

  // BB#24 F-003: when NATS_TLS_CA is set but unreadable → refuse. The old
  // warn-and-continue-with-undefined-CA path is closed; that path could
  // silently weaken certificate verification.
  let ca: string | undefined;
  if (natsTlsCa) {
    try {
      ca = readFileSync(natsTlsCa, "utf8");
    } catch (err) {
      return markPermanentDisabled(
        `NATS_TLS_CA at "${natsTlsCa}" is unreadable: ${(err as Error).message}`,
        log,
      );
    }
  }

  try {
    signer = await LocalEd25519Signer.fromSeedHex(seedHex, "sonar-api-1");
  } catch (err) {
    return markPermanentDisabled(`signer init failed: ${(err as Error).message}`, log);
  }

  // --- TRANSIENT path: NATS connect can fail temporarily --------------------

  try {
    nats = await connect({
      servers: natsUrl,
      ...(ca ? { tls: { ca } } : {}),
    });
    log.info?.(`[events-publisher] connected to ${natsUrl} (TLS=${ca ? "with-custom-CA" : "via-scheme"})`);
  } catch (err) {
    nats = null;
    return markTransientFailure(`NATS connect failed: ${(err as Error).message}`, log);
  }

  initialized = true;
  disabledReason = null;
  disabledKind = null;
  return true;
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
 * Test-only: inject a mock NATS connection + signer + optional prevHashStore.
 * Allows golden-replay tests to assert publish behavior without spinning up
 * a real JetStream. Resets `initialized` to true so the next call uses the
 * injected state (skipping init).
 *
 * BB#24 F-006: opts.prevHashStore is now actually honored (previously the
 * module-level store was `const` and the comment apologized for ignoring
 * the parameter). Made `let` in the F-005 fix to enable this.
 */
export function __setTestSubstrate(opts: {
  nats: { publish: (subject: string, data: Uint8Array, opts?: { headers?: unknown }) => void | Promise<unknown> };
  signer: Signer;
  prevHashStore?: PrevHashStore;
}): void {
  nats = opts.nats as unknown as NatsConnection;
  signer = opts.signer;
  if (opts.prevHashStore) {
    prevHashStore = opts.prevHashStore;
  }
  initialized = true;
  disabledReason = null;
  disabledKind = null;
}

/**
 * Test-only: reset module state so the next call re-initializes. Replaces
 * the module-level prevHashStore with a fresh InMemoryPrevHashStore so
 * tests start with a clean genesis chain (BB#24 F-005).
 */
export function __resetForTests(): void {
  initialized = false;
  disabledReason = null;
  disabledKind = null;
  lastTransientFailAtMs = 0;
  nats = null;
  signer = null;
  prevHashStore = new InMemoryPrevHashStore();
}
