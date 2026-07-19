---
title: "Product Requirements Document — Sonar to Score truth contract"
status: approved
trust_tier: operator-validated
read_state: validated
confidence: 0.9
decay_class: working
last_confirmed: 2026-07-18
operator_signed: self_attested
classification: OPERATOR_APPROVED
implementation_authorized: true
---

# Product Requirements Document — Sonar to Score Truth Contract

## 1. Product truth

> Sources: `sonar-score-issue-registry-2026-07-18.md`; `sonar-score-lineage-2026-07-18.md`

Sonar produces indexed chain facts. Score consumes those facts to create
community dimensions, member interpretations, and user-visible outcomes.
Today, the boundary between those systems is implied across schemas, issue
threads, repository history, and deployment knowledge. “Indexed” can therefore
be mistaken for “ready,” “projected,” or “consumed.”

The product outcome is a compiled, machine-verifiable producer-to-consumer
contract that lets an agent answer, without re-deriving institutional history:

1. What identity and event semantics did Sonar produce?
2. Through what block or cursor is that claim valid?
3. What is unknown, degraded, quarantined, or stale?
4. Which Score projection consumed that exact contract version?
5. What live proof shows the intended user-facing meaning?

This is infrastructure for reaching user truth faster. It is not a scoring
policy engine and must not turn infrastructure defaults into product rulings.

The operator approved this document for implementation on 2026-07-18. Its MUST
language becomes actionable only after the Simstim PRD, SDD, and sprint gates
complete and the detached promotion receipt binds the final document digests.

## 2. Users

> Sources: operator outcome statements; Sonar/Score issue registry

### Primary

- Agents implementing, reviewing, deploying, or diagnosing Sonar and Score.
- Operators deciding whether a collection or semantic change may graduate.
- Score services consuming Sonar facts without performing chain RPC or
  reconstructing producer behavior.

### Downstream

- Product builders interpreting member and community behavior.
- End users whose outcomes depend on correct identity, custody, staking,
  transfer, sale, and provenance semantics.

## 3. Problem statement

> Sources: Sonar/Score issue registry; current producer and consumer issue evidence

Five truth layers are currently coupled but not compiled:

1. **Identity** — canonical collection, legacy aliases, contract liveness, and
   address classification.
2. **Producer semantics** — event vocabulary, custody/staking symmetry,
   provenance, and coverage.
3. **Handshake** — schema/contract version, coverage horizon, watermark,
   degraded reasons, and reconciliation.
4. **Consumption** — Score projection version, serving status, and live
   user-facing proof.
5. **Policy** — denominator, borrowing, and signal-weight decisions owned by
   Score/product governance.

The absence of an executable boundary produces recurring failure modes:

- a row-count proof closes an issue even though Score has not consumed it;
- Score patches around an upstream semantic gap and the producer defect
  remains;
- stale repository names such as `thj-envio` are mistaken for current
  topology;
- a quiet collection is indistinguishable from a starved producer;
- identity aliases, custody transfers, and true user actions collapse into the
  same interpretation;
- an agent must reconstruct months of issue and migration history before it
  can safely act.

## 4. Dream outcome

> Sources: operator direction; producer-to-consumer dependency cut in the issue registry

For every graduated Sonar dataset or semantic change, an agent can obtain one
versioned readiness envelope and one Score consumption receipt. Together they
prove:

```text
source identity
  -> producer event semantics and provenance
  -> bounded coverage and reconciliation
  -> Score projection and serving version
  -> live user-meaning assertion
```

Any missing or incompatible link is machine-classified as not ready. The
system fails closed without inventing success.

## 5. Functional requirements

> Sources: current Sonar/Score contracts, schemas, issues, and Flatline PRD review

### FR-1 — Versioned producer contract

Sonar MUST publish a versioned contract that identifies:

- schema and contract version;
- canonical collection/entity identity version;
- event-kind vocabulary version;
- provenance fields required by each event kind;
- coverage horizon by chain and source;
- producer build/deployment identity.

The contract MUST be deterministic and validation MUST run in CI.

The contract hash MUST cover a closed set of normative artifacts named by one
root manifest: schema, identity registry, event vocabulary, behavioral
invariants, compatibility policy, authority matrix, security profile, activity
profiles, and issuer metadata. Serialization MUST use RFC 8785 JSON
Canonicalization Scheme (JCS) and SHA-256. Sonar and Score MUST execute the same
cross-language golden and negative vectors in CI. Hashing the schema alone is
invalid.

Publication MUST write immutable, content-addressed bundle objects before
atomically advancing a signed root manifest to a new registry generation.
Readers MUST observe either the complete previous generation or the complete
new generation; partial publication, missing objects, or a generation/hash
mismatch MUST fail closed.

### FR-2 — Canonical identity admission

Collection admission MUST fail closed when deployed contract identity cannot be
proven. Shape-only YAML validation is insufficient.

The identity surface MUST represent canonical collection IDs, supported legacy
aliases, chain/address bindings, deployed bytecode liveness, and explicit
unknown or contested states.

Liveness evidence MUST be chain-qualified and pinned to block number, block
hash, observed code hash, and finality class. CI consumes deterministic
fixtures/snapshots; live RPC failures produce `UNKNOWN` with reason codes and
never pass silently. Proxy resolution, implementation code hashes, upgrades,
metamorphic-code risk, historical validity intervals, and automatic
invalidation/supersession MUST be represented.

### FR-3 — Event semantics and provenance

The producer contract MUST distinguish user-meaningful actions from custody,
staking, conduit, bridge, marketplace, and other intermediary legs.

Every event kind MUST define its required provenance. `hold721` and related
ownership semantics MUST be symmetric across custody/staking ingress and
egress. Score MUST NOT perform chain RPC to recover missing address class or
provenance.

The initial event-kind denominator and provenance requirement set MUST be
listed in the bundle manifest rather than inferred from current handlers.

### FR-4 — Machine-readable readiness envelope

Sonar MUST emit a readiness envelope containing:

- contract/schema/identity/event-vocabulary versions;
- source and chain;
- indexed-through block or cursor;
- coverage start and expected horizon;
- event kinds covered and known exclusions;
- reconciliation status and timestamp;
- `READY`, `DEGRADED`, `NOT_READY`, or `UNKNOWN`;
- structured reason codes and evidence references;
- freshness/expiry boundary.

Transport health, row existence, and indexer catch-up MUST NOT independently
produce `READY`.

The contract MUST publish a normative readiness decision table defining
required evidence, state precedence, reason-code taxonomy, expiry behavior,
and multi-failure aggregation. Per-chain/source results aggregate by worst
effective state; one healthy source cannot hide an unhealthy required source.

Every block watermark MUST also carry chain ID, block hash, and chain-specific
finality class/policy. A reorg behind a watermark automatically invalidates
dependent readiness and consumption receipts and schedules reconciliation.
The SDD MUST pin the reorg detector, supported finality classes, maximum
detection and invalidation latency, dependency fan-out traversal, retry and
dead-letter behavior, and the recovery proof required to restore readiness.
Invalidation MUST be idempotent and its blast radius inspectable before a
consumer is allowed to resume.

Expected activity MUST be a versioned per-collection profile. The contract
MUST support legitimately quiet profiles and distinguish them from starvation
using independent source-head progression, provider heartbeat, cursor
advancement, expected-event windows, and where available cross-source checks.
Profiles MUST name an authorized owner, evidence window, denominator,
backtesting record, approval, effective interval, and superseded version.

### FR-5 — Reconciliation receipt

The system MUST compare the published producer claim with observable source and
projection state. The receipt MUST bind:

- producer contract hash;
- sampled or complete reconciliation method;
- observed watermark;
- discrepancy counts and bounded examples;
- result, timestamp, and expiry.

The receipt MUST distinguish legitimately quiet data from missing or stale
producer input.

Each reconciliation method MUST define deterministic sample inputs, minimum
sample size, adversarial strata, confidence bound, discrepancy thresholds, and
the conditions that require complete rather than sampled reconciliation.
Thresholds deterministically map the result to pass, degraded, or fail.
Sample selection MUST commit to an unpredictable seed before observations are
available, bind that seed and every stratum to the receipt, and prevent the
producer under test from choosing favorable samples. Any discrepancy above the
declared threshold or in a mandatory adversarial stratum MUST trigger the
specified expanded or complete reconciliation.

### FR-6 — Score consumption receipt

Score MUST emit a receipt that proves which producer contract it consumed:

- Sonar contract hash and versions;
- Score projection/build version;
- projection watermark;
- relevant communities/dimensions;
- serving endpoint or query proof;
- semantic assertions checked;
- live or staged status;
- expiry and rollback reference.

Code-green, merge-green, and deploy-green are intermediate states; none alone
constitutes live consumption.

The receipt MUST carry an immutable snapshot identifier binding producer bundle
hash, source block hash/finality, projection checkpoint, Score build, semantic
assertion set, and serving observation. Individually valid evidence from
different snapshots MUST NOT compose into an end-to-end proof.

“Live user-facing proof” MUST use versioned executable assertion fixtures with
query identity, expected meaning, target environment, tolerance, negative
cases, and owner. A technically successful query is insufficient.
Negative fixtures MUST include at least wrong bundle, wrong block hash,
expired evidence, incompatible consumer, revoked signer, replayed receipt, and
forged receipt.

### FR-7 — Semantic compatibility gate

Score consumption MUST fail closed when producer and consumer versions are
incompatible or when a required provenance/identity field is unavailable.

Compatibility MUST be encoded as data or executable validation, not an issue
comment or agent inference.

The bundle MUST publish a machine-testable compatibility matrix. Additive
optional fields or event kinds are compatible only when consumers declare
support; removed fields, changed meaning, changed required provenance, or
identity reinterpretation are breaking. Consumers declare supported version
ranges. Migration windows may dual-publish old and new versions, but serving
selection MUST be explicit per consumer and environment, each receipt pins one
version, and negative compatibility fixtures are mandatory. Development,
staging, and production MUST use separate trust namespaces and roots; promotion
creates a new environment-bound receipt rather than relabeling an old one.

### FR-8 — Agent-first inspection

A deterministic CLI command MUST let an agent inspect one collection or
community and receive:

- producer readiness;
- contract and identity versions;
- reconciliation state;
- Score consumption state;
- blocking owners and evidence paths;
- a stable non-zero findings exit code with valid machine-readable output.

The CLI MUST not require database credentials for ordinary status inspection
and MUST redact secrets by construction.

The CLI reads a signed, read-only artifact registry or status API with explicit
publisher, environment, TTL, and offline-cache policy. Its JSON schema is
versioned. Exit `0` means ready, exit `2` means valid findings/non-ready, and
other non-zero classes mean tool, trust, or transport failure.
An offline cache MUST report its age, trust-root generation, and expiry; it
cannot yield `READY` after expiry or when revocation state is unknown.

### FR-9 — Graduation state machine

The system MUST keep immutable lifecycle history separate from current
effective status. Lifecycle history is:

```text
DRAFT -> PRODUCED -> RECONCILED -> CONSUMED -> LIVE_PROVEN -> GRADUATED
```

Transitions MUST be monotonic within a contract version, evidence-bound, and
reversible only through a recorded supersession or rollback transition.

Current effective status is independently one of `READY`, `DEGRADED`,
`NOT_READY`, `UNKNOWN`, `SUSPENDED`, or `EXPIRED`. Expiry, reorg, revoked
issuer/key, failed reconciliation, or stale projection records an automatic
status transition without erasing lifecycle history.

Already-live Score projections follow a separate serving policy: continue
last-good data only when the failure class explicitly permits it, label the
surface degraded, block new graduation/version transitions, and escalate by
deadline. Semantic invalidity, revoked identity, or confirmed incompatible
meaning hard-fails serving. Every environment MUST define the policy.

The SDD MUST provide a total failure-class matrix for source lag, transport
loss, stale projection, expired evidence, reorg, reconciliation mismatch,
identity revocation, signer compromise, and incompatible semantics. Each row
MUST specify effective state, whether last-good serving is permitted, user
label, escalation deadline, recovery evidence, TTL, and allowed clock skew.

Every envelope and receipt MUST declare its dependency edges in a
machine-readable DAG. Expiry, supersession, reorg, revocation, or failed
reconciliation MUST traverse that DAG to invalidate every dependent effective
status while preserving immutable lifecycle history.

### FR-10 — Supersession and historical lineage

Every new contract version MUST name the version it supersedes, changed
semantics, affected consumers, migration requirements, and validity date.

Compressed lineage packets MAY orient agents but MUST remain replaceable and
must not outrank live contracts, receipts, or issue evidence.

Replacement pins and superseding bundles MUST pass the full canonicalization,
integrity, compatibility, regression, provenance, and review suite. Changing a
pin invalidates admissions bound to the previous pin.

### FR-11 — Authenticity, authorization, and replay protection

Producer bundles, readiness envelopes, reconciliation receipts, and Score
receipts MUST be signed or service-attested. Verification MUST bind issuer,
environment, issued-at time, monotonic sequence/nonce, payload hash, key ID,
and validity interval.

The SDD MUST select exactly one normative v1 signature and digest suite and
publish cross-language verification vectors; verifier choice or silent
algorithm fallback is forbidden. The contract MUST define authorized
publishers, hardware- or KMS-backed key custody, rotation, revocation, replay
rejection, and mismatch behavior. The registry audit log is append-only. A
process with storage write access alone MUST NOT be able to fabricate a valid
receipt.

Each environment MUST bootstrap from an out-of-band pinned trust root. Root
rotation MUST require the active governance quorum and publish an overlap
window; emergency recovery MUST use a separately protected recovery quorum.
Unknown roots, rollback to an older root generation, missing revocation state,
and unverifiable rotations fail closed.

Revocation records MUST include compromise-time semantics. The registry MUST
compute and expose the historical impact set of artifacts signed during the
affected interval, invalidate dependent effective status, and require new
evidence rather than re-signing old claims.

### FR-12 — Artifact discovery and evidence lifecycle

The canonical artifact registry MUST define publication paths, resolution by
collection/community/environment/version, access controls, retention,
immutability, and behavior when referenced evidence cannot be dereferenced.
Missing required evidence makes the effective status `UNKNOWN` or worse.
The root manifest MUST enumerate every normative artifact and evidence
dependency needed to verify one generation. Garbage collection MUST not delete
objects referenced by an unexpired receipt, retained audit record, or active
rollback target.

### FR-13 — Authority and transition ownership

A machine-readable role matrix MUST name who may publish contracts, admit or
contest identity, issue/revoke receipts, change compatibility rules, approve
rollback/supersession, and promote `LIVE_PROVEN` to `GRADUATED`.

Automated evidence may advance through `RECONCILED`; user-meaning graduation
requires the authority named by the active governance contract. Planning-agent
approval cannot substitute for that authority.

The signed role matrix MUST also name owners and approval rules for activity
profiles, denominators, reconciliation strata, trust-root changes, serving
exceptions, and `NOT_CONSUMED` stub retirement. Every stub MUST carry a Score
owner and deadline; after that deadline it remains visibly blocked and
escalated rather than becoming ready by omission.

## 6. Initial delivery cut

> Sources: dependency-weighted issue classification dated 2026-07-18

The first delivery SHOULD address the shortest causal path identified in the
2026-07-18 issue registry:

1. canonical bundle, identity, and contract-liveness admission;
2. versioned event semantics, provenance, compatibility, and finality;
3. authenticated readiness and reconciliation envelopes;
4. the Score consumption/serving receipt schema plus an explicit
   `NOT_CONSUMED` stub with Score owner and retirement deadline;
5. signed artifact discovery and deterministic agent inspection.

The initial Sonar implementation is anchored by Sonar issues #159, #151,
#157, #214, #121, and #135. Score-side consumption work remains a separate
governed cycle, including #553 and the existing projection PRs.

The Sonar delivery may claim only `PRODUCED` or `RECONCILED`. End-to-end
`LIVE_PROVEN` and `GRADUATED` are impossible until the separate Score cycle
emits a validating consumption receipt. The stub makes this absence
machine-readable rather than silently treating Sonar completion as product
completion.

## 7. Non-goals

> Sources: operator production invariants; issue registry PARK/RULE classifications

- Choosing Score policy for neutral custody, collateralized borrowing, or
  counter-cyclical signal weights (#548, #549, #487).
- Replaying KF-013, wiping data, restarting production, or lowering the
  Ethereum floor.
- Treating indexing throughput as the current primary bottleneck.
- Folding Mad Lads source restoration into the contract sprint.
- Rebuilding every parked Score issue or the events/NATS delivery train.
- Building a dashboard before the producer/consumer contract and CLI are
  trustworthy.

## 8. Success metrics

> Sources: functional requirements and producer-versus-consumer lifecycle boundary

### Sonar-complete gate

- 100% of initial in-scope event kinds have versioned provenance requirements.
- 100% of initial admitted collections have machine-verified canonical
  identity and contract liveness.
- Every readiness result has a structured state, reason, watermark, evidence
  reference, and expiry.
- The agent inspection CLI returns one stable JSON shape for ready, degraded,
  blocked, and unknown states.
- The initial denominators are pinned in the canonical bundle manifest.
- Zero production mutations are required to validate the contract shape and
  local/staged state machine.

### End-to-end gate

- A Score receipt cannot validate against the wrong producer bundle or
  immutable snapshot identifier.
- A registry reader cannot observe a partial generation or accept an unknown,
  rolled-back, or revoked trust root.
- At least one representative collection completes the staged
  `PRODUCED -> RECONCILED -> CONSUMED -> LIVE_PROVEN` path with both signed
  receipts and executable semantic assertions.
- Expiry, reorg, incompatible change, and revoked-identity fixtures each
  invalidate the effective state and dependent receipts as specified.
- Forged/replayed receipt and biased-sample fixtures fail, while a legitimately
  quiet profile remains distinguishable from a starved source.
- No `GRADUATED` claim occurs from Sonar evidence alone.

## 9. Risks

> Sources: issue registry failure modes and Flatline PRD review

| Risk | Required response |
|---|---|
| A schema is mistaken for the behavioral contract | Bind invariants, state transitions, compatibility, and receipts—not only JSON shape. |
| Score policy leaks into producer semantics | Keep policy issues in Score governance and encode neutral facts in Sonar. |
| Historical aliases overwrite canonical identity | Version aliases, preserve lineage, and make ambiguity explicit. |
| Quiet data appears healthy | Require expected horizon, freshness, and reasoned degraded/unknown states. |
| Local proofs are presented as production truth | Label environment and lifecycle stage in every receipt; require live proof separately. |
| Agents optimize the dashboard around missing truth | Make the CLI and receipts authoritative; projections remain consumers. |
| External RPC availability controls CI | CI validates pinned evidence fixtures; live probes emit reasoned `UNKNOWN` and never silently pass. |
| Receipt store writers forge readiness | Require service identity, signatures/attestations, sequence/replay controls, and append-only audit. |
| Expired or reorged evidence stays graduated | Separate immutable lifecycle from current effective status and automatically invalidate dependencies. |
| Partial publication creates a mixed contract | Publish immutable objects first and atomically advance one signed generation root. |
| Sampling hides a biased or sparse defect | Commit an unpredictable seed, stratify adversarially, and escalate misses to full reconciliation. |
| Signer compromise validates historical lies | Bind compromise intervals, compute impact sets, revoke dependents, and require fresh evidence. |

## 10. Security and privacy

> Sources: current repository security boundaries and Flatline PRD review

- Receipts MUST contain hashes, versions, reason codes, and allowlisted
  evidence references—not credentials or raw provider/database errors.
- Status inspection MUST be read-only.
- Production mutation capabilities MUST not be present in planning/review
  subprocesses.
- Raw chain addresses and public transaction hashes are permitted; private
  journey tokens, database URLs, credentials, and operator-private memory are
  prohibited.
- Registry writers and signing authorities MUST be least-privileged and
  independently auditable; read-only inspection cannot mint evidence.

## 11. Hard invariants

> Sources: operator-approved CR-OPS-IDX invariants and current production baseline

- Ethereum `start_block` remains `12287507`.
- `ENVIO_RESTART` remains unset.
- No floor lowering.
- No wipe, restart, or KF-013 replay without explicit operator authorization.
- One production lever per pass, with a commit and durable evidence.
- “Produced,” “reconciled,” “consumed,” and “live proven” remain separate
  states.
- This Simstim cycle is operator-approved for implementation; its staged
  outputs remain non-authoritative until their own Flatline, implementation,
  deployment-authority, and audit gates clear.
- Cycle-specific controls such as `ENVIO_RESTART`, KF-013 authorization, and
  the current production floor remain execution governance; they are not
  serialized as permanent product semantics inside the reusable contract.

## 12. Initial issue-to-requirement traceability

> Sources: Sonar/Score issue registry dated 2026-07-18

| Issue set | Requirement ownership |
|---|---|
| Sonar #159 | FR-2 canonical identity, pinned liveness, proxy/upgrade handling |
| Sonar #151, #157, #214 | FR-1/FR-3 event vocabulary, invariants, provenance |
| Sonar #121, #135 | FR-4/FR-5 readiness, finality, reconciliation |
| Sonar #179 | FR-3 address classification without Score RPC |
| Score #550/#524 and PRs #552/#551 | FR-6 consumption receipt/projection proof |
| Score #553 | FR-3/FR-6 executable user-meaning assertion |
| Score #548, #549, #487 | Policy non-goals; separate Score governance |
| Score #508 | Delivery dependency; baseline CI must be trustworthy |
| `bd-v54z.11` | FR-7/FR-10 compatibility, dual-publish, environment promotion, supersession |
| `bd-v54z.12` | FR-8/FR-11/FR-12 atomic registry, trust roots, signing, discovery |
| `bd-v54z.13` | FR-9 dependency DAG, reorg invalidation, serving and time budgets |
| `bd-v54z.14` | FR-13 authority, activity profiles, sampling governance, stub retirement |

## 13. Source inputs

> Sources: exact repository-relative artifacts listed below

- `grimoires/loa/context/sonar-score-issue-registry-2026-07-18.md`
- `grimoires/loa/context/sonar-score-lineage-2026-07-18.md`
- Current Sonar and Score issue/PR evidence referenced by that dated registry
- Current repository contracts, schemas, handlers, CI, and CLI surfaces
