---
title: "Software Design Document — Sonar to Score truth contract"
status: candidate
trust_tier: ai-derived
read_state: read
confidence: 0.85
decay_class: working
last_confirmed: 2026-07-19
operator_signed: false
classification: NON_AUTHORITATIVE
implementation_authorized: false
---

# Software Design Document — Sonar to Score Truth Contract

## 1. Project Architecture

> Sources: `grimoires/loa/prd.md`; Sonar/Score issue registry and lineage packet

Build one deterministic Sonar boundary that compiles producer identity,
semantics, coverage, reconciliation, and effective status into signed,
content-addressed artifacts. Score consumes the exact producer generation and
emits a separate receipt. An agent can inspect the joined state without
database credentials, chain RPC, or historical reconstruction.

The first Sonar cycle ends at `PRODUCED` or `RECONCILED`. It ships the Score
receipt schema and an explicit `NOT_CONSUMED` stub, but it cannot claim
`CONSUMED`, `LIVE_PROVEN`, or `GRADUATED`.

This candidate is planning input only. No protocol-kernel implementation or CI
authority may be derived from it until the operator explicitly signs it and
sets `implementation_authorized: true`. Simstim review, evidence capture, and
sprint drafting do not perform that promotion.

### 1.1 Existing seams to reuse

> Sources: current Sonar source tree and package manifest

This design extends working contracts instead of creating a parallel stack:

| Existing seam | Reuse |
|---|---|
| `src/collection-resolver/trust-protocol.ts` | RFC 8785 JCS, SHA-256, Ed25519, key registry, replay/epoch rules, fixture keys |
| `src/collection-resolver/capability-registry/` | strict Effect schemas, network finality policies, transition audit, signed registry patterns |
| `src/collection-resolver/adapters/evm/` | bytecode, proxy, implementation, block/hash, and finality-qualified identity evidence |
| `src/kitchen/coverage-readiness.ts` | fail-closed coverage binding and legitimate zero-row sync markers |
| `scripts/ramp-readiness.ts` | current collection inventory, chain progress, holder/event observations, and Score-facing readiness vocabulary |
| `scripts/promotion-gate.js` | schema-superset and reconciliation-footprint precedents |
| `src/sense/cli/sonar-sense.ts` | Incur agent CLI, JSON/TOON/MCP affordances, deterministic exit handling |
| `scripts/chain-metadata-view.sql` | read-only processed-through progress; explicitly not finality |
| `scripts/reorg-drill.sh` | deterministic replay/idempotency fixture precedent |
| `tests/conformance/jcs/` | cross-runtime canonicalization vectors |

`chain_metadata.latest_processed_block` remains a progress sensor only. A
signed finality policy and the observed source block hash are independently
required for readiness.

### 1.2 Bounded context and file layout

> Sources: PRD FR-1 through FR-13; current Sonar module conventions

Create `src/truth-contract/` as the only owner of this protocol:

```text
src/truth-contract/
  schemas/
    common.ts
    bundle.ts
    readiness.ts
    reconciliation.ts
    consumption.ts
    authority.ts
    registry.ts
  canonical.ts
  crypto.ts
  bundle-compiler.ts
  identity-snapshot.ts
  readiness-evaluator.ts
  reconciliation.ts
  dependency-graph.ts
  effective-status.ts
  errors.ts
  services.ts
  layers.ts
  registry-store.ts
  filesystem-registry-store.ts
  publisher.ts
  verifier.ts
  status-reader.ts
  cli/sonar-truth.ts
  fixtures/
scripts/truth-contract/
  compile-bundle.ts
  publish-generation.ts
  reconcile.ts
  build-activity-profile.ts
  verify-generation.ts
contracts/truth-contract/
  v1/
    compatibility.json
    event-vocabulary.json
    provenance-requirements.json
    authority-matrix.json
    security-profile.json
    activity-profiles.json
    serving-policy.json
    network-policies.json
test/truth-contract/
```

The protocol module is TypeScript 5.7 plus Effect 3.21 Schema. No handler
imports the registry. Envio handlers continue producing facts; the truth
compiler reads their declared vocabulary and read-only observations.

### 1.3 Effect runtime shape

Named wire and domain models use `Schema.Class`; lifecycle/status variants use
`Schema.TaggedClass`; artifact IDs, generations, environment IDs, and SHA-256
digests are branded schemas. Small anonymous fragments may use
`Schema.Struct`. External data is decoded with `Schema.decodeUnknownEffect`,
with excess fields refused before business logic.

Protocol and boundary failures use `Schema.TaggedErrorClass`, including
`TruthDecodeError`, `TruthIntegrityError`, `TruthTrustError`,
`TruthCompatibilityError`, `TruthRegistryError`, and
`TruthTransportError`. Expected invalidity stays in Effect's typed error
channel; impossible graph/hash invariants are defects; cancellation remains an
interrupt. Raw provider, filesystem, crypto, and transport errors are wrapped
at their boundary and never become the public contract.

`TruthRegistryStore`, `TruthSigner`, `TruthClock`, `SourceEvidenceReader`, and
`RevocationReader` are focused `Context.Service` dependencies. Live,
filesystem, and hermetic implementations are named layers. Business operations
such as `compileBundle`, `publishGeneration`, `evaluateReadiness`,
`reconcileSnapshot`, and `invalidateDependents` are named `Effect.fn`
functions. Layers are composed once in `layers.ts` and provided at the CLI or
worker boundary; business functions do not construct or locally provide live
dependencies. Repeated CLI/worker entrypoints share one `ManagedRuntime`.

Polling and retry timing use `Schedule`, not manual sleep loops. Only typed
transport, contention, and transient-store failures retry with bounded,
jittered exponential backoff. Schema, signature, compatibility, semantic, and
revocation failures do not retry into success. Retry attempts and selected
fallback providers remain observable.

## 2. Software Stack

> Sources: current `package.json`; existing trust and CLI modules

| Concern | Selected stack |
|---|---|
| Runtime | Node.js 22 or newer; TypeScript 5.7 |
| Domain effects | Effect 3.21 with typed errors, services, layers, schedules, and metrics |
| Boundary schemas | Effect Schema; strict unknown-input decoding |
| Canonical encoding | RFC 8785 JCS through the vendored trust protocol |
| Integrity/authenticity | SHA-256 and Ed25519 through the vendored trust protocol |
| Agent CLI | Incur 0.4 with JSON/TOON/MCP surfaces |
| Tests | Vitest 3.2; aligned `@effect/vitest`; existing JCS cross-runtime suite |
| Source observations | read-only GraphQL plus existing resolver/RPC ports |
| Initial registry | atomic local filesystem reference adapter behind an Effect service |

No new framework or database is required for the initial Sonar delivery.
Production object storage, KMS/HSM, and Score deployment remain adapter/gate
decisions.

## 3. Database Design

> Sources: PRD FR-9 and FR-12; atomic-publication requirement

The initial sprint does not add a production database schema. The logical
registry model is storage-adapter-neutral:

| Logical record | Key | Mutability |
|---|---|---|
| content object | SHA-256 digest | immutable |
| environment root | environment + generation | append-only generations; one CAS current pointer |
| audit event | environment + monotonic sequence | append-only |
| revocation | environment + key/artifact + sequence | append-only |
| dependency edge | parent hash + child hash | immutable within a generation |
| effective status | artifact hash + projection sequence | derived/rebuildable |

The filesystem reference store proves atomic semantics. A future production
adapter MUST preserve the same compare-and-swap, immutability, isolation,
retention, and ordered-audit behavior. Effective status is a projection; signed
artifacts and lifecycle history remain the source records.

## 4. UI Design

> Sources: PRD FR-8; agent-first scope

There is no graphical UI in this delivery. The supported interaction surface is
the `sonar-truth` Incur CLI and its generated help, JSON schema, JSON/TOON
output, and MCP transport. Human tables are projections of the same typed
result; they cannot introduce a separate readiness interpretation.

## 5. API Specifications

> Sources: PRD FR-1 through FR-13

### 5.1 Closed normative bundle

> Sources: PRD FR-1, FR-3, FR-7, FR-10, FR-13; Flatline PRD findings

#### 5.1.1 Root manifest

`TruthBundleRootUnsignedV1` is strict-decoded and contains:

```text
schema_version = 1
protocol = "sonar-score-truth-contract/v1"
environment = development | staging | production
generation = decimal uint64 string
supersedes_generation = decimal uint64 string | null
objects[] = { kind, media_type, sha256, byte_length }
issuer = { service_id, key_id }
issued_at, valid_from
compatibility_version
authority_matrix_hash
security_profile_hash
```

`TruthBundleRootV1` is a separate signed envelope:

```text
unsigned_root = TruthBundleRootUnsignedV1
root_hash = sha256(JCS(unsigned_root))
signature = Ed25519(domain-separated root_hash)
```

The digest field is never inside its own preimage.

`objects` is the complete normative closure. It MUST contain the bundle schema,
identity snapshot, event vocabulary, provenance rules, behavioral invariants,
compatibility matrix, authority matrix, security profile, network/finality
policies, activity profiles, serving policy, and issuer metadata. Unknown
required object kinds, missing objects, duplicate kinds, excess fields, digest
mismatches, and unreferenced normative files fail verification.

#### 5.1.2 Canonicalization and hashing

1. Strict-decode `TruthBundleRootUnsignedV1`.
2. Canonicalize the complete unsigned value with RFC 8785 JCS.
3. Hash those canonical bytes with SHA-256 to obtain `root_hash`.
4. Construct `TruthBundleRootV1` from `unsigned_root` and `root_hash`.
5. Sign domain-separated bytes:
   `sonar.truth-contract.v1\0<environment>\0<generation>\0<root-sha256>`.

The implementation reuses the vendored trust protocol's JCS, SHA-256, and
Ed25519 primitives. Sonar and the Score consumer package MUST run identical
golden vectors, including Unicode, numeric boundaries, key order, excess
properties, digest mismatch, circular/self-hash attempts, wrong environment,
and modified signature.

Every protocol integer that can exceed JavaScript's safe range is a canonical
decimal string with an explicit unsigned range: generation, audit/registry
sequence, block height, slot, timestamp milliseconds, byte length, sample and
population counts, and reconciliation totals. Leading zeroes, signs, decimal
points, exponent notation, values above uint64, and unvalidated JSON numbers
are rejected. Golden vectors cover `2^53 - 1`, `2^53`, and uint64 boundaries.

Verifier resource limits are enforced before deep decode or graph traversal:

| Resource | v1 limit |
|---|---:|
| signed root bytes | 256 KiB |
| normative objects per root | 128 |
| one object | 4 MiB |
| total object closure | 32 MiB |
| dependency edges declared by one artifact | 128 |
| graph nodes per environment generation | 10,000 |
| graph edges per environment generation | 50,000 |
| dependency depth | 64 |
| ordinary free-text field | 8 KiB |

Content length, object count, canonical integer syntax, and bounded identifiers
are checked before allocation-heavy work. Exceeding a bound is a typed decode
failure, never partial verification. Invalidation marks the signed ancestor
state immediately and processes bounded descendant batches; readers inherit
the ancestor's worse state even before traversal completes, preserving the
60-second effective-status objective.

#### 5.1.3 Event vocabulary

Each event kind declares:

```text
kind, semantic_version, source_entities, identity_fields, required_provenance,
user_meaning, non_user_legs, denominator_membership, breaking_change_rules
```

The initial manifest is compiled from current handlers and mapping constants.
Custody, staking, bridge, marketplace, conduit, mint, burn, sale, and direct
transfer legs are distinct. Score cannot infer missing address classification
through RPC.

### 5.2 Identity snapshot

> Sources: PRD FR-2; collection resolver and capability registry

`IdentitySnapshotV1` binds each canonical collection ID to:

- chain family, chain ID, canonical address/mint, and legacy aliases;
- config digest and source reference;
- observed block/slot, hash, timestamp, and finality policy version;
- deployed code hash or Solana owner/program identity;
- proxy kind, implementation address/code hash, and upgrade mechanism;
- validity interval, superseded snapshot, and contest state;
- evidence references and effective state.

The compiler calls the existing collection resolver through a narrow injected
port. Live RPC is never called in schema or unit tests. Hermetic snapshots are
CI inputs; read-only live probes may refresh staged evidence.

Admission rules:

1. Address shape without deployed identity is `UNKNOWN`.
2. RPC/provider failure is `UNKNOWN`, never absent or ready.
3. Proxy evidence is incomplete without implementation binding.
4. A code-hash or implementation change invalidates the old identity snapshot.
5. Aliases never overwrite canonical identity; ambiguity is `NOT_READY`.
6. Metamorphic or unresolvable upgrade behavior is explicitly unsupported or
   contested.

The first runtime slice is explicitly EVM-only and limited to networks
enumerated in the signed `network-policies.json`; no unlisted EVM network
inherits Ethereum policy. Solana wire variants remain compilable for consumer
compatibility but cannot become `READY` until a Solana identity/finality
adapter, fixtures, and admission tests land in a separately named sprint.

### 5.3 Readiness decision engine

> Sources: PRD FR-4; `coverage-readiness.ts`; `ramp-readiness.ts`

#### 5.3.1 Inputs

The pure evaluator accepts a bundle hash, identity snapshot, finality-qualified
watermark, coverage observation, source-head observations, activity profile,
reconciliation receipt, current time, and revocation/invalidation set.

#### 5.3.2 State precedence

Worst state wins across every required source:

```text
SUSPENDED
  > NOT_READY
  > UNKNOWN
  > EXPIRED
  > DEGRADED
  > READY
```

`SUSPENDED` means confirmed semantic or trust invalidity. `UNKNOWN` means
required evidence cannot be obtained or verified. `EXPIRED` is valid evidence
outside its time budget. `DEGRADED` is known, bounded loss of freshness or
availability for which policy permits last-good use. No healthy source masks an
unhealthy required source.

#### 5.3.3 Required evidence

`READY` requires all of:

- verified current root and active signing key;
- admitted identity at a finalized block/hash;
- compatible event/provenance version;
- processed-through at or beyond the required horizon;
- source head and index cursor advancing within the activity profile;
- reconciliation pass bound to the same snapshot;
- no active invalidation edge;
- unexpired envelope within clock-skew budget.

Rows alone are not readiness. A zero-row collection can be ready only through a
coverage-bound sync marker plus a quiet activity profile. A source with no rows,
no cursor advancement, or no independent heartbeat is `UNKNOWN` or
`NOT_READY`.

#### 5.3.4 Time budgets

| Artifact/sensor | Production TTL | Staging TTL | Max future skew |
|---|---:|---:|---:|
| source-head observation | 2 minutes | 5 minutes | 60 seconds |
| readiness envelope | 15 minutes | 30 minutes | 60 seconds |
| head-following reconciliation | 15 minutes | 30 minutes | 60 seconds |
| fixed historical reconciliation | 24 hours | 24 hours | 60 seconds |
| Score consumption/serving observation | 15 minutes | 30 minutes | 60 seconds |
| revocation/root cache | 5 minutes | 5 minutes | 60 seconds |

Development fixtures use an injected clock and explicit fixture expiry.
Changing these values is a signed policy change, not an environment variable.

### 5.4 Finality and reorg invalidation

> Sources: PRD FR-4 and FR-9; capability registry finality schemas; reorg drill

Each network policy is a signed object in the bundle and reuses
`FinalityPolicy`. Ethereum does not lend its confirmation rule to other EVM
chains. A watermark is the tuple:

```text
network, height_or_slot, block_or_root_hash, observed_at,
finality_policy_version, finality_class
```

The read-only detector polls required heads at most every 60 seconds. Two
independent providers must agree when the active policy requires quorum.
Parent/hash divergence behind any active watermark creates a signed
`reorg_detected` invalidation event.

Provider independence is signed policy data, not endpoint count. Each provider
entry declares operator/legal entity, ASN/network path, execution client
family, upstream source, and attested control domain. A quorum requires distinct
operators and control domains; the active network policy may additionally
require distinct ASNs or client families. Unprovable independence or loss of
quorum is `UNKNOWN`; conflicting finalized hashes are `NOT_READY` and trigger
invalidation. The evaluator never silently falls back to one provider.

Required service objectives:

- detection: within two poll intervals;
- registry invalidation publication: p99 within 60 seconds after detection;
- dependent status projection: p99 within 60 seconds after invalidation;
- no automatic recovery until replacement identity, watermark, reconciliation,
  and downstream receipts exist.

Every receipt declares `depends_on[]` artifact hashes. The dependency graph is
acyclic and append-only per generation. Invalidation performs a deterministic
breadth-first traversal, emits one idempotency-keyed event per affected
artifact, and preserves lifecycle history. Failed delivery retries with bounded
backoff and enters a dead-letter set. Dead-letter status is the worse of
`UNKNOWN` and the originating invalidation: reorg remains at least `NOT_READY`;
semantic, identity, signer, or root compromise remains `SUSPENDED`. A delivery
failure can never weaken the triggering state or leave the prior status green.

### 5.5 Reconciliation design

> Sources: PRD FR-5; promotion gate; Flatline statistical findings

#### 5.5.1 Snapshot binding

`ReconciliationReceiptV1` binds:

- bundle and identity hashes;
- source and projection block/root hashes;
- exact query/adapter versions;
- universe denominator and strata definition;
- seed commitment and revealed seed;
- sample or census membership digest;
- counts, mismatches, bounded examples, decision, expiry, and signer.

Evidence from different snapshot IDs cannot be joined.

#### 5.5.2 Seed protocol

The reconciler is a separate service principal, network boundary, deployment,
and Ed25519 key domain from the Sonar publisher. Producer credentials cannot
invoke its plan, commit, reveal, or receipt APIs. A dual-control deployment
attestation proves this separation before a reconciliation receipt is trusted.
Local fixtures may simulate both sides but are always non-authoritative.

After the producer root is published, the reconciler generates 256-bit CSPRNG
entropy and builds `SamplingPlanV1` containing bundle/root and snapshot hashes,
universe digest, ordered strata and denominators, query/parameter/adapter
digests, selection-algorithm version, confidence targets, and nonce commitment.
It atomically appends the signed plan before querying. Ordered events are:

```text
PLAN_COMMITTED -> QUERY_FINALIZED -> NONCE_REVEALED -> RECEIPT_PUBLISHED
```

The commitment is:
`SHA-256("sonar-reconcile-seed-v1" || JCS(sampling_plan_without_commitment) || nonce)`.
The nonce is revealed only after the query plan and universe are immutable.
Changing any bound input requires a new plan and invalidates the old attempt.

#### 5.5.3 Sampling and escalation

Sampling is stratified by network, collection, event kind, time bucket, and
high-risk semantic class (custody/staking, proxy upgrade, sale, mint/burn).
Each stratum declares its own maximum tolerated defect rate, confidence target,
population, and power calculation in the signed plan. Three hundred observations
is only a minimum floor for an ordinary populated stratum, never a global proof.
Rare and high-risk semantic strata use a census. Zero observed errors in one
stratum makes no claim about another.

Any semantic mismatch, missing mandatory stratum, identity mismatch, or
provenance omission triggers a census for the affected generation. Aggregate
count thresholds reuse a versioned footprint policy; the initial compatibility
baseline is the existing promotion gate's 0.1% relative tolerance with
entity-specific floors, while low-cardinality and semantic assertions remain
exact. Threshold changes require authority-matrix approval and a new bundle.

If a known mismatch triggered the census and the census cannot complete, the
terminal effective state remains `NOT_READY`. If escalation is required only
because evidence or a mandatory stratum cannot be obtained and no defect is yet
confirmed, the terminal state is `UNKNOWN`. Both produce a signed incomplete
receipt with retry owner/deadline; neither can hang or pass.

#### 5.5.4 Quiet versus starved

An activity profile includes expected-event distribution/window, collection
launch interval, source-head cadence, cursor cadence, provider heartbeat,
cross-source availability, owner, training/backtest window, and confidence.
A quiet pass requires source head plus cursor progression and a complete
coverage marker even when event count is zero. Missing independent progression
is never quiet.

### 5.6 Registry and publication

> Sources: PRD FR-8, FR-11, FR-12; Flatline atomic-publication finding

#### 5.6.1 Store port

`TruthRegistryStore` exposes:

```text
putObjectIfAbsent(hash, canonicalBytes)
getObject(hash)
appendAuditEvent(event)
readRoot(environment)
compareAndSwapRoot(environment, expectedGeneration, signedRoot)
readRevocations(environment)
```

The initial implementation is a hermetic filesystem reference store using
same-directory temporary files, local-POSIX advisory locking, fsync, and atomic
rename. It is restricted to one host and a filesystem that passes the
conformance probe; network filesystems and stores without durable rename,
exclusive lock/create, file fsync, and directory fsync are rejected. Production
storage is a later adapter and MUST provide transactional or conditional
compare-and-swap semantics.
The store is an Effect service: acquisition and any owned resources live in a
`Layer.effect`, while the pure in-memory fixture uses `Layer.succeed`.

Publication order:

1. compile and strict-verify every object;
2. write all immutable objects by digest;
3. fsync object files and their containing directories;
4. read every object back and verify digest;
5. sign the complete root and one `GenerationActivationV1` containing the root
   hash, exact prior generation, exact next generation, and audit sequence;
6. durably append the prepared activation/audit record;
7. compare-and-swap one current pointer to that activation;
8. fsync the pointer's containing directory and expose the generation.

Generation is contiguous: `next = prior + 1`; gaps, duplicates, and merely
greater values fail. The local adapter takes an exclusive inter-process lock
with owner PID/start metadata, refuses live competing owners, and has a
bounded stale-lock recovery check. Readers accept a root only through a complete
signed activation record, so root activation and publication audit are one
logical object rather than two fallible actions.

Genesis is generation `"1"`, `supersedes_generation = null`, expected current
pointer absent, prior generation `"0"` in the activation precondition, and
audit sequence `"1"`. Compare-and-swap uses atomic create-if-absent for genesis.
Two genesis publishers racing against an empty store must yield exactly one
winner and one typed contention failure.

A crash before step 7 leaves prepared but inactive objects. A crash after step
7 is recovered by verifying the activation, pointer, directory durability,
audit sequence, and complete object closure. Conformance tests kill the process
between every step and race two publishers; at most one contiguous activation
may become current.

Before enabling the filesystem adapter, an executable conformance probe verifies
local single-host identity, exclusive create/lock behavior across processes,
same-directory durable rename, file fsync, directory fsync, stale-lock
recovery, genesis race behavior, and crash recovery at every publication step.
Any unsupported syscall, network/mounted filesystem classification, or
non-durable result refuses adapter startup.

#### 5.6.2 Trust profile

Normative v1 is Ed25519 signatures, SHA-256 digests, and RFC 8785 canonical
JSON. Production private keys are non-exportable KMS/HSM keys behind a
`TruthSigner` port. PEM/file signers exist only for hermetic tests and local
development and use distinct fixture key IDs.

Each environment has a `TrustBootstrapV1` pin bundle containing environment,
protocol, bootstrap generation, key ID, Ed25519 public key, activation interval,
governance quorum public keys/threshold, recovery quorum public keys/threshold,
and bundle digest. Its canonical digest is verified through two independent
operator-controlled distribution channels and recorded in the release receipt.
Production never accepts staging/development roots.

Normal rotation is signed by the active root and authority quorum with an
overlap interval. Emergency recovery requires a separately protected recovery
quorum. Unknown roots, generation rollback, missing revocation state, stale
revocation cache, and algorithm mismatch are trust failures.

First install requires the two-channel bootstrap digest and quorum fixture.
Updates require the locally trusted current root plus quorum signatures and
must advance the persisted trusted-generation high-water mark exactly. The
high-water record is stored in a separately permissioned local state file with
digest and environment binding; deleting or losing it puts the reader into
`UNKNOWN` recovery mode rather than accepting any signed historical root.
Recovery requires a fresh bootstrap ceremony and operator receipt. Pin
substitution, rollback, partial quorum, cache loss, and compromised recovery-key
fixtures are mandatory.

Revocation includes `compromised_from`, `revoked_at`, and reason. The registry
queries its hash dependency graph for every artifact signed in the affected
interval, invalidates their effective status, and requires newly observed and
newly signed evidence.

Emergency revocation also travels through a push invalidation channel and
short-circuits positive caches immediately. A receipt signed by a compromised
key is `SUSPENDED` even inside the five-minute cache window and last-good
serving is forbidden. If push/revocation freshness cannot be proven after its
budget, trust is `UNKNOWN`; cached green status cannot continue.

The push channel is the existing signed trust-envelope stream on
`sonar.truth.revocation.v1.<environment>`. Only the governance/recovery
revocation authority may publish `EmergencyRevocationV1`; it uses a key and
service principal distinct from producer and reconciler. Consumers verify
environment, issuer, signature, epoch, monotonic sequence, compromise interval,
and artifact/key target before evicting caches. Delivery is at least once with
idempotent event IDs, gap detection, replay-range repair, and a registry-backed
poll fallback. When offline, the last verified revocation sequence is reported;
after the five-minute freshness budget, affected trust becomes `UNKNOWN`.

### 5.7 Effective lifecycle and serving policy

> Sources: PRD FR-6 and FR-9; Flatline serving-policy finding

Lifecycle history and effective status are separate projections. The complete
v1 lifecycle enumeration is `DRAFT`, `PRODUCED`, `RECONCILED`, `CONSUMED`,
`LIVE_PROVEN`, `GRADUATED`, `SUPERSEDED`, and `ROLLED_BACK`.

Allowed forward transitions are:

```text
DRAFT -> PRODUCED -> RECONCILED -> CONSUMED -> LIVE_PROVEN -> GRADUATED
any non-terminal version -> SUPERSEDED
CONSUMED | LIVE_PROVEN | GRADUATED -> ROLLED_BACK
```

Sonar publisher authority may create `PRODUCED`; the independent reconciler may
create `RECONCILED`; Score publisher authority may create `CONSUMED`; the
serving verifier may create `LIVE_PROVEN`; only the signed governance authority
may create `GRADUATED`, `SUPERSEDED`, or `ROLLED_BACK`. No transition erases or
rewrites an earlier event. Effective status can worsen automatically.

Registry generation and semantic contract lifecycle are different axes. The
Sonar publisher may advance contiguous registry generations for compatible
evidence refreshes without changing a contract version's lifecycle.
`supersedes_generation` is physical registry lineage only. A new generation
that changes semantics or declares a prior contract version `SUPERSEDED`
requires the signed governance transition in addition to publisher activation;
without it, activation fails.

| Failure class | Effective status | Last-good serving | User label | Recovery |
|---|---|---|---|---|
| temporary source transport loss within TTL | `DEGRADED` | yes, existing version only | degraded/stale timestamp | fresh source and readiness evidence |
| stale projection or evidence after TTL | `EXPIRED` | yes for at most one additional readiness-envelope TTL: 15m production, 30m staging | stale | fresh reconciliation and serving observation |
| source/index cursor not advancing | `UNKNOWN` | existing version only; no graduation | delayed/unknown | independent head, cursor, and coverage proof |
| reorg behind active watermark | `NOT_READY` | no for affected version | temporarily unavailable | replacement watermark and all dependent receipts |
| reconciliation count breach | `NOT_READY` | no new version; last-good prior generation only | update held | census pass |
| semantic/provenance mismatch | `SUSPENDED` | no | unavailable | corrected bundle and new Score receipt |
| canonical identity revoked/contested | `SUSPENDED` | no | unavailable | re-admission and new evidence |
| signer/root compromise | `SUSPENDED` | no for impact set | unavailable | recovered root and fresh evidence |
| incompatible producer/consumer version | `SUSPENDED` | no for incompatible version | update required | compatible build and receipt |

Escalation is immediate for `SUSPENDED` and `NOT_READY`, at TTL expiry for
`EXPIRED`, and after two missed detector polls for `UNKNOWN`. Serving exceptions
are signed, time-bounded policy objects and cannot permit graduation.

### 5.8 Score consumption boundary

> Sources: PRD FR-6 and FR-7; Score issue/PR evidence in the issue registry

Publish a strict tagged union in a small generated consumer package.
`ConsumedReceiptV1` contains:

```text
producer_root_hash, bundle_hash, identity_hash, reconciliation_hash,
producer_snapshot_id, score_build, projection_checkpoint,
compatibility_result, communities, dimensions, assertion_set_hash,
serving_query_hash, environment, observed_at, expires_at,
lifecycle_state, effective_status, depends_on[], issuer, signature
```

`NotConsumedReceiptV1` contains:

```text
_tag = "NotConsumedReceiptV1"
producer_root_hash, bundle_hash, identity_hash
lifecycle_state = "PRODUCED" | "RECONCILED"
effective_status = "NOT_READY"
reason_code = "NOT_CONSUMED"
score_owner
retirement_deadline
environment, observed_at, expires_at, depends_on[], issuer, signature
```

The Sonar stub selects the lifecycle state actually reached; it never hardcodes
`RECONCILED`. Variant-specific fields are required and excess fields are
refused. Valid and invalid golden fixtures cover both tags.

The Score cycle owns the verifier integration, projection checkpoint, live
query, user-meaning fixtures, and receipt signer. Compatibility validation runs
before projection and again before serving. A receipt pins exactly one producer
version even during dual-publish.

### 5.9 Agent interface

> Sources: PRD FR-8; current Incur Sonar Sense CLI

Add `pnpm truth` for `src/truth-contract/cli/sonar-truth.ts`:

```text
sonar-truth status --collection <id> --environment <env> --target-state produced|reconciled|consumed|live-proven|graduated --format json
sonar-truth verify --root <path-or-ref> --format json
sonar-truth explain --artifact <sha256> --format json
sonar-truth dependencies --artifact <sha256> --format json
sonar-truth rebuild-status --environment <env> --format json
```

`status` returns root generation, identity, producer readiness,
reconciliation, Score consumption, effective status, reason codes, expiries,
blocking bead/owner, and evidence references. It reads only the signed registry
or an explicitly identified offline cache.

Exit taxonomy:

| Exit | Meaning |
|---:|---|
| 0 | ready for the explicitly requested scope |
| 2 | valid result with findings/non-ready state |
| 3 | invalid invocation or unsupported schema |
| 4 | signature, trust-root, replay, or rollback failure |
| 5 | registry/transport unavailable |
| 6 | internal invariant failure |

Every non-zero response remains valid versioned JSON. Secrets, raw database
errors, private URLs, and operator-private memory are structurally excluded
from schemas.

`--target-state` is required in machine mode and defaults to `graduated` only
for interactive human output. Exit 0 means the named lifecycle state has been
reached or exceeded and every artifact required through that state has effective
status `READY`. Producer targets are `produced` and `reconciled`; end-to-end
targets are `consumed`, `live-proven`, and `graduated`. A
`NotConsumedReceiptV1` always yields exit 2 for every end-to-end target,
regardless of producer readiness.

`rebuild-status` replays the signed activation, lifecycle, revocation, and
invalidation records into a fresh projection and compares its digest with the
served projection. A committed golden event log proves rebuild equivalence.
The first sprint may ship the hermetic command and fixture; production recovery
remains separately authorized.

### 5.10 Compatibility and supersession

> Sources: PRD FR-7 and FR-10; `bd-v54z.11`

The compatibility matrix is executable data:

- additive optional field/event: compatible only when the consumer declares
  support or ignores it by contract;
- removal, requiredness change, meaning change, provenance change, identity
  reinterpretation, or denominator change: breaking;
- unknown producer or consumer version: incompatible;
- dual-publish: both roots valid, but routing is explicit by consumer and
  environment;
- promotion: staging artifacts are re-observed and re-signed for production,
  never relabeled.

A superseding root names affected consumers, migration requirements, validity
start, prior generation, and rollback target. Pins and replacement bundles run
the complete canonicalization, trust, compatibility, provenance, regression,
and negative-fixture suites.

## 6. Error Handling Strategy

> Sources: Effect error guidance; PRD failure semantics

Errors remain classified rather than flattened:

| Class | Representation | Retry | External result |
|---|---|---|---|
| invalid payload/schema | typed `TruthDecodeError` | never | exit 3 / structured reason |
| digest, signature, root, replay, rollback | typed `TruthIntegrityError` or `TruthTrustError` | never | exit 4 / fail closed |
| semantic or compatibility conflict | typed domain error | never | valid finding, status `NOT_READY` or `SUSPENDED` |
| unavailable provider/registry | typed `TruthTransportError` | bounded schedule | exit 5 or `UNKNOWN` |
| CAS contention/transient filesystem | typed `TruthRegistryError` | bounded schedule | retry then exit 5 |
| impossible DAG/hash invariant | defect | never | exit 6, alert, no publication |
| cancellation/shutdown | interrupt | never | scoped cleanup, no false failure artifact |

Schema errors are normalized at the boundary. Foreign errors are wrapped with
safe causes; raw credentials, URLs, and private details are not encoded.
Publication is all-or-nothing, and a failed invalidation/dead-letter path
worsens effective status rather than preserving green state.

## 7. Testing Strategy

> Sources: PRD success metrics; current Vitest/Bats/JCS test surfaces; Effect test guidance

### 7.1 Verification strategy

> Sources: PRD success metrics; current Vitest/Bats/JCS test surfaces

#### 7.1.1 Hermetic gates

- strict schema decode and excess-property refusal for every artifact;
- cross-language JCS/SHA-256/Ed25519 golden vectors;
- wrong root, environment, generation, signature, digest, nonce, expiry, and
  dependency negative fixtures;
- genesis create-if-absent, contiguous generation, physical-versus-semantic
  supersession, and trusted high-water fixtures;
- partial-generation and compare-and-swap race tests;
- filesystem conformance probe and process-kill matrix;
- readiness truth-table property tests;
- DAG cycle rejection, idempotent fan-out, dead-letter fail-closed behavior;
- root/object/graph/depth/field resource-limit fixtures;
- quiet, starved, reorg, proxy-upgrade, revoked-key, and compromise-interval
  fixtures;
- signed revocation stream replay, gap repair, offline expiry, and unauthorized
  publisher fixtures;
- sampling determinism, commitment verification, strata coverage, and census
  escalation;
- Score wrong-snapshot, wrong-bundle, forged/replayed receipt tests;
- CLI target-state, schema, and exit-code tests.

Effect tests use `@effect/vitest`: `it.effect` for ordinary programs,
shared `layer(...)` groups for reusable stores/signers, isolated
`it.layer(...)` fixtures for publication races, `it.effect.prop` with schema
arbitraries for canonicalization and state-machine laws, and `TestClock` for
TTL, polling, retry, and revocation behavior. A compatible, version-aligned
`@effect/vitest` package may be added without broadening this sprint into an
Effect upgrade.

#### 7.1.2 Read-only integration gates

- compile a bundle from current config/constants without mutation;
- verify current chain progress through GraphQL;
- obtain identity evidence from read-only provider calls;
- reconcile a representative collection into a local/staged registry;
- prove no `ENVIO_RESTART`, database write URL, or production signing capability
  is present in the planning/test environment.

#### 7.1.3 Traceability gate

CI fails when an FR lacks a schema/test/sprint mapping, a normative object is
outside the root closure, or an open `NOT_CONSUMED` stub lacks owner/deadline.

The initial normative mapping is:

| FR | Planned schema/module | Required test class | Owner |
|---|---|---|---|
| FR-1 | `bundle.ts`, `canonical.ts`, `bundle-compiler.ts` | root/JCS/hash closure vectors | `bd-v54z.11` |
| FR-2 | `identity-snapshot.ts` | live-code/proxy/alias/finality fixtures | Sonar #159 |
| FR-3 | event/provenance contract objects | handler vocabulary and semantic-leg fixtures | Sonar #151/#157/#214 |
| FR-4 | `readiness.ts`, `readiness-evaluator.ts` | complete state table, TTL, quiet/starved, multi-source properties | Sonar #121/#135 |
| FR-5 | `reconciliation.ts` | plan commitment, per-stratum power, mismatch/census escalation | Sonar #121/#135 |
| FR-6 | `consumption.ts` tagged union | wrong snapshot plus valid/invalid stub/consumed vectors | `bd-v54z.1` |
| FR-7 | `compatibility.json`, verifier | dual-publish and negative compatibility fixtures | `bd-v54z.11` |
| FR-8 | `status-reader.ts`, `cli/sonar-truth.ts` | schema, redaction, cache, and exit taxonomy | `bd-v54z.12` |
| FR-9 | `dependency-graph.ts`, `effective-status.ts` | lifecycle transitions, fan-out, dead-letter severity, rebuild | `bd-v54z.13` |
| FR-10 | root supersession fields and compatibility policy | pin replacement, rollback, migration fixtures | `bd-v54z.11` |
| FR-11 | `crypto.ts`, `authority.ts`, trust bootstrap | forge/replay/revoke/compromise/bootstrap/rollback vectors | `bd-v54z.12` |
| FR-12 | `registry-store.ts`, `publisher.ts` | crash matrix, dual writer, retention, complete generation | `bd-v54z.12` |
| FR-13 | `authority-matrix.json` | unauthorized transition/profile/root/stub attempts | `bd-v54z.14` |

## 8. Development Phases

> Sources: dependency cut in PRD initial delivery; beads `bd-v54z.11`–`.14`

1. **Protocol kernel** — schemas, canonical bundle, security profile, golden
   vectors, filesystem store, atomic root publication.
2. **Producer evidence** — identity snapshots, event/provenance compiler,
   coverage/readiness evaluator, activity profiles.
3. **Reconciliation and invalidation** — committed sampling, receipts,
   dependency DAG, reorg/expiry/revocation projection.
4. **Agent consumption** — status reader, Incur CLI, deterministic exit codes.
5. **Score seam** — generated consumer schemas, compatibility verifier,
   `NOT_CONSUMED` stub with `bd-v54z.1` and a sprint deadline.
6. **Staged proof** — representative collection, negative drills, no production
   mutation.

Production registry publication, production signing-key provisioning, Score
deployment, and live graduation are separately authorized operations.

### 8.1 Observability and operational acceptance

> Sources: PRD agent-first goal; readiness and invalidation design

Emit structured counters and durations:

- bundle compilation/publication/verification result by reason;
- root generation and age;
- readiness state and reason distribution;
- source-head, cursor, and reconciliation age;
- reconciliation sample/census size and mismatch class;
- invalidation detection-to-publication and fan-out latency;
- dependency dead-letter count;
- active revoked/compromised artifact count;
- Score stub age and deadline breach;
- CLI trust/transport/findings exit count.

Metrics identify artifact hashes and public collection IDs only. Logs never
carry signing material, provider credentials, database URLs, or raw private
errors.

Every meaningful protocol operation is a named `Effect.fn` span annotated with
environment, generation, public collection ID, and artifact hash. Structured
Effect logs appear only at publication, verification, reconciliation,
invalidation, and CLI boundaries. Metrics attach to those same boundaries; the
domain does not construct telemetry exporters.

### 8.2 Failure containment and rollout

> Sources: operator production invariants; PRD non-goals

- Phase 0: hermetic compile/verify only.
- Phase 1: read-only staging observations and local signed fixture registry.
- Phase 2: report-only production shadow reader after separate authorization.
- Phase 3: production root publication after signing/storage/operator gates.
- Phase 4: Score dual-consumption and live proof in Score's governed cycle.

No phase lowers the Ethereum floor, sets `ENVIO_RESTART`, wipes data, replays
KF-013, or mutates the production indexer. A failed or absent registry leaves
current Sonar serving unchanged and blocks new truth-contract graduation.

## 9. Known Risks and Mitigation

> Sources: PRD risks; SDD trust, registry, and rollout design

| Risk | Mitigation |
|---|---|
| Contract shape passes while behavior is wrong | Behavioral invariants, executable assertions, reconciliation, and negative fixtures are inside the root closure. |
| Partial publication mixes generations | Immutable objects precede one signed compare-and-swap root. |
| Quiet collections hide starvation | Require independent head/cursor/heartbeat evidence plus signed activity profiles. |
| Biased samples hide defects | Independent committed CSPRNG seed, mandatory strata, and census escalation on any semantic mismatch. |
| Reorg or revocation leaves stale consumers green | Explicit dependency DAG, bounded fan-out, dead-letter fail-closed projection. |
| Storage writer fabricates truth | Ed25519 verification, out-of-band roots, non-exportable production keys, append-only audit. |
| Environment artifacts are relabeled into production | Separate roots/namespaces and fresh environment-bound receipts. |
| Score treats Sonar completion as user truth | Mandatory `NOT_CONSUMED` stub; distinct Score receipt and live assertion gate. |
| Effect wiring becomes fragmented | Focused services, named layers, one boundary runtime, aligned Effect tests. |
| Production work mutates indexing controls | Read-only staged rollout and invariant checks; separate authorization for every production adapter/deploy. |

## 10. Open Questions

> Sources: authority boundary and separate Score governance

### 10.1 Open operator-owned decisions

> Sources: authority boundary and separate Score governance

The implementation sprint may prepare fixtures and interfaces, but cannot
decide:

1. production KMS/HSM provider and recovery-quorum members;
2. production registry storage adapter;
3. authority identities for `LIVE_PROVEN` and `GRADUATED`;
4. Score policy denominators or borrowing/custody rulings;
5. production publication, Score deployment, or rollout timing.

These are explicit later gates, not hidden implementation defaults.
