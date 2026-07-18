import { Effect, Schema } from "effect";
import type { ParseOptions } from "effect/SchemaAST";

import { CollectionDeploymentRef, NetworkRef } from "../collection-resolver/protocol.js";

const strict: ParseOptions = { errors: "all", onExcessProperty: "error" };
const NonEmptyString = Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(256));

export const KitchenTokenStandard = Schema.Literal(
  "erc721",
  "erc1155",
  "metaplex_collection",
  "programmable_nft",
  "compressed_nft",
);

export const CanonicalPreparationRequestSchema = Schema.Struct({
  schema_version: Schema.Literal(1),
  network: NetworkRef,
  address: NonEmptyString,
  token_standard: KitchenTokenStandard,
  correlation: Schema.optional(
    Schema.Struct({
      source: NonEmptyString,
      correlation_id: NonEmptyString,
    }),
  ),
});

export const LegacyIngestRequestSchema = Schema.Struct({
  order_id: NonEmptyString,
  source: NonEmptyString,
  contact_email: Schema.optional(NonEmptyString),
  community_name: Schema.optional(NonEmptyString),
});

export const CanonicalPreparationResponseSchema = Schema.Struct({
  schema_version: Schema.Literal(1),
  physical_job_id: NonEmptyString,
  deployment: CollectionDeploymentRef,
  capability: Schema.Struct({
    capability_id: Schema.Literal("ownership_index.v1"),
    capability_version: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
    token_standard: KitchenTokenStandard,
    prepare_adapter_id: Schema.Literal("belt.eth-erc721", "belt.evm-erc721", "unsupported"),
    prepare_adapter_version: NonEmptyString,
    source_sequence: Schema.String.pipe(Schema.pattern(/^(0|[1-9][0-9]*)$/)),
    finality_policy_version: NonEmptyString,
  }),
  status: Schema.Literal("queued", "indexing", "completed", "failed"),
  attempt: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
  error: Schema.optional(Schema.Struct({ code: NonEmptyString, message: Schema.String })),
  created_at: NonEmptyString,
  updated_at: NonEmptyString,
});

/** Batch admit — one request, many physical jobs (still one job per deployment). */
export const BATCH_PREPARATION_MAX_ITEMS = 50;

export const BatchPreparationItemSchema = Schema.Struct({
  network: NetworkRef,
  address: NonEmptyString,
  token_standard: KitchenTokenStandard,
  correlation: Schema.optional(
    Schema.Struct({
      source: NonEmptyString,
      correlation_id: NonEmptyString,
    }),
  ),
});

export const BatchPreparationRequestSchema = Schema.Struct({
  schema_version: Schema.Literal(1),
  items: Schema.Array(BatchPreparationItemSchema).pipe(
    Schema.minItems(1),
    Schema.maxItems(BATCH_PREPARATION_MAX_ITEMS),
  ),
  correlation: Schema.optional(
    Schema.Struct({
      source: NonEmptyString,
      correlation_id: NonEmptyString,
    }),
  ),
});

const decodeCanonical = Schema.decodeUnknown(CanonicalPreparationRequestSchema, strict);
const decodeCanonicalResponse = Schema.decodeUnknown(CanonicalPreparationResponseSchema, strict);
const decodeBatch = Schema.decodeUnknown(BatchPreparationRequestSchema, strict);
// Legacy v1 historically ignored excess properties; preserve that behavior
// while moving the known fields onto a typed Effect boundary.
const decodeLegacy = Schema.decodeUnknown(LegacyIngestRequestSchema, {
  errors: "all",
  onExcessProperty: "ignore",
});

const normalizeLegacyOptionalFields = (raw: unknown): unknown => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const normalized = { ...(raw as Record<string, unknown>) };
  for (const key of ["contact_email", "community_name"] as const) {
    const value = normalized[key];
    if (value === null || (typeof value === "string" && value.trim() === "")) {
      delete normalized[key];
    }
  }
  return normalized;
};

export async function decodeCanonicalPreparationRequest(raw: unknown) {
  return Effect.runPromise(decodeCanonical(raw));
}

export async function decodeLegacyIngestRequest(raw: unknown) {
  return Effect.runPromise(decodeLegacy(normalizeLegacyOptionalFields(raw)));
}

export async function decodeCanonicalPreparationResponse(raw: unknown) {
  return Effect.runPromise(decodeCanonicalResponse(raw));
}

export async function decodeBatchPreparationRequest(raw: unknown) {
  return Effect.runPromise(decodeBatch(raw));
}
