/**
 * id.ts — content-addressed identity for an L2 entity-label row (SDD §2.1, DH-2).
 *
 * The natural key is a FIXED-ORDER tuple of primitives (strings + null). Encoding it as a JSON array
 * and hashing the JSON text is canonical for this shape — fixed field order, standard string escaping,
 * and `null` distinct from `""` — which eliminates the delimiter ambiguity a raw `chain ‖ address ‖ …`
 * concatenation would have (FAGAN SKP-003: `('sol','ana…')` vs `('solana',…)`). Full RFC-8785 JCS is
 * unnecessary here because the tuple contains no numbers/objects/key-ordering — a JSON array of
 * strings|null is already byte-deterministic. sha256 → lowercase hex.
 *
 * `validity_from` is deliberately NOT part of the key (FAGAN M4): it defaults to wall-clock now() and
 * would make every re-ingest mint a new id → duplicate rows. `evidence_ref` is the real disambiguator —
 * a re-derivation at a later time carries NEW evidence (a new tx/account) → a new id → a new window;
 * re-ingesting the SAME evidence is idempotent (same id → no-op upsert). validity_from/_to are metadata.
 */
import { createHash } from "node:crypto";

export interface LabelKey {
  chain: string; // "solana" | "ethereum" | …
  address: string;
  collectionScope: string | null; // null = global (cex/bridge); else community/collection id
  entityType: string;
  method: string;
  evidenceRef: string; // tx sig / account — the on-chain/operator evidence (the disambiguator)
}

/** The canonical key tuple (fixed order — never reorder; order is part of the contract). */
export function labelKeyTuple(k: LabelKey): (string | null)[] {
  return [k.chain, k.address, k.collectionScope, k.entityType, k.method, k.evidenceRef];
}

/** Content-addressed row id. Idempotent: identical keys → identical id (re-ingest is a no-op upsert). */
export function labelId(k: LabelKey): string {
  return createHash("sha256").update(JSON.stringify(labelKeyTuple(k))).digest("hex");
}
