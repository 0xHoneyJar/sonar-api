# JetStream deferral — pull path SoT (T5 / br-lzg)

**Date:** 2026-07-19  
**Status:** DEFERRED (falsifier met)  
**Decision target remains:** NATS JetStream + per-kitchen outbox (PRD rank 1)

## Falsifier

Sprint T5: *Defer if still single consumer; SNS→SQS falsifier if no NATS owner.*

Current state:

- Product consumers of `ownership.ready` / `prep.failed` are **not** yet multi-subscriber on a bus.
- Score kitchen (T6) is not landed.
- Order counter (T8) will pull or subscribe later.
- **No NATS operator / JetStream cluster** is owned for this slice.

Therefore week-0–2 **pull outbox** remains the product SoT:

| Proof | Surface |
|-------|---------|
| 1 Outbox committed | `kitchen_outbox` on job complete/fail |
| 2 Transport accepted | `POST /v2/outbox/relay-pull` or consumer GET |
| 3 Consumer acted | Score inbox / order saga (separate) |

## Subject ACL contract (when JetStream lands)

Streams (normative names — do not invent synonyms):

| Stream | Subjects (publish) | Intended subscribers |
|--------|--------------------|----------------------|
| `FS_FACTS` | `ownership.ready`, `ownership.changed`, `catalog.*` | Score kitchen; ops intake |
| `FS_OPS` | `belt.tip_lag`, robot triage cues | Ops / agents only |
| `FS_FAILURES` | `prep.failed`, terminal redelivery | Order counter; ops |

**ACLs (intent):**

- Sonar kitchen: publish `ownership.*`, `prep.*`, `belt.*` — no subscribe to `catalog.*` for mutation.
- Score kitchen: subscribe `ownership.ready` only (initial); publish `catalog.*`.
- Order counter: subscribe `ownership.ready`, `prep.failed`; publish `order.*` only.
- Dashboard: **no** NATS credentials (HTTP pull / SSE only).

## SNS→SQS fallback

If JetStream remains unowned when fan-out >1: same envelopes, swap transport adapter only — no semantic change (SDD §5 falsifier).

## Resume criteria

Re-open JetStream work when **any** of:

1. Named NATS owner + cluster URL in ops runbook.
2. Second live bus consumer of `ownership.ready` (beyond pull).
3. Slice week pressure requires ACL-enforced fan-out.

Until then: do not block T6/T8/T11 on JetStream.
