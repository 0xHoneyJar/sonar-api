// ponder-runtime/src/lib/nats-publisher.ts
//
// Per SDD §4.2 + AC-A-7 byte-parity invariant.
//
// THIN WRAPPER around @0xhoneyjar/events. Envelope byte-parity with envio's
// NATS output is preserved BY CONSTRUCTION:
//
//   - SAME library (`@0xhoneyjar/events` pinned via cluster.eventsPin.sha)
//   - SAME ed25519 signing key (`SONAR_SIGNING_SEED_HEX`)
//   - SAME signer key-id (`sonar-api-1`)
//   - SAME emitted_by cell slug (`sonar-api`)
//   - SAME prev-hash chain (single-instance InMemoryPrevHashStore)
//   - SAME topic builders (`nftMintDetectedTopic`)
//
// The ONE thing this module owns: the **payload** field. AC-A-7 byte-parity
// is met iff handlers construct payloads byte-identical to envio's.
//
// This module mirrors the envio src/lib/events-publisher.ts shape carefully.
// Drift between the two = AC-A-7 violation. See ponder-runtime/tests/byte-parity.test.ts.

import {
  InMemoryPrevHashStore,
  LocalEd25519Signer,
  publishEnvelope as publishEnvelopeLib,
  nftMintDetectedTopic,
} from "@0xhoneyjar/events";
import type { Signer, PrevHashStore } from "@0xhoneyjar/events";
import { connect, type NatsConnection } from "nats";

// --- public types -----------------------------------------------------------

/**
 * Payload shape — frozen at migration time per AC-A-7. MUST stay byte-identical
 * to envio's MintEventPayload in src/lib/events-publisher.ts. JSON-canonical
 * key order is enforced by JCS in the @0xhoneyjar/events library — TypeScript
 * field order in the literal doesn't affect output.
 */
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

export type CollectionSlug =
  | "mibera-shadow"
  | "mibera-collection"
  | "mibera-sets"
  | "mibera-zora"
  | "mibera-liquid-backing"
  | "mibera-staking"
  | "purupuru-apiculture";

/**
 * Ponder-side envelope tagged with discriminant + topic + payload.
 */
export interface PonderEnvelope {
  /** Envelope-type discriminant (cookbook §R-1). */
  type: string;
  subject: string;
  payload: MintEventPayload;
}

// --- topic builders --------------------------------------------------------

export function buildMintEnvelope(
  collectionSlug: CollectionSlug,
  payload: MintEventPayload,
): PonderEnvelope {
  return {
    type: "mint",
    subject: nftMintDetectedTopic({ collectionSlug }),
    payload,
  };
}

// --- module-singleton state ------------------------------------------------

const EMITTED_BY = "sonar-api";
const SIGNER_KEY_ID = "sonar-api-1";

let initialized = false;
let disabledReason: string | null = null;
let disabledKind: "permanent" | "transient" | null = null;
let lastTransientFailAtMs = 0;
let nats: NatsConnection | null = null;
let signer: Signer | null = null;
let prevHashStore: PrevHashStore = new InMemoryPrevHashStore();

const TRANSIENT_BACKOFF_MS = 5_000;

interface Log {
  warn(...args: unknown[]): void;
  info?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

const defaultLog: Log = {
  warn: (...a) => console.warn("[ponder-nats-publisher]", ...a),
  info: (...a) => console.log("[ponder-nats-publisher]", ...a),
  error: (...a) => console.error("[ponder-nats-publisher]", ...a),
};

function validateTlsPosture(natsUrl: string, natsTlsCa: string | undefined): string | null {
  let parsed: URL;
  try {
    parsed = new URL(natsUrl);
  } catch {
    return `NATS_URL "${natsUrl}" is not a valid URL`;
  }
  const scheme = parsed.protocol.replace(":", "");
  if (scheme === "tls" || scheme === "nats+tls") return null;
  if (scheme === "nats") {
    if (!natsTlsCa) {
      return `NATS_URL "${natsUrl}" uses plaintext "nats://" scheme without NATS_TLS_CA — refusing (TLS-only)`;
    }
    return null;
  }
  return `NATS_URL "${natsUrl}" uses unsupported scheme "${scheme}://"`;
}

function markPermanentDisabled(reason: string, log: Log): false {
  initialized = true;
  disabledReason = reason;
  disabledKind = "permanent";
  log.warn(`permanently disabled: ${reason}`);
  return false;
}

function markTransientFailure(reason: string, log: Log): false {
  initialized = false;
  disabledReason = reason;
  disabledKind = "transient";
  lastTransientFailAtMs = Date.now();
  signer = null;
  nats = null;
  log.warn(`transient failure (will retry after ${TRANSIENT_BACKOFF_MS}ms): ${reason}`);
  return false;
}

async function initSubstrate(log: Log): Promise<boolean> {
  if (initialized) return disabledReason === null;

  if (disabledKind === "transient" && Date.now() - lastTransientFailAtMs < TRANSIENT_BACKOFF_MS) {
    return false;
  }

  const natsUrl = process.env.NATS_URL;
  const seedHex = process.env.SONAR_SIGNING_SEED_HEX;
  const ca = process.env.NATS_TLS_CA?.trim() || undefined;
  const clientCert = process.env.NATS_TLS_CLIENT_CERT?.trim() || undefined;
  const clientKey = process.env.NATS_TLS_CLIENT_KEY?.trim() || undefined;

  if (!natsUrl) return markPermanentDisabled("NATS_URL not set", log);
  if (!seedHex) return markPermanentDisabled("SONAR_SIGNING_SEED_HEX not set", log);

  if (Boolean(clientCert) !== Boolean(clientKey)) {
    return markPermanentDisabled(
      "NATS_TLS_CLIENT_CERT and NATS_TLS_CLIENT_KEY must both be set or both unset",
      log,
    );
  }

  const tlsReason = validateTlsPosture(natsUrl, ca);
  if (tlsReason) return markPermanentDisabled(tlsReason, log);

  try {
    signer = await LocalEd25519Signer.fromSeedHex(seedHex, SIGNER_KEY_ID);
  } catch (err) {
    return markPermanentDisabled(`signer init failed: ${(err as Error).message}`, log);
  }

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
    nats = await connect({ servers: natsUrl, ...tlsOptions });
    log.info?.(`connected to ${natsUrl}`);
  } catch (err) {
    nats = null;
    return markTransientFailure(`NATS connect failed: ${(err as Error).message}`, log);
  }

  initialized = true;
  disabledReason = null;
  disabledKind = null;
  return true;
}

/**
 * Publish an envelope on NATS. THROWS on connection-class errors so the
 * outbox-flush handler can bump attemptCount. L2 inline-publish callers
 * (reorgSafeEmit depth=0 branch) wrap this in try/catch and swallow.
 */
export async function publishEnvelope(envelope: PonderEnvelope, log: Log = defaultLog): Promise<void> {
  const ready = await initSubstrate(log);
  if (!ready || !nats || !signer) {
    log.warn(
      `DROPPED publish (substrate ${disabledKind ?? "uninitialized"} — ${disabledReason ?? "unknown"}): ` +
        `subject=${envelope.subject} type=${envelope.type} ` +
        `chain=${envelope.payload.chain_id} contract=${envelope.payload.contract} ` +
        `token_id=${envelope.payload.token_id} tx=${envelope.payload.transaction_hash}`,
    );
    return;
  }

  try {
    await publishEnvelopeLib({
      nats,
      subject: envelope.subject,
      payload: envelope.payload,
      emittedBy: EMITTED_BY,
      signer,
      prevHashStore,
    });
  } catch (err) {
    log.warn(
      `publish failed (DB write succeeded): subject=${envelope.subject} err=${(err as Error).message}`,
    );
    if (isConnectionClosedError(err)) {
      log.warn(`NATS connection appears closed — resetting substrate for retry`);
      nats = null;
      initialized = false;
      disabledKind = "transient";
      disabledReason = `closed-connection: ${(err as Error).message}`;
      lastTransientFailAtMs = Date.now();
    }
    throw err;
  }
}

function isConnectionClosedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
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
  return (
    msg.includes("CONNECTION_CLOSED") ||
    msg.includes("STALE_CONNECTION") ||
    msg.includes("closed") ||
    msg.includes("stale")
  );
}

export function __setTestSubstrate(opts: {
  nats: NatsConnection;
  signer: Signer;
  prevHashStore?: PrevHashStore;
}): void {
  nats = opts.nats;
  signer = opts.signer;
  if (opts.prevHashStore) prevHashStore = opts.prevHashStore;
  initialized = true;
  disabledReason = null;
  disabledKind = null;
}

export function __resetForTests(): void {
  initialized = false;
  disabledReason = null;
  disabledKind = null;
  lastTransientFailAtMs = 0;
  nats = null;
  signer = null;
  prevHashStore = new InMemoryPrevHashStore();
}
