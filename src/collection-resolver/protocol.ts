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

export {
  COLLECTION_PROTOCOL_SCHEMA_VERSION,
  COLLECTION_PROTOCOL_VERSION,
  DIGEST_DOMAINS,
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
  type NetworkRef,
  type Provenance,
  type VersionedDigest,
} from "@freeside/collection-protocol";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** Verify the executable vendored package bytes against the committed pin. */
export function verifyVendoredCollectionProtocolDigest(
  root = process.cwd(),
): { readonly expected: string; readonly actual: string } {
  const vendor = join(root, "vendor/collection-protocol");
  const tarball = "freeside-collection-protocol-1.0.0.tgz";
  const checksum = readFileSync(join(vendor, "SHA256SUMS"), "utf8")
    .trim()
    .split(/\s+/)[0];
  if (checksum === undefined || !/^[0-9a-f]{64}$/.test(checksum)) {
    throw new Error("invalid vendored collection protocol SHA256SUMS pin");
  }
  const actual = createHash("sha256")
    .update(Uint8Array.from(readFileSync(join(vendor, tarball))))
    .digest("hex");
  if (actual !== checksum) {
    throw new Error(`vendored collection protocol digest mismatch: expected ${checksum}, got ${actual}`);
  }
  return { expected: checksum, actual };
}

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
