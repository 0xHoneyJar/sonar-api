# Implementation Report: Sprint 2

**Date:** 2026-07-19
**Engineer:** Run Mode implementer
**Sprint:** Atomic Registry and Trust Control Plane
**Beads Epic:** `bd-v54z.16`

## Outcome

Sprint 2 implements a hermetic, storage-neutral registry and trust control
plane. It adds focused Effect services and layers, an atomic in-memory
reference store, a fail-closed local-filesystem adapter, domain-separated
activation signing, two-channel bootstrap, governance/recovery quorums,
persistent generation high-water state, authenticated emergency revocation,
signed freshness checkpoints, and a deterministic rebuilt status projection.

No production signer, registry, deployment, Score mutation, index/database
mutation, Envio restart, floor change, wipe, or KF-013 replay is included.

## AC Verification

### Prior Sprint Ledger

Sprint 1 is already approved in
`grimoires/loa/a2a/sprint-1/auditor-sprint-feedback.md:1`; its criteria remain
walked here without claiming them as new Sprint 2 work:

- A detached promotion receipt records the explicit operator approval,
- The receipt is content-addressed and checked by a gate outside
- Until Task 1.1 verifies and commits that receipt, authorization permits
- External values strict-decode through Effect Schema; excess properties,
- Sonar and the generated consumer surface share byte-identical RFC 8785
- Circular/self-hash, Unicode, wrong environment, tamper, `2^53`, uint64,
- Every FR-1 through FR-13 maps to a planned module, test, and Beads owner.

### Sprint 2 Acceptance Criteria

**AC-2.1**: "Genesis uses generation `"1"` with atomic create-if-absent; exactly one of"

- Status: `✓ Met`
- Evidence: `test/truth-contract.registry-in-memory.test.ts:197` and
  `test/truth-contract.registry-filesystem.test.ts:353` exercise one-winner
  genesis races.

**AC-2.2**: "Every later generation is exactly prior + 1 and exposes one complete"

- Status: `✓ Met`
- Evidence: `test/truth-contract.trust-control-plane.test.ts:224` proves
  exact-next high-water; `test/truth-contract.registry-filesystem.test.ts:331`
  publishes a complete activation and signed audit.

**AC-2.3**: "The filesystem adapter refuses unsupported/network filesystems and proves"

- Status: `✓ Met`
- Evidence: `src/truth-contract/filesystem-certification.ts:84` strict-decodes
  candidates and refuses untrusted qualification; the production-shaped opener
  remains unavailable.

**AC-2.4**: "The initial certification candidates are macOS/APFS and Linux/ext4; every target"

- Status: `✓ Met`
- Evidence: `test/truth-contract.registry-filesystem.test.ts:1000` rejects
  unknown/network/virtual targets and keeps APFS/ext4 unavailable without their
  dedicated durability evidence.

**AC-2.5**: "Root substitution, rollback, cache loss, partial quorum, and compromised"

- Status: `✓ Met`
- Evidence: `test/truth-contract.registry-filesystem.test.ts:464`,
  `test/truth-contract.trust-control-plane.test.ts:624`, and
  `test/truth-contract.trust-control-plane.test.ts:935` cover rollback,
  substitution, partial/compromised quorum, and cache loss.

**AC-2.6**: "A valid emergency revocation suspends affected artifacts immediately;"

- Status: `✓ Met`
- Evidence: `test/truth-contract.revocation-control-plane.test.ts:370` proves
  synchronous eviction, replay rejection, durable deny reconstruction, and
  refusal to re-cache revoked targets.

**AC-2.7**: "Revocation epochs are signed; maximum offline age is 15 minutes in staged"

- Status: `✓ Met`
- Evidence: `test/truth-contract.revocation-control-plane.test.ts:702` covers
  the staged 15-minute bound, authority zero-age behavior, stale state, and
  channel loss.

**AC-2.8**: "Freshness across restart binds a signed time checkpoint, wall-clock value,"

- Status: `✓ Met`
- Evidence: `test/truth-contract.revocation-control-plane.test.ts:665` proves
  independent signed-time agreement; line 754 covers missing startup state,
  clock rollback, and snapshot restore.

**AC-2.9**: "Bootstrap channels use independent operator identities and credentials,"

- Status: `✓ Met`
- Evidence: `test/truth-contract.trust-control-plane.test.ts:294` requires exact
  two-channel identity/key agreement; line 450 proves durable equivocation
  evidence.

**AC-2.10**: "Loss/compromise recovery is a versioned state machine: 2-of-2 normal"

- Status: `✓ Met`
- Evidence: `test/truth-contract.trust-control-plane.test.ts:723` requires a
  persisted single-use 24-hour challenge plus disjoint governance and recovery
  quorums; line 935 proves exact-once monotonic advancement.

### Future Sprint Ledger

The validator scans the complete five-sprint plan. These prefixes remain open
and are walked without a `Met`, `Partial`, or `Deferred` claim:

Sprint 3:

- 100% of initial admitted EVM collections have canonical identity,
- 100% of initial event kinds declare user meaning, custody/intermediary
- Worst-source aggregation covers `READY`, `DEGRADED`, `NOT_READY`,
- Quiet data requires independent head, cursor, heartbeat, and coverage
- Unlisted networks, correlated provider quorum, incomplete proxy evidence,
- Initial Berachain finality requires the JSON-RPC `finalized` block tag
- Every claim records environment, observation time, finalized block/hash,
- The closed initial set is exactly Berachain `MiberaCollection`

Sprint 4:

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

Sprint 5:

- Machine-mode CLI requires `--target-state`; exit 0 means that exact target
- Completed invocations always emit valid versioned JSON: exit 1 invalid
- `NotConsumedReceiptV1` requires owner `bd-v54z.1` and deadline
- Score receipts bind target identity, producer generation, invalidation
- Authority-shaped CLI targets are refused with exit 2 unless an independent
- Berachain MiberaCollection
- Wrong bundle/snapshot/version/signature, reorg, expiry, revocation,
- Ethereum floor remains `12287507`, `ENVIO_RESTART` remains unset, and

## Acceptance Evidence

- Genesis and later generations use exact contiguous compare-and-swap; the
  in-memory and two-instance local-filesystem fixtures produce exactly one
  genesis winner. These are not claimed as cross-process durability proof.
- Immutable objects are digest-checked on write/read; prepared activation
  bytes precede the one current pointer.
- Filesystem certification binds OS, kernel, mount identity/options, storage
  topology, and adapter digest, but the production-shaped opener refuses every
  certificate until authenticated dedicated-runner integration exists. APFS
  additionally lacks Node `F_FULLFSYNC`; local evidence is `UNQUALIFIED`.
- Activation signatures bind environment, exact generation, and activation
  hash under a distinct domain.
- Bootstrap requires exactly two independent channels, operators, credentials,
  key identifiers, and public keys. Governance and recovery key sets are
  disjoint by both identifier and key material; equivocation bindings and
  conflict evidence persist across process restart. Ceremony issue/observation
  times are bound to trusted acceptance time, and filesystem trust state must
  be explicitly provisioned before first bootstrap; loss cannot silently reset
  it to first-install state.
- Quorum signatures are cryptographically verified; partial, duplicate,
  compromised, substituted, rollback, cache-loss, and gap fixtures fail.
- Recovery is a persisted two-phase ceremony: initiation binds exact current
  and next state plus evidence bytes, then finalization requires exact-next
  generation/nonce, distinct governance and recovery quorums, trusted approval
  time, and a completed single-use 24-hour challenge.
- Emergency revocation rides the pinned trust-envelope protocol with exact
  producer, capability, stream, epoch, sequence, event, issuer, and body
  binding. Acceptance evicts the matching cached-green target atomically;
  denied targets survive consumer reconstruction and cannot be re-cached.
- Replay/gap repair and registry polling are contiguous. Missing startup
  checkpoint, signed-time disagreement, stale/offline state, simultaneous
  channel loss, generation rollback, clock rollback/jump, and snapshot restore
  suspend trust. Green state additionally requires both a complete authenticated
  registry baseline and an explicit successful freshness proof.
- Revocation baselines persist sequence, epoch, generation, and exact signed
  tail digest in a separately provisioned owner-only store. Projection rebuild
  requires that independent baseline, so coordinated record-plus-adjacent-head
  rollback fails. Runtime consumers and projections accept only the nominal
  capability minted by the filesystem baseline factory; a caller-supplied
  structural persistence label has no authority.
- Every audit record is strict-decoded, body-hashed, and Ed25519-signed by an
  authorized audit role. The filesystem adapter binds the append-only audit
  tail to a separately provisioned owner-only monotonic baseline outside the
  registry tree. Read decisions use one immutable byte snapshot for signature,
  predecessor chain, mutable head, protected prefix, and baseline advancement,
  so forged suffixes, deletion/head reset, alternate signed history, and
  mid-read storage mutation all fail closed.
- Active roots are signature-verified again on every read; audit and revocation
  readers strictly decode all numbered records and reject gaps or unexpected
  entries instead of silently truncating.
- One complete fixture generation rebuilds to projection digest
  `ac85e205bcf7a369f3d6e77c76bee925ddae32ae58f3e545fc45aa019ebfd4f3`.

## Verification

| Command | Result |
|---|---|
| `pnpm run verify:truth-registry` | PASS; isolated typecheck, 5 suites, 50 tests |
| `pnpm run verify:truth-contract` | PASS; 3 suites, 20 Sprint 1 regression tests |
| `pnpm run test:truth-promotion` | PASS; 4 fail-closed promotion tests |
| `pnpm run verify:truth-promotion` | PASS; `production_authority:false` |
| traceability | PASS; 13 requirements, 2 implemented, 11 planned |
| Ethereum floor / restart | `12287507`; `ENVIO_RESTART` unset |

## Review Hotspots

1. `filesystem-registry-store.ts`: durable local ordering, fail-closed lock
   contention, genesis create-if-absent, read-once signed audit snapshots,
   independent monotonic audit tail, strict record enumeration, and pointer
   validation. No crash/power-loss qualification is claimed.
2. `trust-control-plane.ts`: bootstrap independence, quorum verification,
   challenge timing, and exact-next activation.
3. `trust-state-store.ts`: high-water deletion/corruption and write
   linearization.
4. `revocation-control-plane.ts`: inner/outer signature binding, replay/gap
   behavior, cache eviction, signed-time continuity, and offline policy.
5. `registry-projection.ts`: complete closure/audit requirement and stable
   projection rebuild.

## Known Boundaries

- The filesystem reference adapter is not deployment-qualified on this host.
  Same-process tests cannot establish cross-process or power-loss durability.
- The nominal baseline capability proves module-factory provenance, not
  deployment authority. Separately permissioned service credentials remain a
  mandatory STAGED/production deployment attestation.
- Stale local publisher locks require operator recovery; automatic stale-lock
  reclamation is intentionally absent to avoid split-brain recovery races.
- APFS remains mechanically unavailable until an adapter can issue
  `F_FULLFSYNC` and a dedicated runner passes crash injection.
- ext4 remains unavailable without a dedicated block-layer fault-injection
  certificate.
- All keys are vendored public fixture identities. Production KMS/HSM custody,
  deployment signing, and authority-valid activation remain out of scope.
- The wider repository compiler remains a known invalid signal because Envio
  generated modules are absent; the isolated truth-contract compiler passes.

## Operator Invariants

- Ethereum `start_block` remains `12287507`.
- `ENVIO_RESTART` remains unset.
- Production mutations: zero.
- Production authority: false.
