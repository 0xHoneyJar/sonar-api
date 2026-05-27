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
 *      design invariant; the CA bundle is read from NATS_TLS_CA as the
 *      PEM **body** — see the Path-ε convention note below).
 *   3. Catches every publish error and routes it to `ctx.log.warn` —
 *      handlers MUST NOT crash an Envio write because the events pillar
 *      is degraded. The Envio entity write happens FIRST in the handler;
 *      publish is best-effort tail-call.
 *
 * Failure-kind discipline (BB#24 F-001 closed):
 *   - **Permanent (config-disabled)**: env vars missing, scheme rejected,
 *     signer init failed. These cache `initialized=true` and never retry —
 *     operator must fix config + restart sonar.
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
 *
 * Path-ε convention — NATS_TLS_CA / NATS_TLS_CLIENT_CERT / NATS_TLS_CLIENT_KEY
 * all hold PEM **bodies**, not file paths:
 *   - Railway service-variable injection wires PEM content directly into
 *     env vars; no filesystem touch required. Aligned with the dash
 *     subscriber (loa-freeside PR #242) + characters subscriber so all
 *     three cluster consumers share one TLS-config convention.
 *   - Breaking change vs the pre-Path-ε shape: any deployment that set
 *     NATS_TLS_CA to a filesystem path must switch to PEM content
 *     (e.g. `NATS_TLS_CA=$(cat /path/to/ca.pem)`). Documented in the
 *     Path-ε runbook §Step 3.
 *   - .trim() on env reads guards against trailing-newline noise from
 *     copy-paste and Railway service-variable CRLF normalization.
 *   - NATS_TLS_CLIENT_CERT + NATS_TLS_CLIENT_KEY are OPTIONAL. When both
 *     are set, the nats.js `tls` options object includes `cert` + `key`
 *     alongside any CA, enabling mTLS auth against the Path-ε broker
 *     (`--tlsverify` on nats-server requires + verifies a client cert
 *     signed by the cluster CA).
 *   - Partial config (one client-cert env set, the other missing) →
 *     refuse permanently. Proceeding with only one half would either
 *     fail the TLS handshake (cert without key) or silently fall back to
 *     anonymous TLS (key without cert), masking a deployment misconfig.
 *   - Backward-compatible at the connect-shape level: when neither
 *     client-cert env is set, behavior is CA-only TLS / anonymous client.
 *
 *   Reference: ~/Documents/GitHub/loa-freeside/grimoires/loa/specs/
 *     cluster-events-pillar-v1/go-live-path-epsilon-railway-nats.md §Step 3
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
    // system roots).
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
  //
  // BB#24 rd-2 F-001: the caller (publishMintEvent) emits an audit-trail
  // log line when this path returns false so transient backoff doesn't
  // silently drop accepted events. See `publishMintEvent` below for the
  // loss-accounting log.
  if (disabledKind === "transient" && Date.now() - lastTransientFailAtMs < TRANSIENT_BACKOFF_MS) {
    return false;
  }

  const natsUrl = process.env.NATS_URL;
  const seedHex = process.env.SONAR_SIGNING_SEED_HEX;
  // Path-ε convention — NATS_TLS_CA / CLIENT_CERT / CLIENT_KEY all hold PEM
  // **bodies**, not file paths. .trim() guards against trailing-newline
  // noise from copy-paste env values and Railway service-variable round-trips
  // that occasionally normalize CRLF.
  const ca = process.env.NATS_TLS_CA?.trim() || undefined;
  const clientCert = process.env.NATS_TLS_CLIENT_CERT?.trim() || undefined;
  const clientKey = process.env.NATS_TLS_CLIENT_KEY?.trim() || undefined;

  // --- PERMANENT-DISABLED checks (cache + never retry) ----------------------

  if (!natsUrl) return markPermanentDisabled("NATS_URL not set", log);
  if (!seedHex) return markPermanentDisabled("SONAR_SIGNING_SEED_HEX not set", log);

  // Path-ε partial-config refuse: one set without the other is a deployment
  // misconfiguration. Proceeding either way (cert-without-key, key-without-cert)
  // masks the error — fail-closed at config-load is the audit-friendly path.
  if (Boolean(clientCert) !== Boolean(clientKey)) {
    return markPermanentDisabled(
      "NATS_TLS_CLIENT_CERT and NATS_TLS_CLIENT_KEY must both be set or both unset (Path-ε mTLS)",
      log,
    );
  }

  const tlsReason = validateTlsPosture(natsUrl, ca);
  if (tlsReason) return markPermanentDisabled(tlsReason, log);

  try {
    signer = await LocalEd25519Signer.fromSeedHex(seedHex, "sonar-api-1");
  } catch (err) {
    return markPermanentDisabled(`signer init failed: ${(err as Error).message}`, log);
  }

  // --- TRANSIENT path: NATS connect can fail temporarily --------------------

  // TLS options assembly: CA-only (system-CA + custom-CA), CA+client-cert
  // (Path-ε mTLS), or client-cert-only (system-CA verification + client
  // auth). The ternary chain keeps the no-TLS-options branch unchanged when
  // neither CA nor client cert is configured (preserves Sprint-1 default
  // behavior — relies on nats.js scheme-based TLS inference).
  const tlsOptions =
    ca || clientCert
      ? {
          tls: {
            ...(ca ? { ca } : {}),
            ...(clientCert ? { cert: clientCert, key: clientKey } : {}),
          },
        }
      : {};

  try {
    nats = await connect({
      servers: natsUrl,
      ...tlsOptions,
    });
    const tlsMode = clientCert
      ? ca
        ? "mTLS-with-custom-CA"
        : "mTLS-via-system-CA"
      : ca
        ? "with-custom-CA"
        : "via-scheme";
    log.info?.(`[events-publisher] connected to ${natsUrl} (TLS=${tlsMode})`);
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

  // BB#24 rd-2 F-001: when the substrate is disabled (permanent or
  // transient-backoff), the publish call would silently drop the event.
  // Emit an audit-trail log line per dropped event so operators can
  // replay from indexer entity state if needed. Event identity (chain,
  // contract, token_id, tx_hash) is sufficient for replay: sonar's
  // Envio Postgres has the durable record; the events pillar can be
  // re-published from there during recovery.
  if (!ready || !nats || !signer) {
    args.log.warn(
      `[events-publisher] DROPPED publish (substrate ${disabledKind ?? "uninitialized"} — ${disabledReason ?? "unknown"}): ` +
        `chain=${args.payload.chain_id} contract=${args.payload.contract} token_id=${args.payload.token_id} ` +
        `tx=${args.payload.transaction_hash} collection=${args.collectionSlug}`,
    );
    return;
  }

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
    // BB#24 rd-3 F-001 HIGH: if the publish failed because the NATS connection
    // closed (broker restart, network drop, etc.), the singleton `nats` is
    // now broken and every future publish will keep hitting it. Detect
    // closed-connection errors + reset the substrate state so the next
    // publish triggers a fresh lazy init (subject to the transient backoff
    // window). nats.js errors carry an `code` field for these classes
    // (ConnectionClosed / StaleConnection / Disconnect) — match by code and
    // by message fallback for older runtime versions.
    if (isConnectionClosedError(err)) {
      args.log.warn(
        `[events-publisher] NATS connection appears closed — resetting substrate for retry on next publish`,
      );
      nats = null;
      initialized = false;
      disabledKind = "transient";
      disabledReason = `NATS publish failed with closed-connection error: ${(err as Error).message}`;
      lastTransientFailAtMs = Date.now();
    }
  }
}

/**
 * Classifies a publish error as connection-closed (transient + needs reset)
 * vs other (transient at the broker level but the connection is still
 * usable). Matches nats.js v2 NatsError shape: `code` field + known
 * close-class codes; falls back to message-substring matching for older
 * runtime versions where the code may not be set.
 *
 * Conservative: when in doubt, returns false (don't reset on every error;
 * only on errors that suggest the connection itself is broken).
 */
function isConnectionClosedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    // nats.js NATS_ERROR_CODES — the close-class codes.
    if (
      code === "CONNECTION_CLOSED" ||
      code === "STALE_CONNECTION" ||
      code === "DISCONNECT" ||
      code === "CONNECTION_TIMEOUT" ||
      code === "CONNECTION_REFUSED"
    ) {
      return true;
    }
  }
  const msg = err instanceof Error ? err.message : "";
  // Conservative substring fallback — nats.js error messages contain these
  // tokens when the code field isn't populated by the runtime.
  return (
    msg.includes("CONNECTION_CLOSED") ||
    msg.includes("STALE_CONNECTION") ||
    msg.includes("closed") ||
    msg.includes("stale")
  );
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
