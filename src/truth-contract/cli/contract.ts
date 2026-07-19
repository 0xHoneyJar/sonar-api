import { z } from "incur";

import type {
  SonarTruthStatusV1,
  TruthArtifactExplanationV1,
  TruthRebuildResultV1,
} from "../status-reader.js";
import type {
  SonarTruthTargetState,
  TruthInspectionArtifactV1,
} from "../schemas/inspection.js";

export const SONAR_TRUTH_CLI_PROTOCOL = "sonar-truth-cli/v1" as const;
export const SONAR_TRUTH_COMMANDS = [
  "status",
  "verify",
  "explain",
  "dependencies",
  "rebuild-status",
] as const;
export type SonarTruthCommand = (typeof SONAR_TRUTH_COMMANDS)[number];

export const SONAR_TRUTH_EXIT_CODES = [0, 1, 2, 3, 4, 5, 6] as const;
export type SonarTruthExitCode = (typeof SONAR_TRUTH_EXIT_CODES)[number];

export const SONAR_TRUTH_OPERATION_MILLISECONDS = 2_000;
export const SONAR_TRUTH_MAX_INPUT_BYTES = 256 * 1024;
export const SONAR_TRUTH_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type SonarTruthStatusOutputV1 = SonarTruthStatusV1 & {
  readonly cache_age_seconds: string;
};

export type SonarTruthResult =
  | SonarTruthStatusOutputV1
  | { readonly root_hash: string; readonly verified: true }
  | TruthArtifactExplanationV1
  | readonly TruthInspectionArtifactV1[]
  | TruthRebuildResultV1
  | null;

export interface SonarTruthFindingV1 {
  readonly code: string;
  readonly owner: string | null;
  readonly deadline: string | null;
}

export interface SonarTruthEnvelopeV1 {
  readonly schema_version: 1;
  readonly protocol: typeof SONAR_TRUTH_CLI_PROTOCOL;
  readonly command: SonarTruthCommand;
  readonly target_state: SonarTruthTargetState | null;
  readonly outcome:
    | "READY"
    | "USAGE"
    | "FINDINGS"
    | "UNSUPPORTED"
    | "TRUST_FAILURE"
    | "TRANSPORT_FAILURE"
    | "INVARIANT_FAILURE";
  readonly exit_code: SonarTruthExitCode;
  readonly production_authority: false;
  readonly data: SonarTruthResult;
  readonly findings: readonly SonarTruthFindingV1[];
}

const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const Timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => new Date(value).toISOString() === value);
const Identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/);
const TargetState = z.enum([
  "produced",
  "reconciled_staged",
  "consumed",
  "live_proven",
  "graduated",
]);

const Artifact = z.strictObject({
  artifact_hash: Digest,
  artifact_kind: Identifier,
  effective_status: z.enum([
    "READY",
    "DEGRADED",
    "EXPIRED",
    "UNKNOWN",
    "NOT_READY",
    "SUSPENDED",
  ]),
  reason_codes: z.array(Identifier).max(128),
  expires_at: Timestamp.nullable(),
  dependencies: z.array(Digest).max(128),
  evidence_refs: z.array(Digest).max(128),
});

const Snapshot = z.strictObject({
  schema_version: z.literal(1),
  environment: z.enum(["development", "staging"]),
  collection_id: Identifier,
  canonical_address: z.string().regex(/^0x[0-9a-f]{40}$/),
  chain_id: z.literal("80094"),
  event_signature: z.literal("Transfer(address,address,uint256)"),
  validity_class: z.literal("STAGED_CURRENT"),
  producer_root_hash: Digest,
  producer_generation: z.literal("1"),
  invalidation_epoch: z.literal("0"),
  identity_snapshot_hash: Digest,
  reconciliation_hash: Digest,
  score_receipt_hash: Digest,
  score_state: z.enum(["NOT_CONSUMED", "NOT_CONSUMED_OVERDUE"]),
  score_owner: z.literal("bd-v54z.1"),
  score_deadline: Timestamp,
  publisher_key_id: Identifier,
  trust_root_generation: z.string().regex(/^[1-9][0-9]*$/),
  revocation_sequence: z.string().regex(/^(0|[1-9][0-9]*)$/),
  cache_kind: z.enum([
    "SIGNED_READ_ONLY_REGISTRY",
    "EXPLICIT_OFFLINE_CACHE",
  ]),
  cached_at: Timestamp,
  authority_validity: z.literal("STAGED_VALID"),
  production_authority: z.literal(false),
  observed_at: Timestamp,
  expires_at: Timestamp,
  artifacts: z.array(Artifact).min(1).max(10_000),
  served_projection_digest: Digest,
  rebuilt_projection_digest: Digest,
});

const Status = z.strictObject({
  target_state: TargetState,
  target_ready: z.boolean(),
  cache_age_seconds: z.string().regex(/^(0|[1-9][0-9]*)$/),
  lifecycle: z.enum(["PRODUCED", "RECONCILED"]),
  display_state: z.enum([
    "PRODUCED_STAGED",
    "RECONCILED_STAGED",
    "NOT_CONSUMED",
    "NOT_CONSUMED_OVERDUE",
  ]),
  effective_status: z.enum(["READY", "NOT_READY", "SUSPENDED", "EXPIRED"]),
  reason_codes: z.array(Identifier).max(128),
  blocking_owner: z.literal("bd-v54z.1").nullable(),
  blocking_deadline: Timestamp.nullable(),
  snapshot: Snapshot,
});

const VerifiedRoot = z.strictObject({
  root_hash: Digest,
  verified: z.literal(true),
});

const Explanation = z.strictObject({
  artifact: Artifact,
  transitive_dependency_count: z.number().int().min(0).max(10_000),
});

const Rebuild = z.strictObject({
  environment: z.enum(["development", "staging"]),
  served_projection_digest: Digest,
  rebuilt_projection_digest: Digest,
  equal: z.boolean(),
});

export const SonarTruthEnvelopeSchema = z.strictObject({
  schema_version: z.literal(1),
  protocol: z.literal(SONAR_TRUTH_CLI_PROTOCOL),
  command: z.enum(SONAR_TRUTH_COMMANDS),
  target_state: TargetState.nullable(),
  outcome: z.enum([
    "READY",
    "USAGE",
    "FINDINGS",
    "UNSUPPORTED",
    "TRUST_FAILURE",
    "TRANSPORT_FAILURE",
    "INVARIANT_FAILURE",
  ]),
  exit_code: z.union(SONAR_TRUTH_EXIT_CODES.map((code) => z.literal(code))),
  production_authority: z.literal(false),
  data: z
    .union([Status, VerifiedRoot, Explanation, z.array(Artifact).max(10_000), Rebuild])
    .nullable(),
  findings: z
    .array(
      z.strictObject({
        code: Identifier,
        owner: Identifier.nullable(),
        deadline: Timestamp.nullable(),
      }),
    )
    .max(128),
}).refine(
  (envelope) => {
    const endToEnd =
      envelope.target_state === "consumed" ||
      envelope.target_state === "live_proven" ||
      envelope.target_state === "graduated";
    if (!endToEnd) return true;
    const statusData =
      envelope.data !== null &&
      !Array.isArray(envelope.data) &&
      "target_ready" in envelope.data
        ? envelope.data
        : null;
    return (
      envelope.exit_code !== 0 &&
      envelope.outcome !== "READY" &&
      (statusData === null || statusData.target_ready === false)
    );
  },
  {
    message:
      "staged inspection cannot emit READY/0 for Score or authority-shaped targets",
  },
);

export const normalizeTargetState = (
  input: unknown,
): SonarTruthTargetState | null => {
  if (typeof input !== "string") return null;
  return TargetState.safeParse(input).success
    ? (input as SonarTruthTargetState)
    : null;
};

export const makeEnvelope = (
  input: SonarTruthEnvelopeV1,
): SonarTruthEnvelopeV1 =>
  SonarTruthEnvelopeSchema.parse(input) as SonarTruthEnvelopeV1;

export const makeBoundaryEnvelope = (
  command: SonarTruthCommand,
  exitCode: Exclude<SonarTruthExitCode, 0>,
  outcome: Exclude<SonarTruthEnvelopeV1["outcome"], "READY">,
  code: string,
  targetState: SonarTruthTargetState | null = null,
): SonarTruthEnvelopeV1 =>
  makeEnvelope({
    schema_version: 1,
    protocol: SONAR_TRUTH_CLI_PROTOCOL,
    command,
    target_state: targetState,
    outcome,
    exit_code: exitCode,
    production_authority: false,
    data: null,
    findings: [{ code, owner: null, deadline: null }],
  });

export const SONAR_TRUTH_ENVIRONMENT_ALLOWLIST = new Set([
  "CI",
  "COLORTERM",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "NODE_ENV",
  "PATH",
  "SHELL",
  "SONAR_TRUTH_PINNED_KEY_ID",
  "SONAR_TRUTH_PINNED_PUBLIC_KEY_HEX",
  "SONAR_TRUTH_PINNED_ENVELOPE_HASH",
  "SONAR_TRUTH_PINNED_TRUST_ROOT_GENERATION",
  "SONAR_TRUTH_PINNED_REVOCATION_SEQUENCE",
  "SONAR_TRUTH_SNAPSHOT_PATH",
  "TERM",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
]);

export const forbiddenCredentialKeys = (
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] =>
  Object.keys(environment)
    .filter((key) => !SONAR_TRUTH_ENVIRONMENT_ALLOWLIST.has(key))
    .sort();

export const scrubProcessEnvironmentForTruthAgent = (): readonly string[] => {
  const removed = forbiddenCredentialKeys(process.env);
  for (const key of removed) delete process.env[key];
  return removed;
};

export const encodedBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
