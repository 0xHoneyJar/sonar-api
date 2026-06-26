/**
 * label-sign.mjs — v1 operator signing surface (SDD §5, T3.1, SP-4).
 *
 * Signs an operator-attested label claim with a LOCAL Ed25519 private key. The private key NEVER leaves
 * the operator's machine and is NEVER committed or stored in the DB — only its public half is registered
 * in label.signer_key. Output {signature, signing_key_id} is what you put on the label row; the ingestion
 * seam verifies it against the registered public key before accepting (signature_valid).
 *
 * Generate a keypair (one-time, local):
 *   openssl genpkey -algorithm ed25519 -out label-signer.pem
 *   # register the PUBLIC key:  node scripts/label-sign.mjs --pubkey label-signer.pem  → base64 DER for signer_key
 *
 * Sign a label:
 *   node scripts/label-sign.mjs --key-file label-signer.pem --key-id ops-1 --label label.json
 *   # label.json = {chain,address,collectionScope,entity,label,entityType,evidenceRef}
 */
import { readFileSync } from "node:fs";
import { sign as edSign, createPublicKey, createPrivateKey } from "node:crypto";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
// NEW-6: accept BOTH the extraction-row (snake_case) and LabelInput (camelCase) field names so the signed
// payload byte-matches what the seam's signingPayload() computes from the mapped LabelInput.
function signingPayload(r) {
  return JSON.stringify([
    r.chain,
    r.address,
    r.collectionScope ?? r.collection ?? null,
    r.entity ?? r.label,
    r.label,
    r.entityType ?? r.entity_type,
    r.evidenceRef ?? r.evidence_ref,
  ]);
}

const pubFile = arg("--pubkey");
if (pubFile) {
  // emit the base64 DER (SPKI) public key to register in label.signer_key
  const pub = createPublicKey(readFileSync(pubFile, "utf8"));
  process.stdout.write(pub.export({ type: "spki", format: "der" }).toString("base64") + "\n");
  process.exit(0);
}

const keyFile = arg("--key-file");
const keyId = arg("--key-id");
const labelFile = arg("--label");
if (!keyFile || !keyId || !labelFile) {
  console.error("usage: label-sign.mjs --key-file <ed25519.pem> --key-id <id> --label <label.json>  (or --pubkey <pem>)");
  process.exit(2);
}
const row = JSON.parse(readFileSync(labelFile, "utf8"));
const need = {
  chain: row.chain,
  address: row.address,
  label: row.label,
  entityType: row.entityType ?? row.entity_type,
  evidenceRef: row.evidenceRef ?? row.evidence_ref,
};
for (const [f, v] of Object.entries(need)) {
  if (!v) {
    console.error(`label.json missing required field: ${f} (snake_case or camelCase accepted)`);
    process.exit(2);
  }
}
const priv = createPrivateKey(readFileSync(keyFile, "utf8"));
const signature = edSign(null, Buffer.from(signingPayload(row)), priv).toString("base64");
process.stdout.write(JSON.stringify({ signature, signing_key_id: keyId }) + "\n");
