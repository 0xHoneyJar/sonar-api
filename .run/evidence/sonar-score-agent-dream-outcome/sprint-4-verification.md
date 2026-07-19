# Sprint 4 Verification Receipt

Timestamp: `2026-07-19T08:38:51Z`
Run: `run-20260718-19763105`
Parent head: `80bc01cd21906607e060cf782e97f046c5c0fb42`

## Outcome

Sprint 4 implements the staged reconciliation, invalidation, recovery, reorg,
and serving-policy lever. The only emitted reconciled generation is
`RECONCILED_STAGED` with `production_authority:false`; no production
consumption, Score graduation, signer activation, deployment, index mutation,
or database mutation is claimed.

## Mechanical Gates

| Gate | Result |
|---|---|
| `pnpm run verify:truth-reconciliation` | PASS; 3 suites / 27 tests |
| `pnpm run verify:truth-contract` | PASS; 9 suites / 65 tests |
| `pnpm run verify:truth-registry` | PASS; 5 suites / 50 tests |
| `pnpm run test:capability-registry` | PASS; 35 tests |
| `pnpm exec vitest run test/promotion-gate.test.ts` | PASS; 59 tests |
| `pnpm run test:truth-promotion` | PASS; 4 tests |
| `pnpm run verify:truth-promotion` | PASS; `production_authority:false` |
| truth traceability | PASS; 13 requirements, 7 implemented, 6 planned |
| `git diff --check` | PASS |
| acceptance audit | APPROVED; no actionable findings |
| crypto/property audit | APPROVED; no actionable findings |
| final code review | APPROVED; 0 Critical / 0 Major / 0 Minor |

## Fail-Closed Proofs

- Sampling targets use exact-integer hypergeometric calculations, finite
  population correction, one-sided power, and frozen golden vectors.
- The producer-signed statistical policy authorizes the exact snapshot,
  universe digest and size, mandatory strata, and complete stratum membership
  digests. Staged reconciliation recomputes that authorization.
- Randomness scope equals the immutable producer generation round. A
  deterministic Ed25519 proof fixes the beacon; deletion can only reproduce
  the same value, and alternate-scope-first issuance is refused.
- The witness journal and its parent require absolute, owned, non-symlink,
  non-group/world-writable real directories. Producer, reconciler, witness,
  reviewer, governance, recovery, and revocation principals remain separate.
- Reconciliation freezes all 12 existing Score promotion entities with their
  exact low-cardinality flags and absolute floors.
- Recovery requires a signed, registry-authorized receipt bound to the exact
  environment, artifact, generation, invalidation epoch, complete active-cause
  set, evidence, verified artifact set, verifier, and time.
- Multi-cause recovery authority is the intersection of every typed cause.
  Unsupported or insufficient authority fails closed.
- The invalidation DAG is bounded and hash-chained. All eight reason families
  have fan-out and replay coverage.
- Confirmed reorg, conflicting finalized hashes, and provider compromise all
  map to total staged projection states.

## Review Convergence

Reviewers initially rejected caller-controlled randomness scope, rollback
reissue, insufficient journal-directory validation, unsigned recovery
evidence, partial reorg mapping, mixed-cause authority, and an incomplete
footprint. Each finding received a negative test and implementation repair.
All three reviewers then approved the exact final tree without edits.

## Operator Invariants

- Ethereum chain `1` floor remains `12287507`.
- `ENVIO_RESTART` is unset.
- No floor lowering, wipe, restart, or KF-013 replay occurred.
- No production signer, registry activation, deployment, Score graduation,
  index mutation, or database mutation occurred.
- This sprint is one governed lever and will be recorded as one commit.
