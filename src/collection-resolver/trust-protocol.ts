/**
 * Thin CR-009 adapter surface.
 *
 * Re-exports the shared trust-envelope wire contract. Do not redefine schemas
 * here — see SEAM.md.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect } from "effect";

export {
  TRUST_ENVELOPE_SCHEMA_MAJOR,
  TRUST_ENVELOPE_SCHEMA_MINOR,
  TRUST_ENVELOPE_PROTOCOL_VERSION,
  TRUST_ENVELOPE_CONTRACT,
  TRUST_ENVELOPE_MAX_FUTURE_SKEW_MS,
  TRUST_STREAM_MIN_RETENTION_MS,
  TRUST_ENVELOPE_DEFAULT_TTL_MS,
  ContractIntegrityError,
  TrustEnvelopeRejectedError,
  StreamEpochBaselineRejectedError,
  TrustContractRef,
  TrustEnvelopeHeader,
  TrustEnvelope,
  StreamEpochBaseline,
  ServiceSigningKey,
  FixtureKeyRegistry,
  decodeTrustEnvelope,
  decodeStreamEpochBaseline,
  decodeFixtureKeyRegistry,
  supportedSchemaMinor,
  strictDecodeOptions,
  acceptsEnvelopeSchemaMinor,
  assertSupportedSchemaMajor,
  assertSupportedSchemaMinor,
  mixedMinorRules,
  jcsCanonicalize,
  sha256Hex,
  digestJcs,
  computeBodyDigest,
  envelopeSigningBytes,
  baselineSigningBytes,
  verifyEd25519Signature,
  signTrustEnvelope,
  signStreamEpochBaseline,
  digestEpochBaselineMaterial,
  LocalEd25519TrustSigner,
  ServiceKeyRegistry,
  verifyTrustEnvelope,
  verifyStreamEpochBaseline,
  resolveActiveKey,
  buildTrustEnvelopeHeader,
  emitTrustEnvelope,
  createTrustStreamProducerState,
  advanceTrustStreamProducer,
  resetTrustStreamEpoch,
  createStreamConsumerState,
  ingestTrustEnvelope,
  installEpochBaseline,
  requestGapRepairRange,
  replayEnvelopeIdempotently,
  FIXTURE_SIGNING_SEEDS,
  FIXTURE_SIGNING_KEY_IDS,
  FIXTURE_STREAM_ID,
  FIXTURE_TENANT_SCOPE_DIGEST,
  FIXTURE_CAPABILITY,
  fixtureSigners,
  fixturePublicKeys,
  decodeFixtureScenarioBundle,
  fixtureRegistryFromBundle,
  type TrustEnvelopeSigner,
  type TrustStreamProducerState,
  type StreamConsumerState,
  type IngestTrustEnvelopeResult,
  type FixtureScenarioBundle,
} from "@freeside/trust-envelope-protocol";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** Independent executable pin: changing vendor bytes requires a reviewed code change. */
export const EXPECTED_TRUST_ENVELOPE_PROTOCOL_TARBALL_SHA256 =
  "9bd6a868c3315650109d4ce9c57ad0b904d2a7b04d710350ec3fb40ad3700cf3";

export class VendoredTrustProtocolDigestError extends Data.TaggedError(
  "VendoredTrustProtocolDigestError",
)<{
  readonly stage: "read_pin" | "validate_pin" | "read_tarball" | "compare_digest";
  readonly reason: string;
}> {}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Verify the executable vendored package bytes against the committed pin. */
export const verifyVendoredTrustEnvelopeProtocolDigest = Effect.fn(
  "verifyVendoredTrustEnvelopeProtocolDigest",
)(function* (root = process.cwd()) {
  const vendor = join(root, "vendor/trust-envelope-protocol");
  const tarball = "freeside-trust-envelope-protocol-1.0.0.tgz";
  const checksumFile = yield* Effect.try({
    try: () => readFileSync(join(vendor, "SHA256SUMS"), "utf8"),
    catch: (cause) =>
      new VendoredTrustProtocolDigestError({ stage: "read_pin", reason: errorMessage(cause) }),
  });
  const checksumLine = checksumFile.trim();
  const checksumMatch = /^([0-9a-f]{64}) {2}freeside-trust-envelope-protocol-1\.0\.0\.tgz$/.exec(
    checksumLine,
  );
  const checksum = checksumMatch?.[1];
  if (checksum === undefined) {
    return yield* new VendoredTrustProtocolDigestError({
      stage: "validate_pin",
      reason:
        "invalid vendored trust-envelope protocol SHA256SUMS pin: expected exactly one sha256sum line for freeside-trust-envelope-protocol-1.0.0.tgz",
    });
  }
  if (checksum !== EXPECTED_TRUST_ENVELOPE_PROTOCOL_TARBALL_SHA256) {
    return yield* new VendoredTrustProtocolDigestError({
      stage: "validate_pin",
      reason:
        "vendored trust-envelope protocol SHA256SUMS does not match the independently reviewed executable pin",
    });
  }
  const actual = yield* Effect.try({
    try: () =>
      createHash("sha256")
        .update(Uint8Array.from(readFileSync(join(vendor, tarball))))
        .digest("hex"),
    catch: (cause) =>
      new VendoredTrustProtocolDigestError({ stage: "read_tarball", reason: errorMessage(cause) }),
  });
  if (actual !== checksum) {
    return yield* new VendoredTrustProtocolDigestError({
      stage: "compare_digest",
      reason: `vendored trust-envelope protocol digest mismatch: expected ${checksum}, got ${actual}`,
    });
  }
  return { expected: checksum, actual };
});

/** Absolute path to CR-009 shared fixture scenarios. */
export function trustEnvelopeFixturesRoot(): string {
  const candidates: string[] = [];

  try {
    const packageJson = require.resolve("@freeside/trust-envelope-protocol/package.json");
    candidates.push(join(dirname(packageJson), "fixtures"));
  } catch {
    // package.json may be blocked by exports; fall through to path search.
  }

  const searchRoots = require.resolve.paths("@freeside/trust-envelope-protocol") ?? [];
  for (const root of searchRoots) {
    candidates.push(join(root, "@freeside/trust-envelope-protocol/fixtures"));
  }

  candidates.push(
    join(here, "../../node_modules/@freeside/trust-envelope-protocol/fixtures"),
    join(process.cwd(), "node_modules/@freeside/trust-envelope-protocol/fixtures"),
  );

  for (const fixtures of candidates) {
    if (existsSync(fixtures)) return fixtures;
  }

  throw new Error(
    "CR-009 @freeside/trust-envelope-protocol fixtures not found; see src/collection-resolver/SEAM.md and vendor/trust-envelope-protocol/PROVENANCE.md",
  );
}
