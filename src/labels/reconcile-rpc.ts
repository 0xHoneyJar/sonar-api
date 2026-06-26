/**
 * reconcile-rpc.ts — a public-RPC `Reconciler` (zero Helius) that re-derives chain-mechanical /
 * program-metadata labels from their self-describing `evidence_ref`. Lets `reconcileQueueWorker`
 * verify the chain-derived registry for free, independent of the Helius credit quota — the SP-5
 * "chain source" without the metered provider. The own-indexed source stays in its own reconciler.
 *
 * `evidence_ref` grammar (the FIRST clause is authoritative):
 *   <kind>:<pubkey>[.<field>]@slot:<N>[; <more clauses…>]
 *   kind  ∈ account | metadata_account | owner_of
 *   field ∈ mint_authority | freeze_authority | update_authority | creators[N] | (none → self-anchor)
 *
 * Each label is verified by re-reading the named on-chain field and comparing it to the labeled
 * address. H-6 is preserved: a network/RPC error returns `available:false` (leave unverified, retry
 * later) — it never produces a false reject.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import type { Reconciler } from "./reconcile";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
/** Metaplex Token-Metadata program (mainnet) — the owner of every on-chain Metadata account. */
export const TOKEN_METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const METADATA_KEY_V1 = 4; // Metaplex Key::MetadataV1 — the discriminator at data[0] of a Metadata account
export const PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

export interface EvidenceRef {
  kind: string; // account | metadata_account | owner_of
  pubkey: string; // the anchor account the assertion is about
  field: string; // mint_authority | update_authority | creators[N] | "" (self-anchor)
}

/** Parse the authoritative (first) clause of an `evidence_ref` into {kind, pubkey, field}. */
export function parseEvidenceRef(evidenceRef: string): EvidenceRef {
  const clause = evidenceRef.split(";")[0].trim();
  const ci = clause.indexOf(":");
  const kind = ci >= 0 ? clause.slice(0, ci) : "";
  const rest = (ci >= 0 ? clause.slice(ci + 1) : clause).split("@")[0];
  const dot = rest.indexOf(".");
  return { kind, pubkey: dot >= 0 ? rest.slice(0, dot) : rest, field: dot >= 0 ? rest.slice(dot + 1) : "" };
}

/** Minimal Metaplex Token-Metadata decode (updateAuthority + creators) — no external mpl dependency.
 *  Layout: key(1) · updateAuthority(32) · mint(32) · name/symbol/uri (borsh strings) · sellerFee(u16)
 *  · creators Option<Vec<{pubkey(32), verified(1), share(1)}>>. */
export function decodeMetadata(data: Buffer): { updateAuthority: string; creators: string[] } | null {
  try {
    const updateAuthority = new PublicKey(data.subarray(1, 33)).toBase58();
    let o = 65;
    const skipStr = () => { const len = data.readUInt32LE(o); o += 4 + len; };
    skipStr(); skipStr(); skipStr(); // name, symbol, uri
    o += 2; // seller_fee_basis_points
    const some = data.readUInt8(o); o += 1;
    const creators: string[] = [];
    if (some === 1) {
      const n = data.readUInt32LE(o); o += 4;
      for (let i = 0; i < n; i++) { creators.push(new PublicKey(data.subarray(o, o + 32)).toBase58()); o += 34; }
    }
    return { updateAuthority, creators };
  } catch {
    return null; // malformed buffer — DETERMINISTIC; the caller treats this as ok:false, not a retry
  }
}

/** True iff the account is a genuine Metaplex Token-Metadata account (correct owner + V1 key
 *  discriminator). MUST gate any `decodeMetadata` call — otherwise arbitrary account bytes pointed at
 *  by a crafted `metadata_account:` evidence could be coerced into a "valid" updateAuthority/creators
 *  decode and falsely verify a label (the falsifiability seam must not trust unvalidated bytes). */
export function isMetadataAccount(info: { owner: PublicKey; data: Buffer } | null): boolean {
  return !!info && info.owner.toBase58() === TOKEN_METADATA_PROGRAM && info.data.length > 0 && info.data[0] === METADATA_KEY_V1;
}

/** The on-chain authority to compare for a `.mint_authority` / `.freeze_authority` assertion — the
 *  EXACT field the evidence names, never an OR of both (a freeze-only match must not satisfy a
 *  `mint_authority` claim, and vice-versa). */
export function authorityFieldValue(field: string, info: { mintAuthority?: string | null; freezeAuthority?: string | null }): string | null | undefined {
  return field === "freeze_authority" ? info.freezeAuthority : info.mintAuthority;
}

/** True iff `address` satisfies a `creators` / `creators[N]` assertion. An INDEXED claim (`creators[0]`)
 *  must match THAT exact position — `.includes` would accept any creator and weaken the assertion. A
 *  bare `creators` (no index) falls back to membership. */
export function creatorAssertionHolds(field: string, creators: string[], address: string): boolean {
  const m = field.match(/^creators\[(\d+)\]$/);
  return m ? creators[Number(m[1])] === address : creators.includes(address);
}

/**
 * A `Reconciler` that re-derives a chain-derived label against CURRENT Solana chain state via a public
 * RPC endpoint (no Helius). It answers "does this label STILL hold?", not "did it hold at the evidence
 * slot": the `@slot:N` in an `evidence_ref` is observation provenance, and a public RPC has no archival
 * read — a role that has since changed therefore (correctly) fails reconcile and is retired by the
 * validity-window / staleness path (`closeStaleLabels`), not silently re-confirmed here. Only `solana`
 * rows are handled (any other chain → REJECT). `available:false` is returned SOLELY on a transient
 * RPC/network error (H-6, the worker retries); every deterministic outcome is `ok:false`.
 */
export function makePublicRpcReconciler(rpcUrl: string = PUBLIC_MAINNET_RPC): Reconciler {
  const conn = new Connection(rpcUrl, "confirmed");
  // Wrap ONLY the network read. A transient RPC/network failure is the single retryable case
  // (available:false, H-6). Every deterministic outcome — malformed evidence, a non-metadata account,
  // a bad decode, or a plain mismatch — is `available:true, ok:false`, so reconcileQueueWorker charges
  // an attempt and eventually seals it `unverified_permanent` instead of retrying a dead row forever.
  const net = async <T>(fn: () => Promise<T>): Promise<{ up: true; v: T } | { up: false }> => {
    try { return { up: true, v: await fn() }; } catch { return { up: false }; }
  };
  const RETRY = { available: false, ok: false } as const; // transient RPC failure — worker retries (H-6)
  const REJECT = { available: true, ok: false } as const; // deterministic: malformed/mismatched/no-match

  return async (row) => {
    if (row.chain !== "solana") return REJECT; // this reconciler re-derives against Solana RPC only
    const { kind, pubkey, field } = parseEvidenceRef(row.evidenceRef);
    let pk: PublicKey;
    try { pk = new PublicKey(pubkey); } catch { return REJECT; } // malformed anchor

    // ── field assertions: the evidence `kind` MUST be consistent with the named field ──
    if (field === "mint_authority" || field === "freeze_authority") {
      if (kind !== "account") return REJECT; // a mint/freeze authority is asserted on an `account:` mint
      const r = await net(() => conn.getParsedAccountInfo(pk));
      if (!r.up) return RETRY;
      const m = (r.v.value?.data as { parsed?: { info?: { mintAuthority?: string | null; freezeAuthority?: string | null } } })?.parsed?.info;
      return { available: true, ok: !!m && authorityFieldValue(field, m) === row.address };
    }
    if (field === "update_authority" || /^creators(\[\d+\])?$/.test(field)) {
      if (kind !== "metadata_account") return REJECT; // these fields live on a `metadata_account:`
      const r = await net(() => conn.getAccountInfo(pk));
      if (!r.up) return RETRY;
      if (!isMetadataAccount(r.v)) return REJECT;
      const md = decodeMetadata(r.v!.data);
      if (!md) return REJECT;
      const ok = field === "update_authority" ? md.updateAuthority === row.address : creatorAssertionHolds(field, md.creators, row.address);
      return { available: true, ok };
    }
    if (field !== "") return REJECT; // any other named field is unrecognized

    // ── no field: ownership / structural self-anchors, dispatched strictly by kind ──
    if (kind === "owner_of") {
      const r = await net(() => conn.getAccountInfo(pk));
      if (!r.up) return RETRY;
      return { available: true, ok: r.v?.owner.toBase58() === row.address };
    }
    if (kind === "account") {
      const r = await net(() => conn.getAccountInfo(pk));
      if (!r.up) return RETRY;
      if (!r.v) return REJECT;
      const pr = await net(() => conn.getParsedAccountInfo(pk));
      if (!pr.up) return RETRY;
      const t = (pr.v.value?.data as { parsed?: { type?: string } })?.parsed?.type;
      return { available: true, ok: row.address === pubkey && (t === "mint" || r.v.owner.toBase58() !== SYSTEM_PROGRAM) };
    }
    if (kind === "metadata_account") {
      const r = await net(() => conn.getAccountInfo(pk));
      if (!r.up) return RETRY;
      return { available: true, ok: row.address === pubkey && isMetadataAccount(r.v) };
    }
    return REJECT; // unrecognized evidence kind
  };
}
