/*
 * reconcile-rpc.test.ts — the public-RPC reconciler's pure parts (network-free): evidence_ref parsing,
 * the minimal Metaplex metadata decode (round-trip), and H-6 (a bad anchor never produces a false reject).
 */
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { parseEvidenceRef, decodeMetadata, makePublicRpcReconciler, authorityFieldValue, creatorAssertionHolds, isMetadataAccount, TOKEN_METADATA_PROGRAM } from "../../src/labels/reconcile-rpc";
import type { LabelInput } from "../../src/labels/types";

describe("parseEvidenceRef", () => {
  it("parses a .mint_authority field assertion with a slot suffix", () => {
    expect(parseEvidenceRef("account:pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru.mint_authority@slot:429100856"))
      .toEqual({ kind: "account", pubkey: "pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru", field: "mint_authority" });
  });
  it("parses .update_authority on a metadata_account", () => {
    expect(parseEvidenceRef("metadata_account:AHY8Wr6fuunuGaynkW2AhzAAm42HmsF9xP8XJzhmii8r.update_authority@slot:1").field).toBe("update_authority");
  });
  it("parses an indexed .creators[0] field", () => {
    expect(parseEvidenceRef("metadata_account:AHY8Wr6fuunuGaynkW2AhzAAm42HmsF9xP8XJzhmii8r.creators[0]@slot:1").field).toBe("creators[0]");
  });
  it("owner_of carries a pubkey and no field", () => {
    expect(parseEvidenceRef("owner_of:FNYji1B78vKk7QrzCoEAKkS6NkDGsKUGdCV9feM4xmr1@slot:1"))
      .toEqual({ kind: "owner_of", pubkey: "FNYji1B78vKk7QrzCoEAKkS6NkDGsKUGdCV9feM4xmr1", field: "" });
  });
  it("a bare self-anchor has no field", () => {
    expect(parseEvidenceRef("account:pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru@slot:1").field).toBe("");
  });
  it("uses ONLY the first clause when several are present", () => {
    const r = parseEvidenceRef("metadata_account:AHY8Wr6fuunuGaynkW2AhzAAm42HmsF9xP8XJzhmii8r.update_authority@slot:1; account:2QJTLwQ7BjTLLwkPTh1Bt7yLny5Hz7cYLHDC6APoUsKK@slot:2");
    expect(r.kind).toBe("metadata_account");
    expect(r.pubkey).toBe("AHY8Wr6fuunuGaynkW2AhzAAm42HmsF9xP8XJzhmii8r");
  });
});

function buildMeta(updateAuthority: PublicKey, creators: PublicKey[] | null): Buffer {
  const parts: Buffer[] = [Buffer.from([4]), updateAuthority.toBuffer(), Keypair.generate().publicKey.toBuffer()];
  for (const s of ["Pythenians", "PTN", "https://x/y.json"]) {
    const b = Buffer.from(s, "utf8"); const len = Buffer.alloc(4); len.writeUInt32LE(b.length); parts.push(len, b);
  }
  const fee = Buffer.alloc(2); fee.writeUInt16LE(500); parts.push(fee);
  if (creators === null) { parts.push(Buffer.from([0])); return Buffer.concat(parts); } // Option::None
  parts.push(Buffer.from([1])); // Option::Some
  const n = Buffer.alloc(4); n.writeUInt32LE(creators.length); parts.push(n);
  for (const c of creators) parts.push(c.toBuffer(), Buffer.from([1, 100])); // verified=1, share=100
  return Buffer.concat(parts);
}

describe("decodeMetadata", () => {
  it("decodes updateAuthority + ordered creators (round-trip)", () => {
    const ua = Keypair.generate().publicKey, c0 = Keypair.generate().publicKey, c1 = Keypair.generate().publicKey;
    const d = decodeMetadata(buildMeta(ua, [c0, c1]));
    expect(d).not.toBeNull();
    expect(d!.updateAuthority).toBe(ua.toBase58());
    expect(d!.creators).toEqual([c0.toBase58(), c1.toBase58()]);
  });
  it("handles Option::None creators", () => {
    const ua = Keypair.generate().publicKey;
    const d = decodeMetadata(buildMeta(ua, null));
    expect(d).not.toBeNull();
    expect(d!.creators).toEqual([]);
  });
  it("returns null on a too-short / malformed buffer (deterministic, not a throw)", () => {
    expect(decodeMetadata(Buffer.from([4, 1, 2]))).toBeNull();
  });
});

describe("authorityFieldValue (exact field, no OR — FAGAN #1)", () => {
  const info = { mintAuthority: "MINT", freezeAuthority: "FREEZE" };
  it("mint_authority compares ONLY mintAuthority", () => expect(authorityFieldValue("mint_authority", info)).toBe("MINT"));
  it("freeze_authority compares ONLY freezeAuthority", () => expect(authorityFieldValue("freeze_authority", info)).toBe("FREEZE"));
  it("a freeze-only match does NOT satisfy a mint_authority claim", () =>
    expect(authorityFieldValue("mint_authority", { mintAuthority: "OTHER", freezeAuthority: "ME" })).not.toBe("ME"));
});

describe("creatorAssertionHolds (indexed = exact position — FAGAN #2)", () => {
  const cs = ["A", "B", "C"];
  it("creators[0] matches only position 0", () => {
    expect(creatorAssertionHolds("creators[0]", cs, "A")).toBe(true);
    expect(creatorAssertionHolds("creators[0]", cs, "B")).toBe(false); // B is creators[1], not [0]
  });
  it("creators[2] matches position 2", () => expect(creatorAssertionHolds("creators[2]", cs, "C")).toBe(true));
  it("an out-of-range index is not satisfied", () => expect(creatorAssertionHolds("creators[5]", cs, "A")).toBe(false));
  it("a bare 'creators' (no index) falls back to membership", () => {
    expect(creatorAssertionHolds("creators", cs, "B")).toBe(true);
    expect(creatorAssertionHolds("creators", cs, "Z")).toBe(false);
  });
});

describe("isMetadataAccount (guard before decode — FAGAN #3)", () => {
  const tm = new PublicKey(TOKEN_METADATA_PROGRAM);
  const other = Keypair.generate().publicKey;
  it("accepts a Token-Metadata-owned account with the V1 key byte", () => expect(isMetadataAccount({ owner: tm, data: Buffer.from([4, 0, 0]) })).toBe(true));
  it("rejects null", () => expect(isMetadataAccount(null)).toBe(false));
  it("rejects a non-TM owner — arbitrary bytes can't be coerced into 'metadata'", () => expect(isMetadataAccount({ owner: other, data: Buffer.from([4, 0, 0]) })).toBe(false));
  it("rejects the wrong key discriminator", () => expect(isMetadataAccount({ owner: tm, data: Buffer.from([0, 0, 0]) })).toBe(false));
  it("rejects empty data", () => expect(isMetadataAccount({ owner: tm, data: Buffer.alloc(0) })).toBe(false));
});

describe("makePublicRpcReconciler (H-6)", () => {
  const row = (evidenceRef: string): LabelInput => ({
    address: "2QJTLwQ7BjTLLwkPTh1Bt7yLny5Hz7cYLHDC6APoUsKK", chain: "solana", collectionScope: "pythians",
    entity: "e", label: "l", entityType: "collection_authority", method: "chain-mechanical", evidenceRef,
  });
  it("returns a Reconciler function", () => {
    expect(typeof makePublicRpcReconciler("https://example.invalid")).toBe("function");
  });
  it("a malformed anchor pubkey → DETERMINISTIC reject (available:true, ok:false — not retried forever)", async () => {
    const out = await makePublicRpcReconciler()(row("owner_of:not-a-valid-pubkey@slot:1"));
    expect(out).toEqual({ available: true, ok: false }); // deterministic: charges an attempt, eventually sealed
  });
});

describe("makePublicRpcReconciler — strict evidence grammar (FAGAN #4/#5; all network-free)", () => {
  const r = makePublicRpcReconciler();
  const V = "AHY8Wr6fuunuGaynkW2AhzAAm42HmsF9xP8XJzhmii8r"; // a real, well-formed pubkey
  const mk = (evidenceRef: string): LabelInput => ({
    address: V, chain: "solana", collectionScope: "p", entity: "e", label: "l", entityType: "unknown", method: "chain-mechanical", evidenceRef,
  });
  it("mint_authority on a non-account kind rejects before any fetch", async () =>
    expect(await r(mk(`metadata_account:${V}.mint_authority@slot:1`))).toEqual({ available: true, ok: false }));
  it("update_authority on a non-metadata kind rejects before any fetch", async () =>
    expect(await r(mk(`owner_of:${V}.update_authority@slot:1`))).toEqual({ available: true, ok: false }));
  it("an unrecognized field rejects", async () =>
    expect(await r(mk(`account:${V}.supply@slot:1`))).toEqual({ available: true, ok: false }));
  it("a creators-prefixed-but-not-exact field (creatorship) rejects, not treated as membership", async () =>
    expect(await r(mk(`metadata_account:${V}.creatorship@slot:1`))).toEqual({ available: true, ok: false }));
  it("an unrecognized evidence kind rejects (no fall-through to the metadata self-anchor)", async () =>
    expect(await r(mk(`frobnicate:${V}@slot:1`))).toEqual({ available: true, ok: false }));
  it("a non-Solana row rejects before anything else (Solana-only reconciler)", async () =>
    expect(await r({ ...mk(`owner_of:${V}@slot:1`), chain: "ethereum" })).toEqual({ available: true, ok: false }));
});
