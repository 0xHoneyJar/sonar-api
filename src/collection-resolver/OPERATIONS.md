# Recognition operations runbook (CR-107)

Operator controls for collection recognition observability, per-network disable
(via CR-101), and global admission full-stop. This document names the degraded
and full-stop procedures.

## Honest external blocker (read first)

**This package provides a validated process-local substrate only.** It ships:

- typed operational events + strict observer enforcement
- in-process CR-101 LKG snapshot store (`applyTransition` only after bootstrap)
- process-local admission full-stop
- hermetic proofs of the above contracts

It does **not** yet satisfy fleet-wide “disable without deploy.” There is still
no durable control transport and no concrete telemetry exporter in this repo.
Do not invent an admin UI, Redis, NATS, Prometheus scrape path, or fake
production control plane here — those are external integration work. Until a
real runtime transport feeds the same validated apply APIs across replicas,
operators can only exercise disable / full-stop inside a single process.

## Surfaces

| Surface | Authority | Notes |
|---|---|---|
| CR-101 capability registry | Sole per-network disable | Versioned transitions only; no parallel kill-boolean list |
| Live capability snapshot store | Runtime LKG pin | Bootstrap with validated snapshot; every later advance via `applyCapabilityRegistryTransition` only (no public replace bypass) |
| Global admission control | `open` \| `full_stop` | Separate from the rate limiter (overload ≠ full-stop) |
| Circuit breaker | Transient probe health | Observability only; never auto-converts to CR-101 disable |
| Typed operational events | Low-cardinality metrics | Strict decode + identity/allowlist enforcement; no user identity / raw identifiers |

## Degraded procedure (single network)

Use when one network is unhealthy, timing out, or returning bad probe data and
you need to stop new recognition work against it without a deploy **within this
process** (fleet-wide still blocked on durable transport — see above).

1. **Publish a valid next CR-101 transition** that disables only the affected
   network (integrity or operator-policy disable tuples per
   `capability-registry/PROTOCOL.md`). Sequence must be contiguous
   (`current + 1`). Do not invent a side-channel boolean list.
2. **Apply through the live snapshot store**
   (`createMemoryCapabilitySnapshotStore.applyTransition` or the deployment’s
   equivalent). Do not reconstruct resolver dependency graphs for a valid
   disable. Do not hot-replace the live snapshot outside CR-101 transitions.
3. **Verify**:
   - Snapshot version advanced to the expected `(registry_epoch, registry_sequence)`.
   - `selectDefaultRecognizeNetworks` / next `resolveBounded` request excludes
     the target network (before breaker and adapters).
4. **Preserve evidence** according to the transition’s declared
   `prior_evidence_revocation_policy` and normative effects. Do not treat cache
   eviction alone as remediation.
5. **Restore** only via another valid contiguous CR-101 transition after the
   network recovers. Invalid / noncontiguous / downgrade transitions retain the
   last-known-good snapshot and return a typed safe error.

## Full-stop procedure (global admission)

Use when recognition must stop entirely — incident, integrity event, or
controlled maintenance — while preserving existing evidence and caches
(**process-local** until durable transport exists).

1. **Close global admission** (`AdmissionControlPort` → `full_stop`).
2. **Verify**:
   - New requests fail with typed `ResolverAdmissionFullStopError` after
     structural preflight.
   - Zero new adapter starts.
   - Rate limiter and coalesce are not consulted (full-stop is before
     rate / cache / coalesce / fanout).
   - No cache serving for new demand.
3. **Preserve** existing evidence, negative/positive caches, and in-flight
   request pins (in-flight requests keep their captured snapshot version).
4. **Reopen deliberately** (`open`). Prove requests resume with adapters and
   normal terminal outcomes.

Full-stop is not rate limiting. The global rate limiter sheds overload; admission
full-stop is an explicit operator gate.

## Circuit breaker vs explicit disable

| | Circuit breaker | CR-101 disable |
|---|---|---|
| Trigger | Transient probe failures / timeouts | Versioned operator/integrity transition |
| Scope | `network + operation` | Capability catalog row |
| Auto? | Yes (closed → open → half_open) | Never automatic from breaker health |
| Precedence | Checked only for networks still in the snapshot search set | Disable removes the network from search before the breaker |
| Observability | `circuit_transition` events (`network_key`, from/to) | Snapshot version + search exclusion |

Never automatically convert breaker-open into a capability disable. Operators
choose disable via CR-101 when transient shedding is insufficient.

## Last-known-good (LKG) reload failure

If a transition fails decode, validation, signature, contiguity, or reason
binding:

- The prior snapshot remains the live LKG.
- The store returns a typed `CapabilitySnapshotStoreError` (safe codes only).
- In-flight requests that already pinned a snapshot are unaffected.
- Operators must correct the transition envelope and retry; do not hot-patch
  network rows outside CR-101.

## Per-process limitations (blocker detail)

- The in-memory snapshot store and admission control are **process-local**.
- Multi-replica / fleet-wide disable and full-stop require a durable control
  transport that feeds the same validated apply APIs — **not shipped here**.
- Circuit breakers are also process-local.
- Typed events are accepted into an in-process observer only; concrete
  Prometheus/OTLP exporters, dashboards, and alerts are deployment work.
- `resolveBounded` remains the sole owner of aggregate `MetricsPort` counters;
  observer event recording never mirrors those counters and cannot double-count.
- Live observer allowlists retain registry-authorized keys across transitions so
  requests pinned before a disable can still emit attributable terminal events.

## Telemetry wiring (downstream)

Typed events distinguish:

- identifier format (`evm_address` \| `solana_public_key` \| `unclassified`
  for pre-classification terminals only)
- network key (registry-derived allowlist only)
- network outcome (`hit`, `conclusive_miss`, `unavailable`, `timeout`,
  `circuit_open`, `disabled`)
- terminal outcome (`complete`, `partial`, `zero_result`, `rate_limited`,
  `full_stop`, `rejected`, `failed`) — exactly one `resolver_terminal` per
  resolve exit via an idempotent request-local finalizer
- resolver role `capability` means the pinned catalog admitted zero healthy
  targets; it is zero work, not an adapter execution failure
- candidate count bucket, cache outcome, circuit transitions
- bounded work units (`adapter_attempts`) — not dollar billing

Demand is emitted only after structural preflight succeeds. Do not emit raw
addresses, caller buckets, auth/community/user/order identity, cache keys,
digests, provider URLs/bodies, or arbitrary exception text as labels.
