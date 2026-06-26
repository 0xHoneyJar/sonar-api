/**
 * signing.ts — operator-attested signing (SDD §5, FR-3, H-3/H-4, DH-6, SP-4). Ed25519 via node:crypto.
 *
 * Trust model: the PRIVATE key NEVER lives in the repo or DB (SP-4) — it's in the operator's keyring,
 * read locally only by `scripts/label-sign.mjs`. Only PUBLIC keys live in `label.signer_key`. The seam
 * VERIFIES on write (Hasura can't run crypto) and sets `signature_valid`; a label signed by a
 * missing/revoked key, or with a bad signature, is REJECTED (audited as bad_signature, SP-3). Read-time
 * revocation (DH-6) is enforced by the S5 view's signer_key JOIN — this is the write-time floor.
 */
import { sign as edSign, verify as edVerify, createPublicKey, createPrivateKey } from "node:crypto";
import { LabelReject, type LabelInput, type LabelStep, type RunSql } from "./types";

/** Canonical signing payload — the attested claim (fixed-order tuple; JSON text is deterministic here). */
export function signingPayload(row: Pick<LabelInput, "chain" | "address" | "collectionScope" | "entity" | "label" | "entityType" | "evidenceRef">): string {
  return JSON.stringify([row.chain, row.address, row.collectionScope ?? null, row.entity, row.label, row.entityType, row.evidenceRef]);
}

/** Sign with an Ed25519 PEM private key (local-only; used by label-sign.mjs). Returns base64. */
/** utf8 bytes as Uint8Array<ArrayBuffer> — satisfies node:crypto's ArrayBufferView param across @types/node. */
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

export function signPayload(payload: string, privateKeyPem: string): string {
  return edSign(null, bytes(payload), createPrivateKey(privateKeyPem)).toString("base64");
}

/** Verify a base64 Ed25519 signature against a base64 DER (SPKI) public key. Never throws. */
export function verifyPayload(payload: string, signatureB64: string, publicKeyDerB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyDerB64, "base64"), format: "der", type: "spki" });
    return edVerify(null, bytes(payload), key, new Uint8Array(Buffer.from(signatureB64, "base64")));
  } catch {
    return false;
  }
}

export interface SignerKey {
  publicKeyDerB64: string;
  revoked: boolean;
}
export type KeyResolver = (keyId: string) => Promise<SignerKey | null>;

/**
 * The verify-on-write step (T3.2). operator-attested rows must carry a signature + a registered,
 * non-revoked key whose public key verifies the payload → signature_valid=true. Anything else → reject.
 * Non-operator-attested rows pass through untouched. Injected keyResolver keeps it testable (SP-1).
 */
export function makeSigningStep(resolveKey: KeyResolver): LabelStep {
  return {
    name: "signing",
    async apply(row: LabelInput): Promise<LabelInput> {
      if (row.method !== "operator-attested") return row;
      if (!row.signature || !row.signingKeyId) {
        throw new LabelReject("bad_signature", "operator-attested label missing signature/signingKeyId");
      }
      const key = await resolveKey(row.signingKeyId);
      if (!key) throw new LabelReject("bad_signature", `unknown signing key ${row.signingKeyId}`);
      if (key.revoked) throw new LabelReject("bad_signature", `revoked signing key ${row.signingKeyId}`);
      if (!verifyPayload(signingPayload(row), row.signature, key.publicKeyDerB64)) {
        throw new LabelReject("bad_signature", "signature does not verify");
      }
      return { ...row, signatureValid: true, status: row.status ?? "verified" };
    },
  };
}

function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** A KeyResolver backed by run_sql (parses the Hasura run_sql SELECT result shape). */
export function runSqlKeyResolver(runSql: RunSql): KeyResolver {
  return async (keyId) => {
    const d = await runSql<{ result?: string[][] }>(
      `SELECT public_key, (revoked_at IS NOT NULL) AS revoked FROM label.signer_key WHERE key_id = ${sqlStr(keyId)}`,
      true,
    );
    const rows = d.result ?? [];
    if (rows.length < 2) return null; // [0] = column header row
    const [publicKeyDerB64, revoked] = rows[1];
    return { publicKeyDerB64, revoked: revoked === "t" || revoked === "true" };
  };
}

// ── lifecycle helpers (T3.3/T3.4) ────────────────────────────────────────────
export async function registerSignerKey(runSql: RunSql, k: { keyId: string; publicKeyDerB64: string; owner: string }): Promise<void> {
  await runSql(
    `INSERT INTO label.signer_key (key_id, public_key, owner) VALUES (${sqlStr(k.keyId)},${sqlStr(k.publicKeyDerB64)},${sqlStr(k.owner)})
     ON CONFLICT (key_id) DO NOTHING`,
    false,
  );
}
export async function revokeSignerKey(runSql: RunSql, keyId: string): Promise<void> {
  await runSql(`UPDATE label.signer_key SET revoked_at = now() WHERE key_id = ${sqlStr(keyId)} AND revoked_at IS NULL`, false);
}
/** Dispute (T3.4): contested rows drop out of entity_primary (S5). */
export async function setContested(runSql: RunSql, labelId: string): Promise<void> {
  await runSql(`UPDATE label.entity_label SET status = 'contested' WHERE id = ${sqlStr(labelId)}`, false);
}
