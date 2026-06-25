import { describe, it, expect } from "vitest";
import { Either } from "effect";
import {
  createNatsTransport,
  LocalEd25519Signer,
  InMemoryPrevHashStore,
  GENESIS_PREV_HASH,
  type NftActivity,
} from "@0xhoneyjar/events";
import {
  makeCanonicalEmitter,
  makeCanonicalEmitterIfEnabled,
  emitActivity,
  isCanonicalEmitEnabled,
  CANONICAL_CELL,
  CANONICAL_KEY_ID,
} from "../../src/canonical/emit";

const SEED_HEX = "0123456789abcdef".repeat(4); // 32-byte ed25519 seed

/** A mock NATS client that records every published envelope. */
function recordingNats() {
  const published: Array<{ subject: string; envelope: any }> = [];
  const raw = {
    publish(subject: string, data: Uint8Array) {
      published.push({ subject, envelope: JSON.parse(new TextDecoder().decode(data)) });
    },
  };
  return { raw, published };
}

function activity(assetRef: string, txSuffix: string): NftActivity {
  return {
    verb: "transfer",
    chain: "svm",
    collection_key: "pythians",
    asset_ref: assetRef,
    from: "5xSeller1111111111111111111111111111111111",
    to: "2YBuyer11111111111111111111111111111111111",
    value: null,
    decimals: null,
    tx: "sig" + txSuffix,
    timestamp: "2025-02-02T19:47:00Z",
    metadata: {
      chain: "svm",
      collection_mint: "pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru",
      nft_mint: assetRef,
      instruction_index: 0,
      slot: 314801673,
    },
  } as NftActivity;
}

async function canonicalSigner() {
  return LocalEd25519Signer.fromSeedHex(SEED_HEX, CANONICAL_KEY_ID);
}

describe("canonical emit — identity + subject", () => {
  it("emits under the DISTINCT sonar-canonical identity, on the collection-keyed subject", async () => {
    const { raw, published } = recordingNats();
    const emitter = makeCanonicalEmitter({
      transport: createNatsTransport(raw),
      signer: await canonicalSigner(),
      prevHashStore: new InMemoryPrevHashStore(),
    });

    const res = await emitActivity(emitter, activity("MINT_A", "a"));
    expect(Either.isRight(res)).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0].subject).toBe("nft.activity.recorded.pythians.v1");
    expect(published[0].envelope.emitted_by).toBe(CANONICAL_CELL);
    expect(published[0].envelope.signing_key_id).toBe(CANONICAL_KEY_ID);
    expect(published[0].envelope.payload.asset_ref).toBe("MINT_A");
  });
});

describe("canonical emit — F2 chain integrity (concurrent emits → ONE coherent chain, no fork)", () => {
  it("serializes concurrent emits into a single linear prev-hash chain", async () => {
    const { raw, published } = recordingNats();
    const emitter = makeCanonicalEmitter({
      transport: createNatsTransport(raw),
      signer: await canonicalSigner(),
      prevHashStore: new InMemoryPrevHashStore(),
    });

    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => emitActivity(emitter, activity("TOK_" + i, String(i)))),
    );
    // every emit succeeded
    for (const r of results) expect(Either.isRight(r)).toBe(true);
    const receipts = results.flatMap((r) => (Either.isRight(r) ? [r.right] : []));
    expect(published).toHaveLength(N);

    // map each envelope's own hash via its receipt (event_id → envelopeHash)
    const hashByEventId = new Map(receipts.map((r) => [r.event_id, r.envelopeHash]));
    const envelopes = published.map((p) => p.envelope);

    // (a) exactly ONE root (prev_hash === GENESIS) → no fork at the root
    const roots = envelopes.filter((e) => e.prev_hash === GENESIS_PREV_HASH);
    expect(roots).toHaveLength(1);

    // (b) all prev_hash values distinct → linear chain, never two children of one node (no fork)
    const prevHashes = envelopes.map((e) => e.prev_hash);
    expect(new Set(prevHashes).size).toBe(N);

    // (c) every non-root prev_hash points to an actual envelope's hash in this batch (no orphan)
    const ownHashes = new Set(envelopes.map((e) => hashByEventId.get(e.event_id)));
    for (const e of envelopes) {
      if (e.prev_hash !== GENESIS_PREV_HASH) expect(ownHashes.has(e.prev_hash)).toBe(true);
    }

    // (d) one identity throughout
    for (const e of envelopes) {
      expect(e.emitted_by).toBe(CANONICAL_CELL);
      expect(e.signing_key_id).toBe(CANONICAL_KEY_ID);
    }
  });
});

describe("canonical emit — F1 guard + F7 gate", () => {
  it("refuses to build with a wrong signer keyId (would fork into a different chain)", async () => {
    const { raw } = recordingNats();
    const wrong = await LocalEd25519Signer.fromSeedHex(SEED_HEX, "sonar-api-1");
    expect(() =>
      makeCanonicalEmitter({ transport: createNatsTransport(raw), signer: wrong }),
    ).toThrow(/sonar-canonical-1/);
  });

  it("emit gate defaults OFF and only 'true' enables it (deployed-but-unconsumed)", () => {
    expect(isCanonicalEmitEnabled({})).toBe(false);
    expect(isCanonicalEmitEnabled({ SONAR_CANONICAL_EMIT_ENABLED: "1" } as any)).toBe(false);
    expect(isCanonicalEmitEnabled({ SONAR_CANONICAL_EMIT_ENABLED: "false" } as any)).toBe(false);
    expect(isCanonicalEmitEnabled({ SONAR_CANONICAL_EMIT_ENABLED: "true" } as any)).toBe(true);
  });

  it("makeCanonicalEmitterIfEnabled returns null when the gate is off (unbypassable — MINOR-2)", async () => {
    const { raw } = recordingNats();
    const deps = { transport: createNatsTransport(raw), signer: await canonicalSigner() };
    expect(makeCanonicalEmitterIfEnabled(deps, {} as any)).toBeNull(); // off → no emitter to emit through
    expect(makeCanonicalEmitterIfEnabled(deps, { SONAR_CANONICAL_EMIT_ENABLED: "true" } as any)).not.toBeNull();
  });
});
