/**
 * emit.ts — the canonical NATS emission layer (SDD §2/§4, S4).
 *
 * Emits `NftActivity` under a DISTINCT publisher identity (F1 BLOCKER fix):
 *   emitted_by = "sonar-canonical", signing_key_id = "sonar-canonical-1"
 *   → publisherKey "sonar-canonical:sonar-canonical-1", a SEPARATE hash chain from
 *   the existing EVM-mint publisher's "sonar-api:sonar-api-1". NEVER reuse the
 *   existing signer/identity — a shared chain would interleave two producers and
 *   fork (the events package's per-publisher chain assumption, F-005).
 *
 * Uses `makeEmitter().emit()` (F2 fix), NOT raw `publishEnvelope`: emit() takes the
 * chain mutex + validates the payload against the registry schema BEFORE signing and
 * BEFORE the prev-hash advances, and returns a typed `Either.Left` on failure (never
 * a throw, never a silent drop, never a forked chain). ONE emitter instance per
 * process → ONE coherent chain even under concurrent emits.
 *
 * DEPLOYED-BUT-UNCONSUMED (F7): the live push is HELD until the score-mibera consumer
 * handshake (S5). {@link isCanonicalEmitEnabled} defaults OFF — the composition root
 * MUST consult it before building a live emitter, so nothing reaches the live
 * `nft.activity.recorded.*` subject ahead of validation. This module ships the
 * (tested) emit wiring inert; the live transport/seed are plugged at go-live (S6).
 *
 * Prev-hash store: `InMemoryPrevHashStore` (matching the existing events-publisher;
 * Redis is NOT in the estate). The per-process restart caveat — a restart re-genesis-es
 * the chain — is identical to and accepted for the sonar-api publisher; a durable store
 * is a future improvement for BOTH. (SDD §2 [VERIFY] Redis → resolved: not present.)
 *
 * S6 GO-LIVE PREREQUISITES (FAGAN carry-forward — land at the composition root BEFORE flipping the
 * gate to "true"; this INERT layer does NOT need them):
 *   1. Durable prev-hash store OR a consumer-side chain-reset handshake — else a sonar restart
 *      re-genesis-es the tip and a chain-verifying consumer surfaces prev-hash-broken on every
 *      restart envelope. The canonical chain's value IS verifiability, so this bites harder here
 *      than for nft.mint.detected.
 *   2. Build the live emitter via {@link makeCanonicalEmitterIfEnabled} (the gate as a CAPABILITY —
 *      null when disabled), never the raw factory, so the live path can't be constructed while off.
 *   3. Seed the signer from a DISTINCT secret (e.g. SONAR_CANONICAL_SIGNING_SEED_HEX) — NEVER reuse
 *      SONAR_SIGNING_SEED_HEX. The keyId guard below is label-only; it cannot detect wrong key
 *      MATERIAL under the right id (the consumer's signature verifier is the loud backstop).
 *   4. Wire a `recovery` config (maxRetries + deadLetter + onAlert) so a transient NATS blip is an
 *      observable dead-letter, not a silently-dropped Left.
 */
import { Either } from "effect";
import {
  makeEmitter,
  InMemoryPrevHashStore,
  NftActivityId,
  type Emitter,
  type EmitReceipt,
  type EmitError,
  type NatsTransport,
  type Signer,
  type PrevHashStore,
  type NftActivity,
} from "@0xhoneyjar/events";

/** The DISTINCT canonical publisher identity (F1) — never reuse sonar-api's. */
export const CANONICAL_CELL = "sonar-canonical";
export const CANONICAL_KEY_ID = "sonar-canonical-1";

export interface CanonicalEmitterDeps {
  /** Opaque transport (createNatsTransport(rawNats)) — built at the composition root. */
  readonly transport: NatsTransport;
  /** Ed25519 signer; its `keyId` MUST be {@link CANONICAL_KEY_ID}. */
  readonly signer: Signer;
  /** Default: a fresh InMemoryPrevHashStore (per-process; restart re-genesis caveat). */
  readonly prevHashStore?: PrevHashStore;
  /** Max time a publish may hold the chain lock (default 5000ms in the package). */
  readonly publishTimeoutMs?: number;
}

/**
 * Build the canonical emitter. Use ONE instance per process so all activities share
 * ONE prev-hash chain (the makeEmitter mutex serializes concurrent emits — F2).
 * The publisherKey defaults to `${cell}:${signer.keyId}` = "sonar-canonical:sonar-canonical-1".
 */
export function makeCanonicalEmitter(deps: CanonicalEmitterDeps): Emitter {
  if (deps.signer.keyId !== CANONICAL_KEY_ID) {
    // Guard the F1 invariant at the wiring seam: a wrong keyId would change the
    // publisherKey and silently start a different chain.
    throw new Error(
      `canonical emitter requires signer.keyId="${CANONICAL_KEY_ID}", got "${deps.signer.keyId}"`,
    );
  }
  return makeEmitter({
    cell: CANONICAL_CELL,
    transport: deps.transport,
    signer: deps.signer,
    prevHashStore: deps.prevHashStore ?? new InMemoryPrevHashStore(),
    publishTimeoutMs: deps.publishTimeoutMs,
  });
}

/**
 * Emit one canonical activity. The subject is built from the payload's own
 * `collection_key` specifier → `nft.activity.recorded.<collection_key>.v1`
 * (the collection_key charset is the topic-segment grammar, so it is always a
 * sendable specifier — the assumed-schema antibody). Returns a typed Either.
 */
export function emitActivity(
  emitter: Emitter,
  activity: NftActivity,
): Promise<Either.Either<EmitReceipt, EmitError>> {
  return emitter.emit(NftActivityId, activity, activity.collection_key);
}

/**
 * F7 gate (deployed-but-unconsumed): the live push is held until the score-mibera
 * handshake. Defaults OFF; the live composition root consults this BEFORE emitting
 * to real NATS, so this PR ships the emit wiring inert. Enable only post-S5.
 */
export function isCanonicalEmitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SONAR_CANONICAL_EMIT_ENABLED === "true";
}

/**
 * Gate-ENFORCING factory (MINOR-2): returns the emitter ONLY when the F7 gate is enabled, else null.
 * The live composition root MUST construct via this — so the live emit path cannot be built while the
 * gate is off. Makes F7 a capability (a null you can't emit through), not a convention a caller might
 * forget to check (the failure mode the events package's transport boundary deliberately rejects).
 */
export function makeCanonicalEmitterIfEnabled(
  deps: CanonicalEmitterDeps,
  env: NodeJS.ProcessEnv = process.env,
): Emitter | null {
  return isCanonicalEmitEnabled(env) ? makeCanonicalEmitter(deps) : null;
}
