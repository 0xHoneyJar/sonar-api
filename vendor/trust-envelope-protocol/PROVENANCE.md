# Vendored `@freeside/trust-envelope-protocol` (CR-011A temporary seam)

This directory holds a **packaged artifact produced exactly from the CR-009
package** via `pnpm pack`. Sonar must not fork or hand-copy envelope schemas.

## Artifact

- File: `freeside-trust-envelope-protocol-1.0.0.tgz`
- Package: `@freeside/trust-envelope-protocol@1.0.0`
- SHA-256: `9bd6a868c3315650109d4ce9c57ad0b904d2a7b04d710350ec3fb40ad3700cf3` (also in `SHA256SUMS`)
- Source worktree: `loa-freeside/packages/protocol/trust-envelope`
- Source commit (at pack time): `d0e06a9bb3ffc7efe86c85d144222b585f329833`
- Packed at: `2026-07-17T21:50:00Z`

The executable digest is also pinned independently in
`src/collection-resolver/trust-protocol.ts`; updating `SHA256SUMS` alone cannot
make replacement bytes pass verification.

## Refresh

From loa-freeside trust-envelope package:

```bash
LOA_PKG=/path/to/loa-freeside/packages/protocol/trust-envelope
VENDOR=$PWD/vendor/trust-envelope-protocol
(cd "$LOA_PKG" && pnpm exec tsc -b && pnpm pack --pack-destination "$VENDOR")
cd "$VENDOR"
shasum -a 256 *.tgz | tee SHA256SUMS
# Update PROVENANCE.md commit SHA and trust-protocol.ts pin
```

## Replacement

When CR-009 publishes to a registry/workspace pin, replace this vendored tarball
with the ratified semver pin. Production signing-key custody remains CR-013.
