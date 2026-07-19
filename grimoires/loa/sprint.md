---
title: "Sprint Plan — Sonar to Score truth contract"
status: approved
trust_tier: operator-validated
read_state: validated
confidence: 0.86
decay_class: working
last_confirmed: 2026-07-18
operator_signed: self_attested
classification: OPERATOR_APPROVED
implementation_authorized: true
promotion_receipt: grimoires/loa/promotion-receipt.sonar-score-v1.json
---

# Sprint Plan — Sonar to Score Truth Contract

## Executive Summary

Five dependency-ordered sprints turn Sonar's implicit Score boundary into a
signed, machine-verifiable producer contract, without mutating production or
pretending Sonar completion is user-truth completion.

Grounding:

- “Indexed” can be mistaken for “ready,” “projected,” or “consumed”
  (`prd.md:20-24`).
- The desired proof chain is identity → semantics/provenance → coverage and
  reconciliation → Score projection → user meaning (`prd.md:94-107`).
- Sonar may claim only `PRODUCED` or `RECONCILED`; Score consumption remains a
  separate governed cycle (`prd.md:412-420`).
- The operator explicitly approved implementation on 2026-07-18. A detached
  promotion receipt binds the frozen PRD, SDD, sprint, repository, and scope;
  mutable frontmatter is metadata, not the authorization proof.

**Total sprints:** 5
**Cadence assumption:** five calendar days per sprint; agents may finish sooner
without weakening gates.
**Planned window:** 2026-07-20 through 2026-08-13.
Each sprint reserves its final day for focused review and evidence sealing; the
next sprint cannot start until that receipt is green. Dates roll rather than
compress when a gate fails.
**Score consumption SLA:** seven calendar days after the sealed Task 5.E2E
handoff, owner `bd-v54z.1`. The handoff sets the absolute deadline in the
receipt. Missing it changes the receipt to `NOT_CONSUMED_OVERDUE`; it never
expires into success. Re-baselining requires a new operator-approved amendment
that supersedes, rather than rewrites, the old receipt.

### Goals

| ID | Goal | Measurement |
|---|---|---|
| G-1 | Compile one deterministic, signed producer contract | Complete root closure; cross-runtime JCS/SHA-256/Ed25519 vectors pass |
| G-2 | Prove canonical identity, event meaning, coverage, and readiness | 100% of initial in-scope identities/event kinds have versioned evidence and structured state |
| G-3 | Reconcile claims and invalidate stale or compromised dependents | Committed sampling/census, reorg/revoke/expiry fan-out, and rebuild digest all pass; staged receipts remain non-authoritative |
| G-4 | Make truth directly consumable by agents and Score | Stable CLI JSON/exits plus strict consumed/not-consumed Score receipt union |
| G-5 | Demonstrate honest staged closure without production mutation | MiberaCollection/Transfer reaches `RECONCILED_STAGED`; end-to-end target remains exit 2 until Score proof |

### Assumptions

- [ASSUMPTION] Five focused agent sprints are available; if capacity is lower,
  dates move but dependency order does not.
- [ASSUMPTION] The initial runtime slice is EVM-only; Solana wire compatibility
  remains non-ready until its own adapter sprint.
- [ASSUMPTION] Score implementation remains in `bd-v54z.1`; this Sonar plan
  ships the verifier seam and a non-expiring fail-closed `NOT_CONSUMED` receipt,
  not Score policy.
- [ASSUMPTION] The closed representative slice is Berachain
  `MiberaCollection` at `0x6666397dfe9a8c469bf65dc744cb1c733416c420`
  with the configured ERC-721 `Transfer` event only. Any additional collection
  or event kind requires an explicit plan amendment and owner.
- [ASSUMPTION] Each Flatline artifact campaign is capped at two attempts,
  900 seconds and USD 3.00 per attempt. Reaching any cap freezes the recorded
  verdict and requires operator adjudication; there is no silent third run.

## Sprint Overview

| Sprint | Dates | Theme | Beads epic | Blocking result |
|---|---|---|---|---|
| 1 | 2026-07-20–2026-07-24 | Ratify and compile protocol kernel | `bd-v54z.15` | Valid signed root contract |
| 2 | 2026-07-25–2026-07-29 | Atomic registry and trust control plane | `bd-v54z.16` | Crash-safe hermetic registry |
| 3 | 2026-07-30–2026-08-03 | Producer identity, semantics, readiness | `bd-v54z.17` | Signed `PRODUCED` generation |
| 4 | 2026-08-04–2026-08-08 | Reconciliation, invalidation, recovery | `bd-v54z.18` | Signed `RECONCILED_STAGED` generation |
| 5 | 2026-08-09–2026-08-13 | Agent consumption and staged proof | `bd-v54z.19` | Honest Sonar handoff to Score |

Failed-gate and partial artifacts are retained under `.run/evidence/` with
their originating digest, gate state, and owner, but are labeled
`EPHEMERAL_NON_CITABLE`. They cannot satisfy dependencies, readiness, or
graduation and are superseded only by a sealed green receipt.

## Sprint 1: Ratify and Compile the Protocol Kernel

**Scope:** MEDIUM — 4 tasks
**Dates:** 2026-07-20 through 2026-07-24

### Sprint Goal

Promote the reviewed plan explicitly, then implement the strict protocol types,
canonical signed root, normative objects, and traceability gates.

### Deliverables

- [ ] Detached operator-promotion receipt for frozen PRD/SDD/sprint hashes and
      implementation boundary.
- [ ] `src/truth-contract/` named schemas, branded scalars, and typed errors.
- [ ] Non-circular unsigned/signed root compiler with closed object manifest.
- [ ] Versioned contract objects and FR-to-code/test/owner validation.

### Acceptance Criteria

- [ ] A detached promotion receipt records the explicit operator approval,
      exact document digests, repository identity, base commit, scope,
      timestamp, and approval source before Task 1.2 starts.
- [ ] The receipt is content-addressed and checked by a gate outside
      `src/truth-contract/`; changing any approved document invalidates it.
- [ ] Until Task 1.1 verifies and commits that receipt, authorization permits
      Task 1.1 only. Tasks 1.2+ remain mechanically closed. The verifier uses
      pre-existing SHA-256/JQ tooling and is pinned before truth-contract source
      code, so the implementation under review cannot redefine its own gate.
- [ ] External values strict-decode through Effect Schema; excess properties,
      unsafe integers, and over-limit resources fail with typed errors.
- [ ] Sonar and the generated consumer surface share byte-identical RFC 8785
      JCS, SHA-256, and Ed25519 vectors.
- [ ] Circular/self-hash, Unicode, wrong environment, tamper, `2^53`, uint64,
      replay, and signature-negative fixtures pass.
- [ ] Every FR-1 through FR-13 maps to a planned module, test, and Beads owner.

### Technical Tasks

- [ ] **Task 1.1 / `bd-v54z.15.1`** — Verify and seal into the plan commit the detached promotion
      receipt for the exact PRD, SDD, sprint, Flatline outcomes, non-goals, and
      production invariants. The approval source is the operator's explicit
      2026-07-18 conversation instruction; it is a governance attestation, not
      a production cryptographic trust root. Halt on any digest mismatch.
      → **[G-1, G-5]**
- [ ] **Task 1.2 / `bd-v54z.15.2`** — Implement Schema classes, tagged
      lifecycle/status variants, decimal-string brands, typed boundary errors,
      Effect services, and resource limits under `src/truth-contract/`.
      → **[G-1]**
- [ ] **Task 1.3 / `bd-v54z.15.3`** — Implement
      `TruthBundleRootUnsignedV1`, `TruthBundleRootV1`, canonical compiler,
      domain-separated signing, complete closure, and golden vectors.
      → **[G-1]**
- [ ] **Task 1.4 / `bd-v54z.15.4`** — Compile compatibility, event vocabulary,
      provenance, authority, security, activity, serving, and network policy
      objects; add the traceability gate.
      → **[G-1, G-2, G-4]**

### Dependencies

- PRD hash `063b397045fb1232805be68f82b00bc6b4474365a71df15028288f71f2e6a6cf`.
- SDD hash `8285b762a58454d3561d928c04bc9dcdac1dc63f15bd725c309f4e99cb63156e`.
- Operator promotion is a hard gate; the approved detached receipt, not mutable
  frontmatter, carries the authorization. The platform-authenticated operator
  message is the Loa governance authority for this cycle; the receipt preserves
  it durably. Production trust still requires independently signed activation.
- Existing vendored trust protocol and local Effect reference checkout.

### Security Considerations

- No production key, write URL, database credential, or root pin enters tests.
- Fixture signing keys use distinct fixture identities and environments.
- Schema, trust, and semantic failures never retry into success.

### Risks & Mitigation

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Candidate plan is mistaken for authority | Low | Critical | Detached content-addressed receipt and independent digest gate |
| Root digest implementations diverge | Medium | Critical | Separate unsigned/signed schemas and shared byte vectors |
| Large hostile artifacts exhaust the verifier | Medium | High | Pre-decode byte/object/graph/depth bounds |

### Success Metrics

- 100% of FR-1–FR-13 have traceability entries.
- 0 schema-invalid values reach domain operations.
- 100% of canonicalization/signature golden and negative vectors pass.
- Production mutations: 0.

## Sprint 2: Atomic Registry and Trust Control Plane

**Scope:** MEDIUM — 5 tasks
**Dates:** 2026-07-25 through 2026-07-29

### Sprint Goal

Provide a crash-consistent hermetic registry whose generation, trust bootstrap,
rollback defense, and emergency revocation behavior are independently
verifiable.

### Deliverables

- [ ] Focused registry/signer/clock/revocation services and test layers.
- [ ] In-memory and local-filesystem stores with atomic generation activation.
- [ ] Trust bootstrap, quorum rotation/recovery, and generation high-water state.
- [ ] Authenticated emergency revocation stream with replay/gap repair.
- [ ] Complete crash, race, rollback, and compromise conformance evidence.

### Acceptance Criteria

- [ ] Genesis uses generation `"1"` with atomic create-if-absent; exactly one of
      two racing publishers wins.
- [ ] Every later generation is exactly prior + 1 and exposes one complete
      signed activation/audit object.
- [ ] The filesystem adapter refuses unsupported/network filesystems and proves
      lock, durable rename, file/directory fsync, stale-lock, and crash recovery.
- [ ] The initial certification candidates are macOS/APFS and Linux/ext4; every target
      must pass primitive probes plus crash injection. Overlay, bind, virtual,
      unknown, and network mounts return `STORE_UNAVAILABLE` unless separately
      certified; filesystem labels alone never grant support.
- [ ] Root substitution, rollback, cache loss, partial quorum, and compromised
      recovery fixtures fail closed.
- [ ] A valid emergency revocation suspends affected artifacts immediately;
      unauthorized, replayed, gapped, or offline-stale streams cannot stay green.
- [ ] Revocation epochs are signed; maximum offline age is 15 minutes in staged
      mode and zero in authority-valid mode. Startup with stale/missing state,
      clock rollback, stream gap, or simultaneous channel loss fails closed.
- [ ] Freshness across restart binds a signed time checkpoint, wall-clock value,
      monotonic sample, trusted-generation high-water, and boot identity.
      Staged mode tolerates at most 30 seconds of skew; snapshot restore,
      pre-start wrong time, forward/backward jump, or missing checkpoint yields
      `SUSPENDED` until two independent signed-time sources agree.
- [ ] Bootstrap channels use independent operator identities and credentials,
      require 2-of-2 agreement for genesis, record equivocation, and use a
      separately approved recovery ceremony rather than trust-on-first-use.
- [ ] Loss/compromise recovery is a versioned state machine: 2-of-2 normal
      operation; one-channel loss enters `SUSPENDED`; recovery requires distinct
      governance and recovery identities, a 24-hour challenge period, signed
      evidence, monotonic generation/nonce, and rollback/equivocation checks.

### Technical Tasks

- [ ] **Task 2.1 / `bd-v54z.16.1`** — Implement `TruthRegistryStore`,
      `TruthSigner`, `TruthClock`, source/revocation reader services, named
      layers, and in-memory adapter.
      → **[G-1, G-3]**
- [ ] **Task 2.2 / `bd-v54z.16.2`** — Implement filesystem conformance probe,
      locks, object durability, prepared activation, contiguous CAS, pointer
      durability, and a deployment-certification artifact bound to OS, kernel,
      mount identity/options, storage topology, and adapter digest. APFS requires
      `F_FULLFSYNC`; ext4 power-loss claims require block-layer fault injection.
      Process-kill evidence certifies process-crash consistency only.
      → **[G-1, G-3]**
- [ ] **Task 2.3 / `bd-v54z.16.3`** — Implement `TrustBootstrapV1`,
      environment roots, independent two-channel digest receipt, 2-of-2
      conflict/equivocation rules, audit log, quorum rotation/recovery ceremony,
      and persistent trusted-generation high-water validation.
      → **[G-1, G-3]**
- [ ] **Task 2.4 / `bd-v54z.16.4`** — Implement
      `EmergencyRevocationV1` over the existing trust-envelope stream with
      distinct authority, sequence, replay-range repair, poll fallback, and
      immediate cache eviction; add signed freshness epochs, monotonic-time
      and signed-time checkpoint checks, startup/offline policy, and
      reboot/restore/clock-jump/partition vectors.
      → **[G-3]**
- [ ] **Task 2.5 / `bd-v54z.16.5`** — Execute the full registry/trust E2E
      conformance matrix and rebuild one clean status projection.
      → **[G-1, G-3]**

### Dependencies

- Sprint 1 root/schema/security contracts.
- `@freeside/trust-envelope-protocol` existing vendored package and digest pin.
- Production KMS/HSM and production registry adapters are explicitly excluded.
  Therefore every Sprint 2–5 receipt is `FIXTURE_VALID` or `STAGED_VALID`, never
  `AUTHORITY_VALID`. A post-plan operator gate blocks authority-valid activation
  until signer custody, audit logging, key rotation, compromise recovery,
  reconciler isolation, and dual control are attested in the target deployment.
- No filesystem is certified merely because CI is green. APFS qualification
  requires a dedicated `macos-apfs-durability` runner and ext4 qualification a
  dedicated `linux-ext4-fault-injection` runner. If those externally controlled
  runners are unavailable, Task 2.2 seals `UNQUALIFIED` evidence and the
  filesystem adapter remains `STORE_UNAVAILABLE`; in-memory work may continue.

### Security Considerations

- Producer, reconciler, governance/recovery, and fixture principals remain
  distinct.
- Private keys are non-exportable in production designs; Sprint 2 uses fixture
  signers only.
- Loss of high-water or revocation freshness becomes `UNKNOWN`, not trust reset.

### Risks & Mitigation

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Rename appears atomic but is not durable | Medium | Critical | Startup conformance plus crash injection and directory fsync |
| Concurrent publishers split the root | Medium | Critical | Exclusive lock/create and contiguous CAS activation |
| Pin channel becomes the weakest link | Medium | Critical | Two-channel bootstrap digest, quorum updates, monotonic local high-water |
| Fixture validity is mistaken for deployment authority | Medium | Critical | Explicit validity class and post-plan deployment-attestation gate |

### Success Metrics

- 0 partial generations observable across every crash point.
- Exactly 1 winner in 100% of two-publisher race fixtures.
- 100% of trust substitution/rollback/revocation negatives fail.
- Projection rebuild digest matches the served fixture digest exactly.

## Sprint 3: Producer Identity, Semantics, and Readiness

**Scope:** MEDIUM — 5 tasks
**Dates:** 2026-07-30 through 2026-08-03

### Sprint Goal

Compile current EVM identity, event meaning, coverage, finality, and activity
evidence into a signed producer generation with deterministic readiness.

### Deliverables

- [ ] Finality-qualified EVM identity snapshot compiler.
- [ ] Versioned event vocabulary and provenance requirements.
- [ ] Complete pure readiness evaluator and time policy.
- [ ] Signed network and expected-activity profiles.
- [ ] Hermetic generation that can honestly reach `PRODUCED`.

### Acceptance Criteria

- [ ] 100% of initial admitted EVM collections have canonical identity,
      code/proxy binding, finality block/hash, validity interval, and config
      digest.
- [ ] 100% of initial event kinds declare user meaning, custody/intermediary
      legs, provenance, and denominator membership.
- [ ] Worst-source aggregation covers `READY`, `DEGRADED`, `NOT_READY`,
      `UNKNOWN`, `SUSPENDED`, and `EXPIRED` with deterministic reasons.
- [ ] Quiet data requires independent head, cursor, heartbeat, and coverage
      evidence; starvation cannot pass as quiet.
- [ ] Unlisted networks, correlated provider quorum, incomplete proxy evidence,
      and source failures fail closed.
- [ ] Initial Berachain finality requires the JSON-RPC `finalized` block tag
      from two independently operated providers with identical block number and
      hash. Unsupported tags, provider correlation, disagreement, or contest
      evidence yield `UNKNOWN`; no Ethereum depth fallback is permitted.
- [ ] Every claim records environment, observation time, finalized block/hash,
      source and adapter digests, and expiry. Fixture-only claims are labeled
      `FIXTURE_VALID`; staged-current claims require read-only observations no
      older than 60 minutes and become `EXPIRED` after that bound.
- [ ] The closed initial set is exactly Berachain `MiberaCollection`
      `0x6666397dfe9a8c469bf65dc744cb1c733416c420` and its configured
      `Transfer(address,address,uint256)` event; the denominator manifest is
      committed and byte-verified.

### Technical Tasks

- [ ] **Task 3.1 / `bd-v54z.17.1`** — Adapt the existing EVM resolver into
      canonical identity snapshots with alias, code/proxy, upgrade, block/hash,
      finality, and contest evidence.
      → **[G-2]**
- [ ] **Task 3.2 / `bd-v54z.17.2`** — Compile handler/constants coverage into
      event vocabulary, semantic-leg, provenance, and denominator objects.
      → **[G-2]**
- [ ] **Task 3.3 / `bd-v54z.17.3`** — Implement the readiness evaluator,
      coverage binding, state precedence, TTL/skew, provider diversity, and
      invalidation inputs as named Effect operations.
      → **[G-2, G-3]**
- [ ] **Task 3.4 / `bd-v54z.17.4`** — Compile signed EVM network policies and
      owned/backtested activity profiles; retain Solana as explicitly non-ready.
      → **[G-2]**
- [ ] **Task 3.5 / `bd-v54z.17.5`** — Compile and verify one complete hermetic
      producer generation and readiness envelope from the closed
      MiberaCollection/Transfer slice; bind observation age and validity class.
      → **[G-1, G-2]**

### Dependencies

- Task 3.1 may develop against ephemeral adapters after Task 2.1, but Task 3.5
  is blocked on the complete Task 2.5 registry/trust conformance matrix.
  Ephemeral artifacts are labeled non-citable and cannot become generation
  evidence.
- Existing resolver, coverage evaluator, ramp-readiness inventory, and
  read-only `chain_metadata` progress view.
- CI uses deterministic snapshots. Any `STAGED_CURRENT` result additionally
  requires bounded-age live read-only evidence with the provenance fields above;
  a fixture alone can never make a current claim.

### Security Considerations

- RPC/GraphQL failures produce typed `UNKNOWN`; they never imply absence.
- Score receives producer classification; it does not make recovery RPC calls.
- Public chain identifiers are permitted; raw provider errors and credentials
  are excluded.

### Risks & Mitigation

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Existing config alias is mistaken for canonical identity | Medium | High | Versioned alias graph plus contested/unknown states |
| A quiet source passes from zero rows alone | Medium | High | Coverage marker plus independent progression and signed profile |
| Ethereum finality leaks to other EVM networks | Low | High | Exact signed network allowlist and per-network policy |
| A stale fixture is presented as current | Medium | Critical | Validity class, 60-minute observation TTL, block/hash and adapter/source digests |

### Success Metrics

- 100% in-scope identities and event kinds have versioned evidence.
- 100% readiness outputs include state, reason, watermark, evidence, and expiry.
- 0 row-count-only or transport-only `READY` results.
- Production mutations: 0.

## Sprint 4: Reconciliation, Invalidation, and Recovery

**Scope:** MEDIUM — 5 tasks
**Dates:** 2026-08-04 through 2026-08-08

### Sprint Goal

Independently reconcile producer claims, propagate every invalidation without
weakening severity, and prove the effective status projection is rebuildable.

### Deliverables

- [ ] Signed, immutable sampling-plan commitment from a separately keyed and
      separately launched staged reconciler principal.
- [ ] Per-stratum reconciliation/census receipt with deterministic terminal
      states.
- [ ] Bounded dependency DAG and lifecycle/effective-status projection.
- [ ] Read-only reorg detector and total serving failure policy.
- [ ] One valid `RECONCILED_STAGED` generation plus complete negative/rebuild
      evidence; no authority-valid claim.

### Acceptance Criteria

- [ ] Sampling commits universe, strata, query/adapter digests, algorithm,
      targets, and nonce before observation.
- [ ] The normative statistical policy versions the population, estimand
      (semantic-defect prevalence), tolerable defect rate, confidence,
      one-sided power, finite-population correction, stratification,
      multiple-testing correction, missing-observation treatment, and a
      deterministic sample-size algorithm with golden vectors.
- [ ] `StatisticalPolicyV1` is frozen before Task 4.2: strata are
      contract × event kind × semantic leg; the estimand is semantic-defect
      prevalence; tolerable rate is 1%, adverse alternative is 5%, family-wise
      alpha is 0.05 with Bonferroni correction, minimum power is 0.80, sampling
      is deterministic hypergeometric without replacement, missing observations
      count as defects, and integer rounding is ceiling. It uses no defect-rate
      prior. High-risk strata, undersized strata, or any observed mismatch
      require census and a completed census is required to recover readiness.
- [ ] Rare/high-risk strata and any stratum too small to meet the configured
      95% confidence / 80% power target use census; unmet power fails closed.
      The historical aggregate `n=300` is descriptive only and is never an
      acceptance threshold or global proof.
- [ ] Any semantic mismatch triggers census; an incomplete census terminates
      `NOT_READY` or `UNKNOWN` as specified and never hangs.
- [ ] Reorg, expiry, revocation, semantic mismatch, and incompatibility traverse
      the DAG idempotently; dead letters cannot weaken the triggering state.
- [ ] Every query binds one generation and invalidation epoch and evaluates the
      full ancestor closure. During fan-out, stale epochs are rejected; bounded
      convergence, retry owner, dead-letter escalation, and race behavior are
      specified and tested.
- [ ] Graph limits are 10,000 nodes, 50,000 edges, depth 32, fan-out 1,000,
      two seconds, and 256 MiB per query. Generation-bound closure summaries may
      cache verified results; exceeding any limit returns fail-closed
      `UNKNOWN/RESOURCE_LIMIT`. Worst-case and concurrent-invalidation tests are
      mandatory.
- [ ] A normative exhaustive state table covers every local/ancestor state and
      event combination. Severity is monotonic within an epoch:
      `SUSPENDED > EXPIRED > UNKNOWN > NOT_READY > DEGRADED > READY`; recovery
      requires a newer signed epoch and cannot be inferred from child state.
- [ ] A separately launched staged reconciler uses a different fixture key,
      principal, process, and artifact directory from the producer. This proves
      separation mechanics only and yields `STAGED_VALID`, never
      `AUTHORITY_VALID`.
- [ ] Replaying signed activation/lifecycle/revocation/invalidation events
      produces a byte-identical projection digest.

### Technical Tasks

- [ ] **Task 4.1 / `bd-v54z.18.1`** — Implement distinct reconciler authority,
      `SamplingPlanV1`, ordered commitment/reveal events, mutation refusal, and
      a separately launched staged-reconciler harness with principal/key/process
      boundary evidence.
      → **[G-3]**
- [ ] **Task 4.2 / `bd-v54z.18.2`** — Implement per-stratum power/census rules,
      the pre-frozen `StatisticalPolicyV1`, footprint count policy,
      snapshot-bound reconciliation receipts, limitations, independent-review
      receipt, golden vectors, and incomplete-census outcomes.
      → **[G-3]**
- [ ] **Task 4.3 / `bd-v54z.18.3`** — Implement bounded acyclic dependencies,
      lifecycle/effective projection, idempotent batched fan-out, ancestor
      inheritance, generation/invalidation epochs, stale-query rejection,
      exhaustive precedence vectors, dead letters, bounded convergence, and
      rebuild.
      → **[G-3]**
- [ ] **Task 4.4 / `bd-v54z.18.4`** — Implement injected provider head
      comparison, diversity/disagreement rules, reorg events, schedules, and
      the total serving matrix.
      → **[G-2, G-3]**
- [ ] **Task 4.5 / `bd-v54z.18.5`** — Publish one reconciliation receipt,
      execute every negative invalidation, rebuild status, and prove the valid
      generation reaches `RECONCILED_STAGED`; refuse `AUTHORITY_VALID`.
      → **[G-3, G-5]**

### Dependencies

- Sprint 3 producer generation and snapshot identity.
- Task 4.1 explicitly provisions the separate staged reconciler before Task 4.2.
  Deployment authority remains outside this plan and requires the post-plan
  operator gate; fixture or staged separation cannot satisfy it.
- Production reorg watcher deployment is excluded; the implementation uses
  injected/read-only adapters.

### Security Considerations

- Producer keys cannot call reconciler plan/reveal APIs.
- Graph resource limits are checked before traversal.
- Known semantic/trust failures remain `NOT_READY`/`SUSPENDED` even when event
  delivery fails.

### Risks & Mitigation

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Reconciler colludes with producer | Medium | Critical | Separate staged principal/key/process now; deployment isolation and dual-control remain an authority gate |
| Sampling misses concentrated semantic defects | Medium | High | Mandatory high-risk census and per-stratum power |
| Fan-out exposes stale descendants | Medium | Critical | Generation/invalidation epoch, ancestor-closure query, stale-read rejection, bounded convergence |

### Success Metrics

- 100% sampling plans verify their pre-observation commitment.
- 100% negative invalidations produce the exact expected state.
- 0 dead-letter paths weaken severity.
- Rebuild projection digest equality: exact.

## Sprint 5: Agent Consumption and Staged Truth Proof

**Scope:** MEDIUM — 5 tasks
**Dates:** 2026-08-09 through 2026-08-13

### Sprint Goal

Make producer truth deterministic for agents and Score, then validate one
representative EVM collection through the honest Sonar-to-Score handoff.

### Deliverables

- [ ] `sonar-truth` binary, implemented with the Incur CLI framework, providing
      status/verify/explain/dependencies/rebuild commands.
- [ ] Strict `ConsumedReceiptV1 | NotConsumedReceiptV1` consumer seam.
- [ ] Hermetic CI, traceability, redaction, and production-invariant gates.
- [ ] Representative local/staged collection proof.
- [ ] E2E goal receipt and owned Score continuation.

### Acceptance Criteria

- [ ] Machine-mode CLI requires `--target-state`; exit 0 means that exact target
      and all prerequisite effective states are ready.
- [ ] Completed invocations always emit valid versioned JSON: exit 1 invalid
      invocation/usage, exit 2 valid findings or unmet target, exit 3 unsupported
      capability/version, exit 4 trust failure, exit 5 transport failure, and
      exit 6 invariant failure. SIGINT/SIGTERM use 130/143 and may not emit a
      complete envelope; agents must treat them as no result.
- [ ] `NotConsumedReceiptV1` requires owner `bd-v54z.1` and deadline
      exactly seven calendar days after the sealed Task 5.E2E handoff; it forces
      exit 2 for all end-to-end targets. Missing that relative SLA produces
      `NOT_CONSUMED_OVERDUE`, pages the Beads owner, and remains exit 2 until a
      valid `ConsumedReceiptV1` supersedes it.
- [ ] Score receipts bind target identity, producer generation, invalidation
      epoch, environment, monotonic sequence, issuance/deadline, and a
      domain-separated Score authority. The verifier applies signer quorum,
      rotation/revocation high-water, uniqueness, and deterministic conflict
      rules; stale/replayed/cross-environment/dual-published/compromised-key
      vectors cannot turn exit 2 into exit 0.
- [ ] Authority-shaped CLI targets are refused with exit 2 unless an independent
      `AUTHORITY_VALID` activation attestation is present. Staged labels cannot
      be aliased or dual-published under authority names.
- [ ] Berachain MiberaCollection
      `0x6666397dfe9a8c469bf65dc744cb1c733416c420` and only its configured
      `Transfer` event reach `PRODUCED -> RECONCILED_STAGED` in a local/staged
      registry using bounded-age read-only observations.
- [ ] Wrong bundle/snapshot/version/signature, reorg, expiry, revocation,
      biased sample, and starved-source drills all fail.
- [ ] Ethereum floor remains `12287507`, `ENVIO_RESTART` remains unset, and
      production/index/database mutations remain zero.

### Technical Tasks

- [ ] **Task 5.1 / `bd-v54z.19.1`** — Build the Incur CLI over one
      `ManagedRuntime` with target-state semantics, JSON/TOON/MCP, offline trust
      age, typed exits, evidence owners, and structural redaction. MCP is local
      stdio only, exposes allowlisted read operations, inherits identical
      envelope/exit semantics and graph limits, denies network and
      credential-bearing environment by default, and enforces per-tool rate and
      resource limits.
      → **[G-4]**
- [ ] **Task 5.2 / `bd-v54z.19.2`** — Generate the Score receipt tagged union,
      compatibility verifier, dual-publish negatives, non-expiring
      `NOT_CONSUMED`/`NOT_CONSUMED_OVERDUE` stub, Score authority/sequence/
      rotation/revocation rules, relative-SLA deadline, and deterministic
      supersession/conflict state machine.
      → **[G-4]**
- [ ] **Task 5.3 / `bd-v54z.19.3`** — Wire protocol closure, traceability,
      Effect/JCS/resource/CLI tests, secret exclusions, and production-invariant
      checks into hermetic CI.
      → **[G-1, G-2, G-3, G-4]**
- [ ] **Task 5.4 / `bd-v54z.19.4`** — Compile, reconcile, inspect, invalidate,
      and rebuild the closed MiberaCollection/Transfer slice in a local/staged
      registry; record process separation and `STAGED_VALID` limitations.
      → **[G-5]**
- [ ] **Task 5.E2E / `bd-v54z.19.5`** — Validate G-1–G-5, seal the handoff
      receipt, and keep actual Score consumption/live proof owned by
      `bd-v54z.1`.
      → **[G-1, G-2, G-3, G-4, G-5]**

#### Task 5.E2E: End-to-End Goal Validation

**Priority:** P0 — Must Complete

| Goal | Validation action | Expected result |
|---|---|---|
| G-1 | Compile, verify, publish, reload signed generation | One complete root; all cross-runtime vectors pass |
| G-2 | Inspect representative identity/events/readiness | Versioned identity/provenance and structured ready state |
| G-3 | Reconcile, invalidate negatives, rebuild projection | `RECONCILED_STAGED`; exact negative states; equal rebuild digest |
| G-4 | Query producer and end-to-end target states | Producer target may exit 0; `NOT_CONSUMED` end-to-end exits 2 |
| G-5 | Check evidence and invariant receipt | Sonar reaches `RECONCILED_STAGED`; Score continuation is owned; mutations 0 |

### Dependencies

- `bd-v54z.1` owns Score implementation after the Sonar handoff.
- Upstream Loa PR #1228 is pinned to
  `bfb3d81cbe4121a9f652793b861a5af95bbfc5e3`; CI fails closed on digest drift
  and revalidates imported Flatline/vector surfaces on PR update or merge. It
  cannot authorize Score graduation.
- Production registry, signing keys, deployment, and Score rollout each require
  separate operator gates.

### Security Considerations

- CLI has read-only registry authority and no database credentials.
- MCP is a local read-only stdio projection, not a network service; tool,
  resource, redaction, and envelope parity are tested against the CLI.
- No production signer or mutation URL is present in the staged proof process.
- End-to-end claims remain fail-closed at `NOT_CONSUMED`.

### Risks & Mitigation

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Agent treats producer-ready as user-ready | Medium | Critical | Required target state and strict Score stub exit 2 |
| CLI leaks private operational context | Low | High | Schema allowlists, structural redaction, secret-negative tests |
| Staged proof is presented as production | Medium | Critical | `STAGED_VALID`/`RECONCILED_STAGED` labels and authority-activation gate |

### Success Metrics

- CLI output schemas: 100% stable across ready/findings/trust/transport cases.
- Representative collection producer target: exit 0 at
  `reconciled_staged`; authority-valid target remains exit 2.
- Representative collection end-to-end target: exit 2 `NOT_CONSUMED`.
- Negative drill pass rate: 100%.
- Production mutations: 0.

## Risk Register

| ID | Risk | Sprint | Impact | Owner |
|---|---|---|---|---|
| R-1 | Detached promotion digest or scope mismatches | 1 | Blocks implementation by design | `bd-v54z.15.1` |
| R-2 | Atomic filesystem semantics cannot be proven | 2 | Blocks registry adapter | `bd-v54z.16.2` |
| R-3 | Identity/activity evidence is ambiguous | 3 | Produces `UNKNOWN`/`NOT_READY` | `bd-v54z.17.1`, `.17.4` |
| R-4 | Staged reconciler separation or deployment authority cannot be proven | 4 | Receipt remains fixture-valid/non-authoritative | `bd-v54z.18.1` |
| R-5 | Score misses consumption target | 5 | `NOT_CONSUMED_OVERDUE`, exit 2, owner escalation; never implicit success | `bd-v54z.1` |
| R-6 | Production invariant changes | all | Immediate halt | `bd-v54z` |

## Appendix

### A. Task Dependencies

```text
1.1 -> 1.2 -> 1.3 -> 1.4
                 |
                 v
2.1 -> 2.2 -> 2.3 -> 2.4 -> 2.5
                               |
                               v
3.1 -> 3.2 -> 3.3 -> 3.4 -> 3.5
                               |
                               v
4.1 -> 4.2 -> 4.3 -> 4.4 -> 4.5
                               |
                               v
5.1 -> 5.2 -> 5.3 -> 5.4 -> 5.E2E -> bd-v54z.1

Hard gates:
- Every sprint waits for the preceding sprint's sealed review receipt.
- 3.5 waits for 2.5; any earlier Sprint 3 experiment is ephemeral/non-citable.
- 4.2 waits for the separately launched staged reconciler evidence in 4.1.
- Each sprint's final-day review receipt gates the next sprint.
```

### B. PRD Feature Mapping

| PRD requirement | Sprint/tasks |
|---|---|
| FR-1, FR-7, FR-10 | Sprint 1; Tasks 1.2–1.4 |
| FR-2, FR-3, FR-4 | Sprint 3; Tasks 3.1–3.5 |
| FR-5 | Sprint 4; Tasks 4.1–4.5 |
| FR-6 | Sprint 5; Tasks 5.2, 5.4, 5.E2E |
| FR-8 | Sprint 5; Tasks 5.1, 5.3 |
| FR-9 | Sprint 4; Tasks 4.3–4.5 |
| FR-11, FR-12 | Sprint 2; Tasks 2.1–2.5 |
| FR-13 | Sprint 1 Task 1.4; Sprint 2 Tasks 2.3–2.4 |

### C. PRD Goal Mapping

| Goal ID | Goal description | Contributing tasks | Validation task |
|---|---|---|---|
| G-1 | Deterministic signed producer contract | 1.2–1.4, 2.1–2.5, 3.5, 5.3 | 5.E2E |
| G-2 | Canonical identity, semantics, coverage, readiness | 1.4, 3.1–3.5, 4.4, 5.3 | 5.E2E |
| G-3 | Reconciliation and invalidation | 2.1–2.5, 3.3, 4.1–4.5, 5.3 | 5.E2E |
| G-4 | Agent and Score consumption seam | 1.4, 5.1–5.3 | 5.E2E |
| G-5 | Honest staged closure | 1.1, 4.5, 5.4, 5.E2E | 5.E2E |

### D. Non-Negotiable Stop Conditions

- The detached promotion receipt is absent or any approved digest/scope differs.
- Any Ethereum `start_block` differs from `12287507`.
- `ENVIO_RESTART` is set.
- Any wipe, restart, KF-013 replay, floor lowering, production index/database
  mutation, production signing, or deployment action is attempted.
- A producer-only artifact is labeled consumed, live-proven, or graduated.
- A fixture/staged receipt is labeled `AUTHORITY_VALID`, or a staged
  reconciliation is labeled simply `RECONCILED`.
- A trust, schema, semantic, compatibility, or invariant failure is retried or
  normalized into success.
- Any sprint exceeds its Flatline campaign budget or drops an unadjudicated
  blocker. The campaign limit is two attempts per artifact, 900 seconds and
  USD 3.00 per attempt.
