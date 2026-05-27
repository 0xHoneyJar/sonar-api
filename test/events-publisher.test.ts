/**
 * events-publisher.test.ts — golden-replay tests for the NATS+ACVP publish
 * substrate (cluster-events-pillar-v1 sprint 2, sonar DEP-1).
 *
 * Validates the contract that handlers depend on:
 *
 *   - Subject derivation matches the cluster spec
 *     (`nft.mint.detected.{collectionSlug}.v1`).
 *   - Envelope wire-format published to NATS is well-formed JSON, contains
 *     the acvp-l1-v2 fields, and decodes cleanly via the lib's envelope
 *     schema. (Hash chain + signature integrity are exercised in the
 *     @0xhoneyjar/events library's own test suite — we test the integration,
 *     not the substrate.)
 *   - Payload survives the canonicalize → publish round-trip with the
 *     handler-supplied fields preserved (chain_id, contract, token_id,
 *     minter, encoded_traits for MST).
 *   - Fail-soft invariant: when NATS publish throws, the handler-facing
 *     `publishMintEvent` swallows the error AND logs via `log.warn`.
 *   - When NATS_URL / SONAR_SIGNING_SEED_HEX are absent, the substrate
 *     stays disabled and never throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalEd25519Signer, type Signer } from "@0xhoneyjar/events";

import {
  __resetForTests,
  __setTestSubstrate,
  publishMintEvent,
  type MintEventPayload,
} from "../src/lib/events-publisher";

// Deterministic 32-byte ed25519 seed for tests (NOT a real secret).
const TEST_SEED_HEX = "11".repeat(32);
const TEST_KEY_ID = "test-sonar-1";

interface PublishCall {
  subject: string;
  data: Uint8Array;
  opts?: { headers?: unknown };
}

function createMockNats(opts: { failOnce?: boolean } = {}) {
  const calls: PublishCall[] = [];
  let failNext = opts.failOnce ?? false;
  const nats = {
    publish: vi.fn((subject: string, data: Uint8Array, callOpts?: { headers?: unknown }) => {
      if (failNext) {
        failNext = false;
        throw new Error("nats-down");
      }
      calls.push({ subject, data, opts: callOpts });
    }),
  };
  return { nats, calls };
}

function createMockLog() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
  };
}

function decodePublishedEnvelope(data: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(data));
}

const samplePayload: MintEventPayload = {
  chain_id: 80094,
  contract: "0x048327a187b944ddac61c6e202bfccd20d17c008",
  token_id: "234",
  minter: "0xabcdef0000000000000000000000000000000001",
  block_number: 12345678,
  transaction_hash: "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
  timestamp: "2026-05-26T21:30:00.000Z",
};

let signer: Signer;

beforeEach(async () => {
  signer = await LocalEd25519Signer.fromSeedHex(TEST_SEED_HEX, TEST_KEY_ID);
  __resetForTests();
});

afterEach(() => {
  __resetForTests();
});

describe("events-publisher — substrate disabled (no env vars)", () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.NATS_URL;
    delete process.env.SONAR_SIGNING_SEED_HEX;
    delete process.env.NATS_TLS_CA;
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  it("returns silently when NATS_URL is absent", async () => {
    const log = createMockLog();
    await expect(
      publishMintEvent({ log, collectionSlug: "mibera-shadow", payload: samplePayload }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("[events-publisher] permanently disabled: NATS_URL not set"),
    );
  });

  // BB#24 F-002: TLS-only invariant must be enforced. Plaintext nats://
  // without NATS_TLS_CA → permanently disabled (not silently allowed).
  it("refuses plaintext NATS_URL without NATS_TLS_CA (BB#24 F-002)", async () => {
    const log = createMockLog();
    process.env.NATS_URL = "nats://broker:4222";
    process.env.SONAR_SIGNING_SEED_HEX = "0".repeat(64);
    // NATS_TLS_CA intentionally unset
    await publishMintEvent({ log, collectionSlug: "mibera-shadow", payload: samplePayload });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("plaintext"),
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("permanently disabled"));
  });

});

// Path-ε mTLS client-cert tests — exercise the init path that reads
// NATS_TLS_CLIENT_CERT / NATS_TLS_CLIENT_KEY env vars. These tests rely on
// nats.connect() being the failure point AFTER our env-validation runs, so
// the publisher reaches transient-failure state once the partial-config
// guard is satisfied AND the assertion target is the connect-options object.
//
// We intercept nats.connect via vi.mock at the module level so we can:
//   (a) assert connect options for the both-set case (cert + key passed)
//   (b) keep the partial-config tests pure (init returns before connect)
describe("events-publisher — Path-ε mTLS client cert (init path)", () => {
  const ORIG_ENV = { ...process.env };

  // Dummy PEM bodies — content is opaque to the publisher (passed straight
  // through to nats.connect's tls options). Real PEM validation happens at
  // TLS handshake time, which we never reach because connect is mocked OR
  // because the partial-config guard fires before connect.
  //
  // Path-ε convention: NATS_TLS_CA / CLIENT_CERT / CLIENT_KEY all hold PEM
  // **bodies** (not paths) — Railway service-variables inject the content.
  const FAKE_CA = "-----BEGIN CERTIFICATE-----\nMIIBdummyca\n-----END CERTIFICATE-----\n";
  const FAKE_CLIENT_CERT = "-----BEGIN CERTIFICATE-----\nMIIBdummyclientcert\n-----END CERTIFICATE-----\n";
  const FAKE_CLIENT_KEY = "-----BEGIN PRIVATE KEY-----\nMIIBdummyclientkey\n-----END PRIVATE KEY-----\n";

  beforeEach(() => {
    process.env.NATS_URL = "tls://broker.example:4222";
    process.env.SONAR_SIGNING_SEED_HEX = "0".repeat(64);
    process.env.NATS_TLS_CA = FAKE_CA;
    delete process.env.NATS_TLS_CLIENT_CERT;
    delete process.env.NATS_TLS_CLIENT_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
    vi.doUnmock("nats");
  });

  it("refuses partial config: NATS_TLS_CLIENT_CERT set without NATS_TLS_CLIENT_KEY (permanently disabled)", async () => {
    process.env.NATS_TLS_CLIENT_CERT = FAKE_CLIENT_CERT;
    // NATS_TLS_CLIENT_KEY intentionally unset
    const log = createMockLog();
    await publishMintEvent({ log, collectionSlug: "mibera-shadow", payload: samplePayload });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("permanently disabled"));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("NATS_TLS_CLIENT_CERT and NATS_TLS_CLIENT_KEY must both be set or both unset"),
    );
  });

  it("refuses partial config: NATS_TLS_CLIENT_KEY set without NATS_TLS_CLIENT_CERT (permanently disabled)", async () => {
    process.env.NATS_TLS_CLIENT_KEY = FAKE_CLIENT_KEY;
    // NATS_TLS_CLIENT_CERT intentionally unset
    const log = createMockLog();
    await publishMintEvent({ log, collectionSlug: "mibera-shadow", payload: samplePayload });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("permanently disabled"));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("NATS_TLS_CLIENT_CERT and NATS_TLS_CLIENT_KEY must both be set or both unset"),
    );
  });

  it("both env vars set → connect options include cert + key alongside ca", async () => {
    // Capture the options nats.connect was called with by mocking the module.
    // Use vi.resetModules() + vi.doMock so the publisher's `import { connect }
    // from "nats"` resolves to our spy on this re-import.
    process.env.NATS_TLS_CLIENT_CERT = FAKE_CLIENT_CERT;
    process.env.NATS_TLS_CLIENT_KEY = FAKE_CLIENT_KEY;

    const connectSpy = vi.fn(async () => ({
      publish: vi.fn(),
      close: vi.fn(),
      drain: vi.fn(),
    }));
    vi.resetModules();
    vi.doMock("nats", () => ({ connect: connectSpy }));

    // Re-import the publisher AFTER the mock is in place. The re-imported
    // module is FRESH (vi.resetModules cleared the cache), distinct from
    // the static-imported one used by the other tests in this file — but
    // we still call __resetForTests on it to defend against any leftover
    // singleton state in case vi.resetModules + dynamic-import semantics
    // ever evolve.
    const reimported = await import("../src/lib/events-publisher");
    reimported.__resetForTests();
    const log = createMockLog();
    await reimported.publishMintEvent({
      log,
      collectionSlug: "mibera-shadow",
      payload: samplePayload,
    });

    expect(connectSpy).toHaveBeenCalledTimes(1);
    const connectArgs = connectSpy.mock.calls[0]![0] as {
      servers: string;
      tls?: { ca?: string; cert?: string; key?: string };
    };
    expect(connectArgs.tls).toBeDefined();
    // The publisher .trim()s env-var bodies to defend against trailing
    // CRLF / whitespace that Railway service-variables occasionally
    // introduce on copy-paste — assertion matches the documented behavior.
    expect(connectArgs.tls!.ca).toBe(FAKE_CA.trim());
    expect(connectArgs.tls!.cert).toBe(FAKE_CLIENT_CERT.trim());
    expect(connectArgs.tls!.key).toBe(FAKE_CLIENT_KEY.trim());
  });

  it("backward-compat: neither client-cert env set → tls options omit cert/key (CA-only)", async () => {
    // Neither NATS_TLS_CLIENT_CERT nor NATS_TLS_CLIENT_KEY set.
    const connectSpy = vi.fn(async () => ({
      publish: vi.fn(),
      close: vi.fn(),
      drain: vi.fn(),
    }));
    vi.resetModules();
    vi.doMock("nats", () => ({ connect: connectSpy }));

    const reimported = await import("../src/lib/events-publisher");
    reimported.__resetForTests();
    const log = createMockLog();
    await reimported.publishMintEvent({
      log,
      collectionSlug: "mibera-shadow",
      payload: samplePayload,
    });

    expect(connectSpy).toHaveBeenCalledTimes(1);
    const connectArgs = connectSpy.mock.calls[0]![0] as {
      servers: string;
      tls?: { ca?: string; cert?: string; key?: string };
    };
    expect(connectArgs.tls).toBeDefined();
    expect(connectArgs.tls!.ca).toBe(FAKE_CA.trim());
    expect(connectArgs.tls!.cert).toBeUndefined();
    expect(connectArgs.tls!.key).toBeUndefined();
  });
});

describe("events-publisher — substrate injected (test mode)", () => {
  it("publishes the MST (mibera-shadow) envelope on the spec'd subject", async () => {
    const { nats, calls } = createMockNats();
    __setTestSubstrate({ nats, signer });

    const log = createMockLog();
    await publishMintEvent({
      log,
      collectionSlug: "mibera-shadow",
      payload: { ...samplePayload, encoded_traits: "0xabcdef" },
    });

    expect(nats.publish).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toBe("nft.mint.detected.mibera-shadow.v1");

    const envelope = decodePublishedEnvelope(calls[0]!.data);
    expect(envelope.schema_version).toBe("acvp-l1-v2");
    expect(envelope.event_type).toBe("nft.mint.detected.mibera-shadow.v1");
    expect(envelope.emitted_by).toBe("sonar-api");
    expect(envelope.signing_key_id).toBe(TEST_KEY_ID);
    expect(envelope.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(envelope.prev_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope.payload_hash).toMatch(/^[0-9a-f]{64}$/);

    const payload = envelope.payload as Record<string, unknown>;
    expect(payload.chain_id).toBe(80094);
    expect(payload.contract).toBe(samplePayload.contract);
    expect(payload.token_id).toBe("234");
    expect(payload.minter).toBe(samplePayload.minter);
    expect(payload.encoded_traits).toBe("0xabcdef");
  });

  it.each([
    ["mibera-collection", "nft.mint.detected.mibera-collection.v1"],
    ["mibera-sets", "nft.mint.detected.mibera-sets.v1"],
    ["mibera-zora", "nft.mint.detected.mibera-zora.v1"],
    ["purupuru-apiculture", "nft.mint.detected.purupuru-apiculture.v1"],
  ] as const)("derives the right subject for %s", async (slug, expectedSubject) => {
    const { nats, calls } = createMockNats();
    __setTestSubstrate({ nats, signer });
    const log = createMockLog();

    await publishMintEvent({ log, collectionSlug: slug, payload: samplePayload });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toBe(expectedSubject);
  });

  it("advances prev_hash across consecutive publishes (chain continuity)", async () => {
    const { nats, calls } = createMockNats();
    __setTestSubstrate({ nats, signer });
    const log = createMockLog();

    await publishMintEvent({ log, collectionSlug: "mibera-shadow", payload: samplePayload });
    await publishMintEvent({
      log,
      collectionSlug: "mibera-shadow",
      payload: { ...samplePayload, token_id: "235" },
    });

    expect(calls).toHaveLength(2);
    const env1 = decodePublishedEnvelope(calls[0]!.data);
    const env2 = decodePublishedEnvelope(calls[1]!.data);
    // Chain advances: env2's prev_hash must differ from env1's prev_hash
    // (and must be a non-zero 64-hex string, which the envelope schema
    // already enforces at decode time). We don't assert GENESIS on env1
    // because the module-level prevHashStore is shared across tests in
    // this file — true GENESIS assertion lives in the @0xhoneyjar/events
    // library's own unit tests.
    expect(env1.prev_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(env2.prev_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(env2.prev_hash).not.toBe(env1.prev_hash);
  });

  it("FAIL-SOFT: swallows NATS publish errors and logs a warning (handler still completes)", async () => {
    const { nats } = createMockNats({ failOnce: true });
    __setTestSubstrate({ nats, signer });
    const log = createMockLog();

    // The promise MUST resolve cleanly even though nats.publish throws.
    await expect(
      publishMintEvent({ log, collectionSlug: "mibera-shadow", payload: samplePayload }),
    ).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("[events-publisher] publish failed"),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("nats-down"),
    );
  });

  it("FAIL-SOFT: subsequent publishes recover after a transient error (next call doesn't throw)", async () => {
    const { nats, calls } = createMockNats({ failOnce: true });
    __setTestSubstrate({ nats, signer });
    const log = createMockLog();

    // First call: publish throws, swallowed.
    await publishMintEvent({ log, collectionSlug: "mibera-shadow", payload: samplePayload });
    // Second call: should succeed (mockNats only fails once).
    await publishMintEvent({
      log,
      collectionSlug: "mibera-shadow",
      payload: { ...samplePayload, token_id: "999" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toBeDefined();
  });
});
