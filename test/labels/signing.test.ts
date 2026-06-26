/*
 * signing.test.ts — Ed25519 operator-attested signing (FR-3, H-3/H-4, SP-4). Real crypto, no mocks for the
 * primitive; the key-resolver is injected for the step tests.
 */
import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  signingPayload, signPayload, verifyPayload, makeSigningStep, type KeyResolver,
} from "../../src/labels/signing";
import { LabelReject, type LabelInput } from "../../src/labels/types";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const pubDerB64 = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");

const row = (over: Partial<LabelInput> = {}): LabelInput => ({
  address: "TEAMWALLET1", chain: "solana", collectionScope: "pythians",
  entity: "thj-team", label: "THJ team multisig", entityType: "multisig",
  method: "operator-attested", evidenceRef: "operator-2026-06-25", ...over,
});

const resolver = (over: Partial<{ revoked: boolean; missing: boolean }> = {}): KeyResolver =>
  async (_id) => (over.missing ? null : { publicKeyDerB64: pubDerB64, revoked: over.revoked ?? false });

describe("signing primitives", () => {
  it("round-trips: sign then verify is true", () => {
    const p = signingPayload(row());
    expect(verifyPayload(p, signPayload(p, privPem), pubDerB64)).toBe(true);
  });
  it("a tampered payload fails verify", () => {
    const sig = signPayload(signingPayload(row()), privPem);
    expect(verifyPayload(signingPayload(row({ label: "FORGED" })), sig, pubDerB64)).toBe(false);
  });
  it("verify never throws on garbage input", () => {
    expect(verifyPayload("x", "not-base64!!", "also-bad")).toBe(false);
  });
});

describe("makeSigningStep", () => {
  const signed = (): LabelInput => {
    const r = row();
    return { ...r, signature: signPayload(signingPayload(r), privPem), signingKeyId: "ops-1" };
  };

  it("accepts a valid signature → signatureValid=true, status verified", async () => {
    const out = await makeSigningStep(resolver()).apply(signed(), { runSql: async () => ({}) as never, log: () => {} });
    expect(out.signatureValid).toBe(true);
    expect(out.status).toBe("verified");
  });

  it("rejects a revoked key", async () => {
    await expect(makeSigningStep(resolver({ revoked: true })).apply(signed(), { runSql: async () => ({}) as never, log: () => {} }))
      .rejects.toBeInstanceOf(LabelReject);
  });

  it("rejects an unknown key", async () => {
    await expect(makeSigningStep(resolver({ missing: true })).apply(signed(), { runSql: async () => ({}) as never, log: () => {} }))
      .rejects.toBeInstanceOf(LabelReject);
  });

  it("rejects a bad signature", async () => {
    const bad = { ...signed(), signature: signPayload(signingPayload(row({ label: "OTHER" })), privPem) };
    await expect(makeSigningStep(resolver()).apply(bad, { runSql: async () => ({}) as never, log: () => {} }))
      .rejects.toBeInstanceOf(LabelReject);
  });

  it("rejects operator-attested with no signature at all", async () => {
    await expect(makeSigningStep(resolver()).apply(row(), { runSql: async () => ({}) as never, log: () => {} }))
      .rejects.toBeInstanceOf(LabelReject);
  });

  it("passes non-operator-attested rows through untouched", async () => {
    const r = row({ method: "chain-mechanical", signature: null, signingKeyId: null });
    const out = await makeSigningStep(resolver()).apply(r, { runSql: async () => ({}) as never, log: () => {} });
    expect(out).toEqual(r);
  });
});
