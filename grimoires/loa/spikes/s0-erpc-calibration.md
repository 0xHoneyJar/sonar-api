# S0 — eRPC Calibration Spike

> **Cycle**: indexer-belt-rebuild · re-sprint **S0** (SDD r4 §3.4, OD-3) · 2026-05-20
> **The experiment H1 rests on.** Public-RPC-only — no free-tier accounts (operator
> decision 2026-05-20).
> **Status**: S0-T1 ✓ resolved · S0-T2 ✓ resolved — **S0 COMPLETE** (2026-05-20)

## H1 — the hypothesis under test

> *Free public Berachain RPC, fronted by eRPC caching + hedging, can cold-sync the
> Mibera belt from block `3837808` to chain head at a usable rate.*

No preset pass/fail — S0 **measures**, the operator judges viability (SDD §11 OD-3).

## S0-T1 — Berachain `80094` public-RPC cluster (OD-1) — RESOLVED

Enumerated from Chainlist + probed 2026-05-20. All 4 verified live on chain `80094`
(`eth_chainId` → `0x138de`). Chain head at probe time: block **21,120,572** (`0x142463c`).

### OD-1 endpoint table

| Endpoint | chain 80094 | `eth_getLogs` range cap | Role in the eRPC cluster |
|---|---|---|---|
| `https://rpc.berachain-apis.com` | ✓ | **100,000 blocks** | primary (highest cap) |
| `https://berachain-rpc.publicnode.com` | ✓ | **50,000 blocks** | secondary |
| `https://rpc.berachain.com` | ✓ | 10,000 blocks | hedge / failover (official) |
| `https://berachain.drpc.org` | ✓ | 10,000 blocks | hedge / failover (dRPC free tier, no account) |

All anonymous / no-account / $0. None require an API key → **no Railway secret needed
for the L1 layer** (simplifies SDD §10.3 secrets posture for Deployment #1).

Observed `eth_getLogs` cap errors (verbatim, for S1 `erpc.yaml` tuning):
- `rpc.berachain.com` → `-32614 "eth_getLogs is limited to a 10,000 range"`
- `berachain-rpc.publicnode.com` → `-32701 "exceed maximum block range: 50000"`
- `rpc.berachain-apis.com` → `-32602 "query exceeds max block range 100000"`
- `berachain.drpc.org` → `code 35 "ranges over 10000 blocks are not supported on freetier"`

### Cold-sync arithmetic

- Belt sync range: head `21,120,572` − earliest start `3,837,808` (MiberaCollection) =
  **~17.28M blocks**.
- `eth_getLogs` windows for a full historical scan:
  - at 100k cap (berachain-apis): **~173 windows**
  - at 50k cap (publicnode): ~346 windows
  - at 10k cap (berachain.com / dRPC): ~1,729 windows
- The 2 belt contracts batch into shared windows (queried by address set).
- Block / transaction fetches land only on blocks with matching Mibera logs — the belt
  contracts are low-volume (one loan contract; one 10k-NFT collection's transfers), so
  the targeted block/tx fetch count is bounded, **not** 17M.

### S0-T1 read

Encouraging for H1 — but **not the H1 verdict**. 4 working public endpoints, no
signups, no keys. The `eth_getLogs` caps are workable: even the worst (10k) is ~1,729
windows for the entire history; the best (100k) is ~173. eRPC will hedge across all 4,
using `berachain-apis` as the high-cap primary and failing over to the others.

What S0-T1 does **not** tell us — and S0-T2 must measure: the end-to-end cold-sync
*rate* under sustained load — per-endpoint rate-limiting once we hammer them, block/tx
fetch volume, eRPC + Envio overhead, whether any endpoint degrades or blacklists. Static
caps ≠ throughput.

## S0-T2 — cold-sync rate measurement through eRPC — RESOLVED

eRPC **v0.0.64** stood up disposably (local docker container; 4-upstream Berachain
cluster from the S0-T1 table; memory cache; `finality: finalized` cache policy). The
Mibera belt's RPC access pattern — `eth_getLogs` for the 2 belt contracts + block
fetches — was driven through it from block `3837808`.

### Measured directly

| Metric | Cold (cache empty) | Warm (cache hit) | Cache speedup |
|---|---|---|---|
| `eth_getLogs` scan (both belt contracts, 30k-block windows) | **~39,060 blocks/sec** | ~191,573 blocks/sec | **4.9×** |
| `eth_getBlockByNumber` (full tx) | **~61 ms/block** | ~3 ms/block | ~20× |
| Errors / rate-limiting | **0** across ~124 calls (100 getLogs + 24 block) | — | — |

- Identical **16,579 logs** returned on the cold and warm getLogs passes; warm ~5×
  faster — empirically confirming SDD §3.1's *"the cache compounds."*
- **eRPC config finding**: eRPC's default getLogs `maxAllowedRange` is **30,000**
  blocks (`ErrGetLogsExceededMaxAllowedRange` on larger). The walk used 30k windows.
  → **S1 `erpc.yaml` task**: enable eRPC getLogs auto-splitting (or raise the range) so
  the Envio belt can request arbitrary ranges and eRPC splits to per-upstream caps.

### Extrapolated — the cold-sync estimate

- Sync range ~17.28M blocks (`3,837,808` → head `21,120,572`).
- **getLogs scan**: 17.28M ÷ 39,060 ≈ **~7.4 min** cold (~1.5 min warm).
- **block fetches**: 16,579 logs in the 1.5M-block sample → extrapolated ~150-250k
  events full-range (density is non-uniform — the MiberaCollection mint surge is
  early-weighted) → ~80-150k distinct event-blocks. At 61 ms/block sequential ≈
  1.5-2.5 h; with Envio's concurrent RPC fetching, realistically tens of minutes.
- **Cold-sync total: order of minutes to low hours — not a multi-day stall.**
  Re-syncs (cache-warm) are ~5-20× faster.

### S0-T2 read — for the operator's judgment (no preset pass/fail)

**Strongly encouraging for H1.** Free *public* Berachain RPC fronted by eRPC cold-syncs
the Mibera belt in reasonable time, **zero rate-limiting observed**, with a real 5-20×
cache speedup on re-syncs. Nothing in S0 suggests H1 fails — public-only (the hardest
case) looks viable.

Honest unknowns — resolved only by the actual S2 Envio run, not by extrapolation:
- Total event/block density (extrapolated from a 1.5M-block sample).
- Envio HyperIndex's real RPC fetch pattern + concurrency.
- Sustained-load rate-limiting over a multi-hour full sync (the S0 sample was ~124
  calls; a full sync is ~600 getLogs + ~100k+ block fetches — far more sustained).

### Recommendations carried to S1

1. `erpc.yaml` — enable eRPC getLogs auto-splitting / raise `maxAllowedRange`.
2. `erpc.yaml` — swap the spike's memory cache for the **persistent Postgres** connector
   (SDD §3.2/§3.3) so the re-sync speedup survives redeploys.
3. §7.4 sync-lag alert — cold-sync reaches head in minutes-to-low-hours; the SDD §8
   initial thresholds (>300 blocks / >10 min) are reasonable; tune after the first S2 sync.
4. eRPC v0.0.64 + the spike `erpc.yaml` schema (4 upstreams, cache policy) **validated
   working** — S1 inherits it.

_Spike teardown: the disposable eRPC container + `/tmp` configs are removed (NET-0-LOC
— nothing added to the repo but this findings artifact)._
