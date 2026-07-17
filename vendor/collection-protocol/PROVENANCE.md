# Vendored `@freeside/collection-protocol` (CR-003 temporary seam)

This directory holds a **packaged artifact produced exactly from the CR-001
package** via `pnpm pack`. Sonar must not fork or hand-copy schemas.

## Artifact

- File: `freeside-collection-protocol-1.0.0.tgz`
- Package: `@freeside/collection-protocol@1.0.0`
- SHA-256: `b0d0666867988bc67094d9189048f7bca0b89ea1140a7705d6953528f7d5298c` (also in `SHA256SUMS`)
- Source worktree: `../cr-001/packages/protocol/collection` (coordinator layout)
- Source commit (at pack time): `a688e516e886d29a6aaa1c90fa76c80c0a84d8c1`
- Packed at: `2026-07-16T09:58:14Z`
- Reviewable package manifest: `PACKAGE-MANIFEST.json` (source revision,
  tarball digest, package metadata digest, runtime entrypoint digests, and full
  packaged path inventory)

The executable digest is also pinned independently in
`src/collection-resolver/protocol.ts`; updating `SHA256SUMS` alone cannot make
replacement bytes pass verification.

## Refresh

From this CR-003 worktree (with sibling CR-001 checked out only for refresh):

```bash
CR001_PKG=../cr-001/packages/protocol/collection
VENDOR=$PWD/vendor/collection-protocol
(cd "$CR001_PKG" && pnpm exec tsc -b && pnpm pack --pack-destination "$VENDOR")
cd "$VENDOR"
shasum -a 256 *.tgz | tee SHA256SUMS
# Update this PROVENANCE.md commit SHA and package.json if the tarball name changed
```

Then point `package.json` at `file:./vendor/collection-protocol/<tarball>` and
regenerate a frozen-consistent lockfile (`pnpm install`).

Verify checksum before install:

```bash
cd vendor/collection-protocol && shasum -a 256 -c SHA256SUMS
```

## Replacement (CR-005)

CR-005 publishes `@freeside/collection-protocol` and replaces this vendored
tarball with the ratified registry/semver pin. Do not treat this vendor path as
the long-term production seam.
