# S0 — eRPC Calibration Spike

> **Cycle**: indexer-belt-rebuild · re-sprint **S0** (SDD r4 §3.4, OD-3) · 2026-05-20
> **The experiment H1 rests on.** Public-RPC-only — no free-tier accounts (operator
> decision 2026-05-20).
> **Status**: S0-T1 ✓ resolved · S0-T2 ⏳ pending (cold-sync rate measurement)

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

## S0-T2 — cold-sync rate measurement — PENDING

Stand eRPC up disposably over the S0-T1 cluster, cold-sync the Mibera belt from block
`3837808` through it, and measure: blocks/sec throughput, eRPC cache hit/miss, each
endpoint's error rate / blacklist events, stall vs progress. Half-day box. No preset
pass/fail — record the observed rate; the operator judges. Output feeds the §7.4
sync-lag threshold and the S1 sequencing recommendation.
