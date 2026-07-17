# CR-011A — Public trust-stream producer (Sonar)

Sonar emits **public** capability and ownership evidence on CR-009 signed
trust streams. This is distinct from the events-pillar NATS mint envelopes.

## Streams

| Stream ID | Capability | Evidence |
|---|---|---|
| `sonar.public-capability.v1` | `collection-report.capability-evidence.v1` | Registry snapshot deltas / capability state |
| `sonar.public-ownership.v1` | `collection-report.ownership-evidence.v1` | Public-chain ownership observations |

Restricted Discord/identity streams are CR-011B — out of scope here.

## Producer invariants

1. **Transactional outbox** — sequence allocation and envelope persistence
   happen in one atomic step (`TrustStreamOutboxStore.appendAtomic`). No
   dual-write to NATS + Postgres.
2. **Contiguous sequence** — when `trust_stream` is true, each append uses
   exactly `nextSequence` for the active epoch. Gaps are impossible from a
   healthy producer.
3. **Idempotency** — `event_id` is unique per stream; duplicates fail closed
   before signing.
4. **Epoch reset** — seal the prior epoch with a signed baseline
   (`signEpochBaseline`) before `resetEpoch` advances `stream_epoch` and resets
   sequence to 1.
5. **Range replay** — `replayRange(from, to)` returns envelopes for Ordering
   gap repair and Sonar-to-Ordering rehearsal (G1B-1).
6. **Failover** — `failoverClone()` hydrates a fresh store from snapshots so a
   restarted cell continues contiguous emission without sequence reuse.

## Signing keys

Production custody is CR-013 (`@freeside/signing-key-custody-protocol`). This
worktree ships **fixture keys only** via `@freeside/trust-envelope-protocol`
(`sonar-fixture-*` ids). Hermetic tests prove wire adoption, not KMS release.

## Wire dependency

Envelope schemas, signing bytes, and shared producer/consumer fixtures come from
`@freeside/trust-envelope-protocol` (vendored under `vendor/trust-envelope-protocol/`).
Do not hand-mirror header fields in Sonar.

## Retention

Capability registry view retention (~90 days after supersession) is owner-TBD.
This module exposes replay from the in-memory outbox only; durable retention SLO
is a follow-on once Postgres outbox lands.
