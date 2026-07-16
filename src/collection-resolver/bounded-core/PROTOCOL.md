# CR-102 Bounded Resolver Core Protocol

Strict, deterministic orchestration for mainnet collection recognition.

## Ownership

| Surface | Role |
|---|---|
| `resolveBounded` | Pure orchestration entry — no RPC/DAS of its own |
| `NetworkAdapterPort` | CR-103 / CR-104 live adapters implement this |
| `InventoryEnrichmentPort` | Optional CR-105 enrichment; failure is typed partial |
| `InvalidationEdgePort` | Emits equivalence-revocation impact for CR-012A |
| CR-101 snapshot | Sole search target catalog — no user RPC/chain defs |

## Budgets (SDD §5.3 ceilings)

| Budget | Ceiling |
|---|---|
| Global interactive deadline | ≤ 4000 ms |
| Per-network deadline | ≤ 1500 ms |
| Concurrent probes / request | ≤ 6 (min 1; `0` fails preflight) |
| Searched networks / request | ≤ 8 |
| Negative cache TTL | < readiness TTL < positive TTL |

Raising ceilings requires a contract-version update and load evidence.

## Invariants

1. **Strict config decode first** — public `resolveBounded` strict-decodes the
   complete excess-property-free config (concurrency, network count, deadlines,
   cache TTLs, rate limits, circuit policy) before cache, rate-limit, coalesce,
   or adapters. `max_concurrent_probes: 0`, overflow, malformed, or excess
   properties fail preflight and cannot write cache.
2. **Structural preflight next** — incomplete identifiers fail before search,
   cache lookup, rate-limit debit, coalesce, or adapter calls. Public errors
   carry digests / safe reasons only — never raw identifiers.
3. **Exact CR-101 healthy mainnet recognize only** — `selectDefaultRecognizeNetworks`;
   no implicit fallback; degraded requires diagnostic opt-in (not default).
4. **Deadlines cancel** — every adapter / Inventory / async-port settlement is
   converted to exactly one fiber (never `runSyncExit`-probe then
   `runPromise`-fallback) and raced against per-network and global deadline
   promises (injected monotonic clock/timer ports). The controlling task never
   directly awaits an unbounded adapter promise. Either expiry aborts the
   adapter signal and seals a timeout immediately. Bounded workers complete when
   every task is settled or timed out — not when ignored-abort promises
   eventually resolve. Late handlers only consume that same execution's
   rejection / discard value; late settlements cannot mutate diagnostics, cache,
   or candidates. Metrics/concurrency/circuit accounting tracks real external
   starts. The same global deadline stays active through optional Inventory
   enrichment, ranking, response sealing, and cache-write decision.
5. **Deterministic fanout** — search order is registry priority then network key;
   completion order cannot change the canonical ranked candidate set.
6. **Separate caches** — positive recognition, report-readiness, and negative
   probes use distinct keys and TTLs. Positive bindings include **only observed**
   capability snapshot/version/source sequence, deployment/account/code digests,
   observed position/finality, standard/proxy evidence, per-candidate Inventory
   enrichment/equivalence version (exact deployment match), authorization-safe
   scope, and adapter policy version. Missing binding evidence → recognized
   partial/unready diagnostics; **no** positive/readiness cache write. Late
   Inventory/binding evidence after the global deadline also forbids
   positive/readiness writes. Never fabricate digests, positions, or proxy flags.
7. **Invalidation** — disable/security, identity/code/account drift, reorg below
   finality, capability/finality/adapter policy change, and Inventory equivalence
   revocation refuse/evict cache. Equivalence revocation is **transactional /
   fail-closed**: strict-decode the canonical CR-012A impact, persist/ack the
   edge first, only then evict. Decode/store failure → report failure, do not
   claim `edge_emitted`, do not evict. `eviction_alone_insufficient: true`.
8. **Negative cache honesty** — write only when every declared covered healthy
   target returned a conclusive not-found/unsupported miss. Timeout, transient,
   breaker-open, cancellation, or partial coverage forbids authoritative negative
   caching. Recovery must probe again.
9. **Rate limits + coalesce** — caller + global windows with bounded cardinality;
   typed 429 with safe `retry_after_ms`. In-flight registry stores one shared
   immutable sealed result per canonical request key. Followers await the leader
   only up to their own remaining global deadline, then receive the same sealed
   response (with safe coalesced diagnostic) or a typed partial timeout — never
   a fabricated empty result while the leader later returns candidates. The
   in-flight entry is cleaned exactly once after the leader settles; errors are
   shared safely without raw causes.
10. **Circuit breakers** — per `network+operation`; closed/open/half-open with
    bounded probes; monotonic server time; CR-101 disable/security precedes the
    breaker.
11. **Diagnostics** — bounded, partial-aware, secret-redacted; no credentials,
    raw provider bodies, private metadata, raw decode causes, or user identity in
    high-cardinality labels. Typed public errors use safe reason codes, bounded
    redacted summaries, and optional stable digests.

## Ranking

Deterministic: exact Inventory match → supported standard → indexed → readiness
→ stable network/deployment canonical key. Ranking reasons and evidence quality
are returned. No address-only aliasing or cross-network guessing.

## Load harness

Deterministic virtual-clock harness with independent cold (uncached fanout) and
warm (partitioned cache/query) phases. Tracks cold adapter calls and cold
successful completions separately from warm. `uncached_fanout_met` uses **cold
calls only** against a non-configurable floor (`cold_iterations × expected
healthy targets`). Acceptance success floor is derived from iterations × 0.75
and cannot be lowered by caller options. Denominator includes every
failure/rate-limit. Warm cache/coalescing metrics are separate observations.
Four-second acceptance requires the documented success floor and cold uncached
fanout.

## Honest downstream blockers

- **CR-103** — EVM NFT probe adapter (`adapters/evm`) lands behind `NetworkAdapterPort`; production provider-set/quorum client wiring remains deployment work
- **CR-104** — live Solana DAS adapter behind `NetworkAdapterPort`
- **CR-105 / Inventory** — production enrichment contract behind the port
- **CR-106** — Dashboard BFF consumes Ordering's session API (not this core)
- **CR-107** — typed recognition observability + operator controls
  (`operations/`, `OPERATIONS.md`): idempotent per-request `resolver_terminal`
  finalizer, live CR-101 LKG store (bootstrap + `applyTransition` only),
  global admission full-stop, strict observer decode + registry network_key
  allowlist. Process-local substrate only — fleet-wide durable control
  transport / concrete exporters remain an explicit external blocker.
- **CR-012A** — Ordering consumes `EquivalenceRevocationImpact` edges
