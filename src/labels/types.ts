/**
 * types.ts — shared types for the L2 labeling layer (SDD §2, §3).
 */
export type LabelMethod =
  | "chain-mechanical"
  | "program-metadata"
  | "own-indexed"
  | "external-attested"
  | "operator-attested"
  | "heuristic";

export type LabelStatus = "verified" | "unverified" | "unverified_permanent" | "contested" | "revoked";

export type EntityType =
  | "collection_authority" | "creator" | "royalty_receiver" | "mint_program" | "distributor"
  | "marketplace_escrow" | "team" | "treasury" | "multisig" | "cex" | "bridge" | "holder" | "unknown"
  // migration/upgrade lineage — a predecessor collection mint (e.g. Pikenians → Pythenians burn-to-mint)
  | "predecessor_collection";

/** What a producer hands to the seam. `confidence`/`status`/`validity*`/`signature_valid` are derived. */
export interface LabelInput {
  address: string;
  chain: string;
  collectionScope: string | null;
  entity: string;
  label: string;
  entityType: EntityType;
  method: LabelMethod;
  source?: string | null;
  evidenceRef: string;
  validityFrom?: string; // defaults to now() at upsert
  validityTo?: string | null;
  signature?: string | null;
  signingKeyId?: string | null;
  notes?: string | null;
  // step-populated:
  confidence?: number;
  status?: LabelStatus;
  signatureValid?: boolean | null;
}

/** A pipeline step (SP-1). S3 (signing.ts) / S4 (confidence.ts, reconcile.ts) export their own steps;
 *  `ingest.ts` never imports them — the composition root passes the list. Throw `LabelReject` to drop a row. */
export interface LabelStep {
  name: string;
  apply(row: LabelInput, ctx: StepContext): Promise<LabelInput> | LabelInput;
}

export interface StepContext {
  runSql: RunSql;
  log: (m: string) => void;
}

export class LabelReject extends Error {
  constructor(public reason: "validation" | "bad_signature" | "trigger" | "reconcile", message: string) {
    super(message);
    this.name = "LabelReject";
  }
}

export type RunSql = <T = unknown>(sql: string, readOnly?: boolean) => Promise<T>;

export interface IngestResult {
  accepted: number;
  rejected: { address: string; reason: string; message: string }[];
  ids: string[];
}
