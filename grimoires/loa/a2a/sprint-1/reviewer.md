# Implementation Report: Sprint 1

**Date:** 2026-07-19
**Engineer:** Run Mode implementer
**Sprint Reference:** `grimoires/loa/sprint.md`
**Beads Epic:** `bd-v54z.15`

## Executive Summary

Sprint 1 ratifies the exact reviewed Sonar→Score plan and implements its
non-production protocol kernel. The result is a strict Effect Schema boundary,
a non-circular signed root over a complete normative closure, reusable RFC
8785/SHA-256/Ed25519 primitives, semantic policy validation, and executable
FR-to-code/test/Beads traceability.

The implementation performs no index, database, registry, deployment, or Score
mutation. The Ethereum floor remains `12287507`; `ENVIO_RESTART` remains unset;
fixture signing is explicitly non-production.

## AC Verification

### Sprint 1 Acceptance Criteria

**AC-1.1**: "A detached promotion receipt records the explicit operator approval, exact document digests, repository identity, base commit, scope, timestamp, and approval source before Task 1.2 starts."

- Status: `✓ Met`
- Evidence: `grimoires/loa/promotion-receipt.sonar-score-v1.json:2` — versioned detached receipt; lines 3–10 bind repository, base commit, timestamp, operator, source, and authorization; lines 11–28 bind scope and exact document digests.
- Test: `test/truth-promotion-gate.test.mjs:74` — valid committed receipt fixture passes.

**AC-1.2**: "The receipt is content-addressed and checked by a gate outside `src/truth-contract/`; changing any approved document invalidates it."

- Status: `✓ Met`
- Evidence: `scripts/verify-truth-promotion.sh:123` — verifies approved files are committed; line 129 parses the pinned SHA-256; lines 132–134 compare actual bytes.
- Test: `test/truth-promotion-gate.test.mjs:112` — document tamper fails closed.

**AC-1.3**: "Until Task 1.1 verifies and commits that receipt, authorization permits Task 1.1 only. Tasks 1.2+ remain mechanically closed. The verifier uses pre-existing SHA-256/JQ tooling and is pinned before truth-contract source code, so the implementation under review cannot redefine its own gate."

- Status: `✓ Met`
- Evidence: `scripts/verify-truth-promotion.sh:96` — requires the receipt base to be an ancestor; line 99 requires the receipt to be tracked and clean; commit `03e0b273` pins the independent gate before any `src/truth-contract/` source.
- Test: `test/truth-promotion-gate.test.mjs:120` — even an empty `ENVIO_RESTART` invalidates authorization; `scripts/verify-truth-promotion.sh:151` emits implementation-only authority and line 152 explicitly denies production authority.

**AC-1.4**: "External values strict-decode through Effect Schema; excess properties, unsafe integers, and over-limit resources fail with typed errors."

- Status: `✓ Met`
- Evidence: `src/truth-contract/schemas/common.ts:21` — excess-property strict decoding; line 29 defines canonical decimal uint64; line 94 exposes the typed decode boundary; `src/truth-contract/errors.ts:10` defines the typed decode error.
- Test: `test/truth-contract.schemas.test.ts:33` — safe/unsafe integer boundaries; line 50 rejects excess status fields; line 72 rejects over-limit bytes.

**AC-1.5**: "Sonar and the generated consumer surface share byte-identical RFC 8785 JCS, SHA-256, and Ed25519 vectors."

- Status: `✓ Met`
- Evidence: `test/fixtures/truth-contract/golden-root-v1.json:2` — consumer-neutral golden vector pins canonical JSON, SHA-256, domain bytes, public key, root hash, and signature; `src/truth-contract/canonical.ts:28` and `src/truth-contract/crypto.ts:17` are the shared producer/verifier surface over the vendored primitives.
- Test: `test/truth-contract.bundle.test.ts:68` — wrapper and vendored JCS bytes/hash agree; line 77 verifies exact root hash, public key, signing-domain bytes, signature, and consumer verification.

**AC-1.6**: "Circular/self-hash, Unicode, wrong environment, tamper, `2^53`, uint64, replay, and signature-negative fixtures pass."

- Status: `✓ Met`
- Evidence: `src/truth-contract/bundle-compiler.ts:106` — compiler excludes the digest from the unsigned schema and rejects cycles before decode; line 161 verifies environment, minimum generation, hash, issuer, and signature.
- Test: `test/truth-contract.bundle.test.ts:68` — Unicode/order; line 97 circular/self-hash; line 137 tamper/environment/replay/signature negatives; `test/truth-contract.schemas.test.ts:33` covers `2^53` and uint64 boundaries.

**AC-1.7**: "Every FR-1 through FR-13 maps to a planned module, test, and Beads owner."

- Status: `✓ Met`
- Evidence: `src/truth-contract/traceability.ts:13` — executable mappings explicitly distinguish implemented from planned FRs; `scripts/verify-truth-traceability.ts:18` resolves Beads owners and implemented files before PASS.
- Test: `test/truth-contract.normative.test.ts:285` — traceability gate passes and every owner is a Beads ID.

### Plan-Level Scope Ledger

The repository validator scans the complete five-sprint plan rather than the
active sprint section. The following verbatim prefixes are therefore walked
without a `Met`, `Partial`, or `Deferred` claim. They remain open acceptance
criteria owned by the named future sprint epics; this ledger does not approve
or defer them.

Sprint 2 (`bd-v54z.16`):

- Genesis uses generation `"1"` with atomic create-if-absent; exactly one of
- Every later generation is exactly prior + 1 and exposes one complete
- The filesystem adapter refuses unsupported/network filesystems and proves
- The initial certification candidates are macOS/APFS and Linux/ext4; every target
- Root substitution, rollback, cache loss, partial quorum, and compromised
- A valid emergency revocation suspends affected artifacts immediately;
- Revocation epochs are signed; maximum offline age is 15 minutes in staged
- Freshness across restart binds a signed time checkpoint, wall-clock value,
- Bootstrap channels use independent operator identities and credentials,
- Loss/compromise recovery is a versioned state machine: 2-of-2 normal

Sprint 3 (`bd-v54z.17`):

- 100% of initial admitted EVM collections have canonical identity,
- 100% of initial event kinds declare user meaning, custody/intermediary
- Worst-source aggregation covers `READY`, `DEGRADED`, `NOT_READY`,
- Quiet data requires independent head, cursor, heartbeat, and coverage
- Unlisted networks, correlated provider quorum, incomplete proxy evidence,
- Initial Berachain finality requires the JSON-RPC `finalized` block tag
- Every claim records environment, observation time, finalized block/hash,
- The closed initial set is exactly Berachain `MiberaCollection`

Sprint 4 (`bd-v54z.18`):

- Sampling commits universe, strata, query/adapter digests, algorithm,
- The normative statistical policy versions the population, estimand
- `StatisticalPolicyV1` is frozen before Task 4.2: strata are
- Rare/high-risk strata and any stratum too small to meet the configured
- Any semantic mismatch triggers census; an incomplete census terminates
- Reorg, expiry, revocation, semantic mismatch, and incompatibility traverse
- Every query binds one generation and invalidation epoch and evaluates the
- Graph limits are 10,000 nodes, 50,000 edges, depth 32, fan-out 1,000,
- A normative exhaustive state table covers every local/ancestor state and
- A separately launched staged reconciler uses a different fixture key,
- Replaying signed activation/lifecycle/revocation/invalidation events

Sprint 5 (`bd-v54z.19`):

- Machine-mode CLI requires `--target-state`; exit 0 means that exact target
- Completed invocations always emit valid versioned JSON: exit 1 invalid
- `NotConsumedReceiptV1` requires owner `bd-v54z.1` and deadline
- Score receipts bind target identity, producer generation, invalidation
- Authority-shaped CLI targets are refused with exit 2 unless an independent
- Berachain MiberaCollection
- Wrong bundle/snapshot/version/signature, reorg, expiry, revocation,
- Ethereum floor remains `12287507`, `ENVIO_RESTART` remains unset, and

## Tasks Completed

### Task 1.1 / `bd-v54z.15.1` — Ratification gate

- Added and committed the detached promotion receipt and independent verifier.
- Added four fail-closed Node tests for valid receipt, document tamper,
  `ENVIO_RESTART`, and Ethereum floor drift.
- Pinned in commit `03e0b273` before truth-contract application source.

### Task 1.2 / `bd-v54z.15.2` — Strict schema kernel

- Added branded decimal uint64, SHA-256, identifiers, timestamps, UTF-8 bounded
  text, object references, resource ceilings, and strict decode helpers.
- Added typed Effect failures, lifecycle/status variants, and focused service
  tags for registry, signer, clock, source evidence, and revocation.
- Added `tsconfig.truth-contract.json` to isolate protocol type safety from
  absent Envio-generated modules in the wider checkout.

### Task 1.3 / `bd-v54z.15.3` — Canonical signed root

- Added separate unsigned/signed root schemas and a complete 12-kind manifest.
- Added deterministic canonical compilation, authority/security root pins,
  exact domain-separated Ed25519 signing, replay/environment/issuer checks,
  byte/closure bounds, and strict consumer verification.
- Added a committed cross-consumer golden vector with positive and negative
  cryptographic fixtures.

### Task 1.4 / `bd-v54z.15.4` — Normative objects and traceability

- Added versioned bundle, identity, event, provenance, invariant,
  compatibility, authority, security, network/finality, activity, serving, and
  issuer schemas.
- Added semantic checks for total matrices, unique events/actions, provenance
  agreement, independent provider quorum, activity windows, and closed bytes.
- Added an executable FR-1–FR-13 traceability command and Beads ownership.

## Technical Highlights

- **Architecture:** producer compile and consumer verify share one strict schema,
  canonicalization, digest, and signature implementation.
- **Security:** the root digest is outside its own preimage; signature bytes bind
  protocol, environment, generation, and hash with NUL delimiters.
- **Availability:** byte, object, closure, text, and depth limits fail before
  unbounded trust work; no semantic/trust error is retryable.
- **Governance:** a planning receipt can authorize implementation only. It
  cannot sign, publish, activate, deploy, graduate, or mutate production.

## Testing Summary

| Command | Result |
|---|---|
| `pnpm run test:truth-promotion` | 4/4 passed |
| `pnpm run verify:truth-contract` | isolated typecheck, 20/20 tests, traceability PASS (`implemented:1`, `planned:12`) |
| `pnpm run verify:truth-promotion` | PASS; `production_authority:false` |
| `git diff --check` | PASS |
| production invariant check | PASS; floor `12287507`, `ENVIO_RESTART` unset |

The 20 protocol tests cover the vendored primitive digest pin, strict decoding, all integer boundaries, status
variants, resource limits, canonical bytes, root/signature vectors, closure
completeness, semantic-policy totals, tamper, environment, replay, issuer,
signature, invalid JSON, and traceability.

## Known Limitations

- Repository-wide `tsc --noEmit` is not a valid green signal in this worktree:
  Envio-generated modules and several existing dependency types are absent or
  skewed. `tsconfig.truth-contract.json` isolates and passes the new module;
  the pre-existing whole-repo failures were not changed.
- This sprint compiles and verifies hermetic objects only. Filesystem
  publication, trust bootstrap/revocation, live producer evidence,
  reconciliation, Score receipts, and agent CLI execution are owned by Sprints
  2–5.
- The committed Ed25519 key is a public fixture vector; no production private
  key, trust root, write URL, or registry credential is present.

### Explicit Review Assumptions and Tradeoffs

1. `src/truth-contract/bundle-compiler.ts:276` is the external byte-verification
   boundary; callers with wire bytes must not bypass it for the already-parsed
   object verifier. This keeps the internal API composable while preserving
   byte/canonical-JSON limits at ingress.
2. `tsconfig.truth-contract.json:1` is intentionally narrower than the current
   repository compiler because Envio code generation is unavailable in this
   worktree. The risk is visible in this report and does not convert the wider
   baseline into a green claim.
3. `src/truth-contract/traceability.ts:15` marks only FR-1 implemented. FR-2
   through FR-13 are explicitly planned and their absent future files cannot
   satisfy the executable gate.

**Assumption challenged:** Score will consume
`test/fixtures/truth-contract/golden-root-v1.json:2` and the shared verifier
surface instead of creating a second JCS/crypto implementation. Divergence
would invalidate byte parity; Sprint 5 must execute this same vector.

**Alternative considered:** publish a separate consumer package now. The
shared module is smaller and prevents premature duplication; the generated
receipt package remains owned by Sprint 5 after its tagged-union contract
exists.

## Verification Steps for Reviewer

1. Run `pnpm run verify:truth-promotion`.
2. Run `pnpm run test:truth-promotion`.
3. Run `pnpm run verify:truth-contract`.
4. Review `src/truth-contract/` against SDD §5.1 and §7.1.3.
5. Confirm `config.yaml` Ethereum `start_block` is `12287507` and
   `ENVIO_RESTART` is absent.
6. Confirm the diff contains no production publication, signing, deployment,
   database, or index mutation.

## Feedback Addressed

- **DISS-001:** Traceability now carries explicit `implemented`/`planned`
  states; the executable command resolves every Beads owner and requires files
  for implemented entries (`scripts/verify-truth-traceability.ts:18`).
- **DISS-002:** Provider independence now computes a bipartite matching between
  operator and control-domain identities, proving a jointly satisfiable quorum
  (`src/truth-contract/normative-compiler.ts:68`), with the overlapping-pairs
  counterexample fixed by a negative fixture.
- **DISS-003:** Identity snapshots reject conflicting canonical IDs, deployed
  identity tuples, and aliases; activity cadence/denominator fields are
  positive uint64 values; every effective status requires expiry strictly after
  evaluation.
- **Security dissent sidecar:** verification now requires a trusted generation
  high-water mark and injected current time; rollback and roots beyond the
  fixed 60-second future-skew budget fail closed.
