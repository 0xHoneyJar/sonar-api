/**
 * Thin CR-001 adapter surface.
 *
 * Re-exports the shared wire contract. Do not redefine schemas here — see SEAM.md.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect } from "effect";

export {
  COLLECTION_PROTOCOL_SCHEMA_VERSION,
  COLLECTION_PROTOCOL_VERSION,
  DIGEST_DOMAINS,
  CapabilityRegistryVersion,
  CapabilityRegistryBaseline,
  CAPABILITY_REGISTRY_BASELINE_DIGEST_DOMAIN,
  NetworkRef,
  VersionIdentifier,
  advanceCapabilityRegistryVersion,
  compareCapabilityRegistryVersions,
  decodeCapabilityRegistryBaseline,
  decodeCapabilityRegistryVersion,
  decodeCollectionCandidate,
  decodeCollectionDeploymentRef,
  decodeCollectionIdentifier,
  decodeNetworkRef,
  digestVersioned,
  makeCollectionDeploymentRef,
  makeCollectionIdentity,
  normalizeEvmAddress,
  normalizeSolanaAddress,
  type CollectionCandidate,
  type CollectionDeploymentRef,
  type CollectionIdentifier,
  type Provenance,
  type VersionedDigest,
} from "@freeside/collection-protocol";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
/** Independent executable pin: changing vendor bytes requires a reviewed code change. */
export const EXPECTED_COLLECTION_PROTOCOL_TARBALL_SHA256 =
  "b0d0666867988bc67094d9189048f7bca0b89ea1140a7705d6953528f7d5298c";

export class VendoredProtocolDigestError extends Data.TaggedError(
  "VendoredProtocolDigestError",
)<{
  readonly stage: "read_pin" | "validate_pin" | "read_tarball" | "compare_digest";
  readonly reason: string;
}> {}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Verify the executable vendored package bytes against the committed pin. */
export const verifyVendoredCollectionProtocolDigest = Effect.fn(
  "verifyVendoredCollectionProtocolDigest",
)(function* (root = process.cwd()) {
  const vendor = join(root, "vendor/collection-protocol");
  const tarball = "freeside-collection-protocol-1.0.0.tgz";
  const checksumFile = yield* Effect.try({
    try: () => readFileSync(join(vendor, "SHA256SUMS"), "utf8"),
    catch: (cause) =>
      new VendoredProtocolDigestError({ stage: "read_pin", reason: errorMessage(cause) }),
  });
  const checksumLine = checksumFile.trim();
  const checksumMatch = /^([0-9a-f]{64}) {2}freeside-collection-protocol-1\.0\.0\.tgz$/.exec(
    checksumLine,
  );
  const checksum = checksumMatch?.[1];
  if (checksum === undefined) {
    return yield* new VendoredProtocolDigestError({
      stage: "validate_pin",
      reason:
        "invalid vendored collection protocol SHA256SUMS pin: expected exactly one sha256sum line for freeside-collection-protocol-1.0.0.tgz",
    });
  }
  if (checksum !== EXPECTED_COLLECTION_PROTOCOL_TARBALL_SHA256) {
    return yield* new VendoredProtocolDigestError({
      stage: "validate_pin",
      reason:
        "vendored collection protocol SHA256SUMS does not match the independently reviewed executable pin",
    });
  }
  const actual = yield* Effect.try({
    try: () =>
      createHash("sha256")
        .update(Uint8Array.from(readFileSync(join(vendor, tarball))))
        .digest("hex"),
    catch: (cause) =>
      new VendoredProtocolDigestError({ stage: "read_tarball", reason: errorMessage(cause) }),
  });
  if (actual !== checksum) {
    return yield* new VendoredProtocolDigestError({
      stage: "compare_digest",
      reason: `vendored collection protocol digest mismatch: expected ${checksum}, got ${actual}`,
    });
  }
  return { expected: checksum, actual };
});

/**
 * Absolute path to the CR-001 package fixtures directory (conformance pin).
 * Resolves through Node module paths / package.json location so Vitest/ESM
 * `exports` maps do not block fixture lookup.
 */
export function collectionProtocolFixturesRoot(): string {
  const candidates: string[] = [];

  try {
    const packageJson = require.resolve("@freeside/collection-protocol/package.json");
    candidates.push(join(dirname(packageJson), "fixtures"));
  } catch {
    // package.json may be blocked by exports; fall through to path search.
  }

  const searchRoots = require.resolve.paths("@freeside/collection-protocol") ?? [];
  for (const root of searchRoots) {
    candidates.push(join(root, "@freeside/collection-protocol/fixtures"));
  }

  // Relative walk from this adapter file into node_modules (common in worktrees).
  candidates.push(
    join(here, "../../node_modules/@freeside/collection-protocol/fixtures"),
    join(process.cwd(), "node_modules/@freeside/collection-protocol/fixtures"),
  );

  for (const fixtures of candidates) {
    if (existsSync(fixtures)) return fixtures;
  }

  throw new Error(
    "CR-001 @freeside/collection-protocol fixtures not found; see src/collection-resolver/SEAM.md and vendor/collection-protocol/PROVENANCE.md",
  );
}
