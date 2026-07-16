# CR-103 — EVM NFT Probe Adapter

Production-shaped `NetworkAdapterPort` for configured EVM mainnets.

## Ownership

| Surface | Role |
|---|---|
| `createEvmNftProbeAdapter` | Probe entry behind CR-102 `NetworkAdapterPort` |
| `EvmRpcPort` | Injected abort-aware RPC; pins reads to one observation block |
| `ChainQualifiedIndexStatusPort` | Kitchen status seam (observed index only) |
| `EvmMetadataEnrichPort` | CR-004 `ResolverMetadataPort.enrich` for `contractURI` only |

## Invariants

1. **No user RPC / chain defs** — capability registry selects networks; RPC port is injected.
2. **One normalization** — `normalizeAddressOnce` at the adapter boundary; preserve chain-qualified identity thereafter.
3. **One monotonic clock** — `deadline_at_ms` comparisons use the injected `MonotonicClock` shared with CR-102; never `Date.now()` / wall-clock fallbacks.
4. **Bytecode first** — empty code is a conclusive miss; transport/quorum/timeouts are typed `unavailable` / `timeout`.
5. **Healthy reverts ≠ outages** — `supportsInterface` / `name` / `symbol` / `contractURI` reverts are absent evidence.
6. **Honest standards** — ERC-721 / ERC-1155 from explicit interface bits; both-true or neither → `unknown` / `ambiguous`, never report-ready. `name()` cannot upgrade missing ERC-165 evidence.
7. **Metadata** — bounded `contractURI` only via CR-004; never `tokenURI(0)` or a parallel HTTP client. Optional remote enrich runs only after required contract / interface / proxy / index evidence, against a strict sub-budget (cap + fraction + post-metadata reserve) that ends materially before `request.deadline_at_ms`, reserving time for projection and return under CR-102's outer race. The post-metadata reserve has an immutable safety floor (`POST_METADATA_RESERVE_SAFETY_FLOOR_MS`); operator `post_metadata_reserve_ms` may raise the desired reserve, never lower the effective value below the floor (including `0` / tiny overrides). If the floor cannot fit before the outer deadline → skip enrich immediately. Rejected / timed-out / hostile remote metadata degrades quality without erasing recognition (typed wrap — never defect → `rpc_transport_failed`).
8. **Proxy honesty** — EIP-1967 slot + implementation digest only when bytecode observed. Nonzero slot with incomplete address/code/digest omits `binding_evidence` (CR-102 refuses cache writes).
9. **Binding** — complete source-derived digests/position/finality/standard/proxy/policy or omit binding.
10. **Index status** — observed Kitchen lookup before optional remote metadata; `index_support` only bounds possibility.
11. **Canonical diagnostics** — map stable `safe_code` values to locally owned `SAFE_MESSAGES` only; never trust dependency `safe_message` verbatim (strip URLs, endpoints, provider names, credentials, bodies).

## Non-goals

- Robinhood Chain enablement (CR-401)
- Production provider wiring / quorum client implementation
- Solana DAS (CR-104)
