# Collection protocol package-link seam (CR-003)

Sonar does **not** own or fork the cross-VM collection wire contract.

## Source of truth

- Package: `@freeside/collection-protocol` (CR-001)
- Schemas, digests, and committed fixtures live in that package
- Sonar consumes via exported `decode*` / `make*` Effect APIs only

## Current temporary seam (vendored pack)

Until CR-005 publishes the package, this repo depends on a **deterministic
`pnpm pack` artifact** produced exactly from the CR-001 package and checked into:

```text
vendor/collection-protocol/freeside-collection-protocol-1.0.0.tgz
```

See `vendor/collection-protocol/PROVENANCE.md` and `SHA256SUMS` for refresh
steps and integrity verification. Do not use a sibling `file:../cr-001/...`
path — that is not installable from an isolated checkout.

```text
@freeside/collection-protocol@file:./vendor/collection-protocol/freeside-collection-protocol-1.0.0.tgz
```

## Future production seam (CR-005)

CR-005 publishes `@freeside/collection-protocol` (npm or monorepo workspace)
and replaces this vendored tarball with the ratified semver/registry pin.
Remove the vendor artifact once that pin lands. Do not copy schemas into Sonar.

## Adapter surface in this repo

| Path | Role |
|---|---|
| `src/collection-resolver/protocol.ts` | Thin re-export + fixture-root helper |
| `src/collection-resolver/capability-registry/` | CR-101 versioned mainnet capability registry + Ordering projection |
| `src/collection-resolver/resolve.ts` | Hermetic `resolve-probe` core |
| `src/collection-resolver/das-normalize.ts` | Adapts real `CollectionSnapshot` / `CollectionMember` + shared `toRows`/`NftRow` |
| `src/svm/collection-nft-rows.ts` | Shared persistence projector used by the ownership indexer and DAS normalize |
| `src/svm/nft-collection-source.ts` | DAS seam: `parseAsset` → `CollectionMember` (refuses missing owner) |
| `src/metadata-egress/` | CR-004 sole metadata network boundary (resolver + report workers) |

## Capability registry (CR-101)

- Snapshot identity is `(registry_epoch, registry_sequence)` from CR-001;
  sequence is a decimal-string uint64 (never a JS number). Same-epoch advances
  MUST be contiguous (`current + 1`); see `capability-registry/PROTOCOL.md`.
- Default search selects enabled **healthy** (`state=available`) mainnet recognize
  capabilities; degraded rows require explicit `selectDiagnosticRecognizeNetworks`.
  A network may recognize while `index_support=false`.
- Ordering consumes `projectOrderingCapabilityViews` only — exposes
  `effective_at` / `source_sequence` / `reason_class`; no RPC credentials,
  display/icon, or provenance internals.
- Baseline epoch resets require a signature over the complete baseline
  **binding digest** (predecessor identity + candidate identity + snapshot digest);
  this worktree ships the port + hermetic verifier, not production signing keys.
- Robinhood Chain `eip155:4663` is disabled (or recognize-only in staging
  fixtures) until CR-401. Solana prepare/index awaits CR-402.
  Downstream Ordering/report wiring: CR-103 / CR-104.

Resolver outputs must always strict-decode through CR-001 `CollectionCandidate`
before leaving Sonar. DAS normalize must not invent a parallel member/owner
array or a fake storage row — storage is always `toRows(snapshot, …)`.

Remote token/collection metadata URIs are fetched only via
`createResolverMetadataPort` / `retrieveMetadata` (CR-004). Do not add parallel
`fetch` paths for user- or collection-supplied metadata URLs.
