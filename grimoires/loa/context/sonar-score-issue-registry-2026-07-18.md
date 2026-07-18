---
title: "Sonar / Score issue registry — producer-to-consumer closure"
status: candidate
trust_tier: ai-derived
read_state: unread
confidence: 0.86
decay_class: working
last_confirmed: 2026-07-18
operator_signed: false
hivemind:
  schema_version: "1.0"
  artifact_type: technical-rfc
  product_area: "sonar-api + score-api"
  workstream: discovery
  priority: high
  learning_status: directionally-correct
  source: team-internal
---

# Sonar / Score issue registry — 2026-07-18

This is a dated decision aid, not a permanent doctrine or a substitute for the
issue bodies. It classifies all open issues observed at:

- `0xHoneyJar/sonar-api`: 42 open issues
- `0xHoneyJar/score-api`: 36 open issues

## Classification model

Each issue is placed on two axes:

1. **Truth layer**
   - `IDENTITY`: what collection/address/entity a row refers to
   - `PRODUCER`: source coverage and event semantics in Sonar
   - `HANDSHAKE`: readiness, version, cursor, and reconciliation contracts
   - `CONSUMER`: Score projection, interpretation, and serving correctness
   - `CONTROL`: agent workflow, CI, deployment, and operator ergonomics
   - `POLICY`: a product/scoring ruling that infrastructure must not decide
2. **Lifecycle**
   - `CLOSE`: evidence says the issue is already satisfied or superseded
   - `PROVE`: code/PR exists; merge, deploy, or live receipt is still missing
   - `EXECUTE`: bounded work with a testable outcome
   - `RULE`: operator/product decision required before implementation
   - `PARK`: valid but not on the shortest dependency path

Priority is dependency-weighted: remove causes that fan out across many
communities and downstream decisions before treating symptoms one by one.

## Sonar classification

| Issues | Truth layer | Lifecycle | Finding / route |
|---|---|---|---|
| #120 | PRODUCER | CLOSE | Last issue evidence says the Azuki root cause was fixed and production holder data recovered. Close as stale; do not repeat KF-013. |
| #216, #219 | IDENTITY | PROVE | Source correction and canonical 6.9/legacy 6.6 alias work have green draft PRs (#217, #220). Merge/deploy/live proof remains. |
| #159 | IDENTITY | EXECUTE P0 | The belt gate validates YAML shape but not deployed bytecode/name/symbol. Add fail-closed on-chain contract liveness admission using the existing RPC seam. |
| #151, #157, #214 | PRODUCER | EXECUTE P0 | Event vocabulary is thread knowledge rather than a versioned executable contract; `hold721` is asymmetric around custody/staking legs. Fix contract and parity together. |
| #121, #135 | HANDSHAKE | EXECUTE P0 | Capacity/status answers exist in comments and scripts, but Score needs a machine-readable readiness envelope: identity version, coverage horizon, event-kind coverage, watermark, and reasoned degraded states. |
| #158 | PRODUCER | EXECUTE P1 | Mad Lads has zero sale rows and a stale tail. Treat as an isolated source-restoration/backfill sprint with its own production authorization gate. |
| #179 | PRODUCER | EXECUTE P1 | Address contract class belongs in producer facts so Score never performs RPC. Sequence after event provenance and define coverage/unknown semantics. |
| #182–#186, #197–#212 | CONTROL | PROVE | CR-OPS-IDX ingest inventory. Indexing itself is caught up; each item closes only when Sonar readiness and Score consumption receipts agree. #186 remains blocked by corrected lineage. |
| #218 | CONTROL | EXECUTE P1 | Seven quarantined test files still lack owning CI lanes. PR #217 introduces a belt lane but does not prove the entire quarantine is retired. |
| #162 | CONTROL | PROVE | Cross-repo parent remains open until canonical identity and automatic projection close. Coordinator is the bus, not the source of domain truth. |
| #20, #48, #50 | PRODUCER | PARK | Events-pillar/NATS work is a separate delivery train; do not mix with the Score contract closure sprint. |
| #23 | CONTROL | PARK | ACVP scaffolds are valuable verification infrastructure, but downstream of the concrete producer/consumer receipts. |
| #70 | PRODUCER | PARK | Solana lane absorption is architectural consolidation, separate from the Mad Lads source defect. |
| #71 | CONTROL | EXECUTE P2 | Railway cleanup/cost hygiene is useful but not causal for Score truth. |
| #74 | PRODUCER | EXECUTE P2 | BGT lifecycle expansion is a new signal surface, not a prerequisite for current collection closure. |
| #111 | CONTROL | PROVE | Onboarding order is an instance of the generalized readiness/consumption protocol; avoid a bespoke path. |

## Score classification

| Issues | Truth layer | Lifecycle | Finding / route |
|---|---|---|---|
| #550, #524 | CONSUMER | PROVE P0 | Green draft PRs (#552, #551) exist. Merge, deploy, then attach live projection/alias receipts. |
| #553 | CONSUMER | EXECUTE P0 | User-visible semantic defect: an unlabeled conduit return is served as a true unstake. Fix in Score while Sonar repairs upstream provenance. |
| #548, #549 | POLICY | RULE P0 | Neutral custody in denominators and collateralized-borrow meaning are scoring rulings. Do not let Sonar or a migration choose them implicitly. |
| #487 | POLICY | RULE P0 | Repeated backtests indicate the highest-weight counter-cyclical lens predicts dumping. Remove/disable only through Score’s own governed decision cycle. |
| #513, #470 | CONSUMER | EXECUTE P1 | Both are downstream manifestations of Sonar #158. Keep Score liveness fail-closed; source restoration is owned by Sonar. #470 may become moot if #487 removes the lens. |
| #485 | CONSUMER | EXECUTE P1 | General disposal-provenance ladder consumes Sonar #179 plus event provenance. Design jointly; implement in separate repo cycles. |
| #469 | CONSUMER | CLOSE/RESIDUAL | Core input-liveness gate shipped in PR #472. Retain only the unproved distinction between legitimately quiet and producer-starved. |
| #508 | CONTROL | EXECUTE P0 | Baseline-red CI prevents unrelated delivery and therefore blocks trustworthy consumption closure. Repair before broad Score changes. |
| #501 | CONSUMER | EXECUTE P1 | Server-side member search and identity-presence facets improve agent/user ergonomics but follow correctness closure. |
| #459 | CONSUMER | EXECUTE P2 | Residual member query latency is measurable, but not the current truth bottleneck. Profile in its own pass. |
| #464 | CONSUMER | EXECUTE P1 | Identity merge observability and contestability are required before identity-derived outcomes carry stakes. |
| #242, #249, #285, #290, #297, #374, #434, #439, #441, #444, #448, #456, #463, #465, #482, #489, #494, #505, #514, #520, #522, #538 | mixed | PARK/RULE | Valid follow-ups, governance, UX, performance, or deferred experiments. None precede the producer→consumer contract spine. Preserve labels and route through their owning Score cycles. |

## Dependency cut

```text
Flatline truth
  -> collection admission / canonical identity
  -> versioned event semantics + provenance
  -> readiness / reconciliation envelope
  -> Score projection + serving proof
  -> scoring-policy rulings
  -> user-visible graduated outcome
```

This cut deliberately rejects two tempting shortcuts:

- “indexed” is not “consumed”; a Sonar row count cannot close a Score outcome.
- a Score workaround is not an upstream contract; it may preserve users while
  the producer defect remains open.

## Recommended close / merge queue

1. Close Sonar #120 with its existing production evidence.
2. Merge/deploy/prove Sonar #217 then #220.
3. Merge/deploy/prove Score #551 and #552.
4. Repair Score #508 before broad Score delivery.
5. Run the producer-contract sprint (#159, #151, #157, #214, #121, #135).
6. Run Score #553 and the policy rulings (#548, #549, #487) in Score’s own cycle.
7. Restore Mad Lads (#158/#513) as a production-isolated pass.

## Hard invariants

- Ethereum `start_block` stays `12287507`.
- `ENVIO_RESTART` stays unset.
- No floor lowering.
- No wipe or KF-013 replay without explicit operator authorization.
- One production lever per pass; evidence and commit per pass.
- No issue closes from code-green alone when merge/deploy/live consumption is
  part of the stated outcome.
