# CR-101 Capability Registry Protocol

Strict, fail-closed contracts for the versioned resolver capability registry.

## 1. Contiguous registry snapshot versions

Within an epoch, `candidate.registry_sequence` MUST equal `current.registry_sequence + 1`
using strict uint64 arithmetic over decimal strings.

Refused: gaps, reuse, regression, overflow from `2^64-1`, malformed lexical forms
(leading zeros, non-decimal).

CR-001 allows any strictly increasing sequence; CR-101 tightens to contiguous.

## 2. Cross-snapshot source sequencing

Cross-snapshot validation iterates the **union** of predecessor and candidate
`(network, operation)` keys.

| Case | Rule |
|------|------|
| Predecessor key missing from candidate | Typed transition integrity error — physical deletion refused |
| Material change (enabled/state/reason_class/reason/effective_at/drain/revocation/effects/deadline) | `source_sequence` MUST be predecessor + 1 |
| Unchanged material | `source_sequence` MUST be identical (no silent advance, reuse drift, regression, or skip) |
| Newly introduced pair | `source_sequence` MUST be `INITIAL_SOURCE_SEQUENCE` (`"1"`) |

Retirement / removal requires an explicit versioned **disabled/tombstone** row with the
required drain/revocation effects and the exact next `source_sequence`. There is no
proven physical-deletion retirement phase in this protocol — remove/re-add that resets
`source_sequence` to `INITIAL` is refused.

On `epoch_reset`, operations are newly introduced relative to the new epoch and MUST
all use `INITIAL_SOURCE_SEQUENCE`. Predecessor-epoch sequences are not compared.

## 3. Epoch reset binding signatures

Canonical baseline material binds:

- `previous_version` (epoch + sequence of the predecessor snapshot)
- `version` (candidate epoch + sequence)
- `snapshot_digest` (candidate registry snapshot digest)
- `binding_digest` over the above

The signature verification port verifies `binding_digest`, not snapshot digest alone.
A signature authorized for predecessor epoch A cannot reset from epoch B.

Production signing infrastructure is **not** installed in this worktree (honest blocker).

## 4. Compatible health tuples

`(state, enabled, drain_policy, prior_evidence_revocation_policy, normative_effects, reason_class)`
is one compatible tuple. Contradictions fail at strict validation.

| State | Drain | Revocation | Evidence effect | Notes |
|-------|-------|------------|-----------------|-------|
| available | finish | none | reuse_if_fresh | admitting only — never cancel/reject/revoke |
| degraded | finish \| capability_disabled | none \| freshness_only | reuse_if_availability_degradation | never cancel_and_reject / revoke_integrity |
| disabled (policy) | capability_disabled | freshness_only | freshness_policy | unsupported / operator policy |
| disabled (integrity) | cancel_and_reject | revoke_integrity | revoke | must reject/cancel work + revoke evidence |

### Kill switch (integrity-strength only)

When `network.kill_switch === true`, every operation MUST be disabled with
`drain_policy=cancel_and_reject`, `prior_evidence_revocation_policy=revoke_integrity`,
`existing_evidence=revoke`, and `reason_class` of `kill_switch` or `integrity_compromise`.

Refused under kill switch: freshness-only revocation, complete-existing-work drains,
admit/continue tuples, retained evidence, or mixed integrity/policy operation tuples.

## 5. Default vs diagnostic search

`selectDefaultRecognizeNetworks` returns only enabled **healthy** (`state=available`)
mainnet recognize capabilities. Degraded and disabled are excluded.

Diagnostics that need degraded rows MUST call `selectDiagnosticRecognizeNetworks` with
explicit `{ include_degraded: true }`. That API is not a default resolvable target.

## 6. Family-specific finality

- EVM confirmation is a discriminated union: `block_depth` permits only `min_depth`;
  `finalized_tag` permits only `finalized_tag`.
- EVM freshness clock: `block_time` only.
- Solana freshness clock: `slot_time` only.
- Excess keys, hybrid both-branch fields, and wrong-family clocks fail closed.

## 7. Transition envelope and Ordering audit fields

Every registry transition is a **complete discriminated envelope**
(`sequence_advance` | `epoch_reset`) that is **strict-decoded before any
projection, digest, sequence/signature verification, or transition logic**.

Allowed top-level fields only — undeclared keys such as `api_key`, `secret`,
`rogue`, or arbitrary metadata fail closed at envelope decode.

Audit fields (bound into the transition digest):

- `reason_class` — canonical `CapabilityReasonClass` enum
- `effective_at` — canonical UTC timestamp
- `actor` — bounded public identifier schema (rejects credentials/secrets/excess keys)

`epoch_reset` additionally requires `baseline` + `signature` as declared envelope
fields. Canonical transition digests serialize only values from the fully decoded
transition — never unchecked caller objects.

### Operation audit binding (deterministic rule)

Every materially changed or newly introduced operation MUST have:

- `effective_at` equal to the transition `effective_at`
- `reason_class` bound to the transition `reason_class` by this rule:
  1. equal reason_class always binds; or
  2. on `epoch_reset` only, a `disabled` tombstone may retain a disabled-class reason
     (`capability_unsupported` \| `operator_policy` \| `catalog_update` \| `kill_switch` \|
     `integrity_compromise`)

Unchanged operations retain their previous `effective_at` / `reason_class` and MUST NOT
be silently rewritten.

Ordering projection exposes `effective_at`, `source_sequence`, and `reason_class`
without display/icon, RPC/config, credentials, or provenance internals.

## Honest downstream blockers

- **Production signing / live baseline keys** — port only; hermetic verifier for tests.
- **CR-401** — Robinhood Chain mainnet capability proof (fixtures + hermetic tests; default catalog kill-switched).
- **CR-103 / CR-104** — downstream Ordering / report consumers of this projection.
- **CR-402** — Solana ownership_index prepare/read_evidence parity.
