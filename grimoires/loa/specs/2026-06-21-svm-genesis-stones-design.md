---
hivemind:
  schema_version: "1.0"
  artifact_type: technical-rfc
  product_area: "sonar-api — SVM genesis-stones indexer (HyperSync-ready, RPC-now)"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "index the Purupuru genesis stones on Solana behind a substrate seam so RPC powers v1 and HyperSync-SVM swaps in at scale"}
  learning_status: directionally-correct
  source: team-internal
---

# SVM Genesis Stones — design (HyperSync-ready, RPC-now)

> **The seam is the design.** Same lesson the EVM cutover taught: put a substrate seam between the
> indexer and the source. v1 runs on **RPC** (HyperSync-SVM can't decode program instructions yet); when
> Solana HyperSync gains instruction handlers + genesis backfill, it **swaps in behind the same interface
> at scale** — a swap, not a rewrite. Designing for HyperSync now is what makes that swap cheap later.

## Target (grounded against the program)
- **Program:** `7u27WmTz2hZHvvhL89XcSCY3eFhxEfHjUN5MjzMY6v38` (`purupuru-anchor`).
- **Event:** `StoneClaimed { wallet: pubkey, element: u8, weather: u8, mint: pubkey }` — discriminator
  `[138,131,241,101,8,187,119,216]` (the 8-byte anchor prefix in the tx logs).
- **Elements (u8):** 1=Wood · 2=Fire · 3=Earth · 4=Metal · 5=Water (Wuxing).
- **Mint path:** `claim_genesis_stone` (server-signed Metaplex CPI). Bounded volume (5 elements × claimers).

## The substrate seam (the core abstraction)
```ts
interface StoneSource {
  backfill(fromSlot?: number, toSlot?: number): AsyncIterable<StoneClaimed>  // historical
  stream(): AsyncIterable<StoneClaimed>                                       // realtime tail
  health(): Promise<SenseHealth>
}
```
- **`RpcStoneSource` (v1, ships now):** `getSignaturesForAddress(program)` → `getTransaction` → match the
  `StoneClaimed` discriminator in the log messages → borsh-decode the event → emit. Or `onLogs` subscribe
  for the realtime tail. Source = free cluster RPC, `SOLANA_RPC_URL`/Helius ingress as the opt-in upgrade
  (the sense prototype already has this seam). Cheap; no validator, no Substreams.
- **`HyperSyncStoneSource` (future, stubbed):** the firehose at scale — swaps behind the SAME interface
  when Solana HyperSync ships **instruction/log handlers + genesis-depth backfill** (per
  `2026-06-20-svm-substrate-finding.md` it's early today: rolling-window, no instruction handlers — that's
  the exact gap). Same `StoneSource` contract → zero indexer change when it lands. **This is why we design
  for it now: the indexer never learns which substrate fed it.**

## The indexer (substrate-agnostic)
`StoneSource` → decode → upsert `genesis_stone` → Postgres → Hasura → **belt-gateway** (the chain-agnostic
seam: consumers query EVM + SVM through ONE gateway — the Markov blanket, extended to Solana). The
`Observation` envelope from the sense prototype is what makes this unify at the *gateway*, not at ingestion.

## Schema
```sql
CREATE TABLE genesis_stone (
  mint          text PRIMARY KEY,         -- the NFT mint pubkey
  wallet        text NOT NULL,            -- claimer
  element       smallint NOT NULL,        -- 1..5
  element_name  text NOT NULL,            -- Wood/Fire/Earth/Metal/Water
  weather       smallint NOT NULL,
  slot          bigint NOT NULL,
  sig           text NOT NULL,            -- tx signature (provenance)
  claimed_at    timestamptz NOT NULL,
  source        text NOT NULL DEFAULT 'rpc'  -- 'rpc' | 'hypersync' (which substrate observed it — auditability)
);
CREATE INDEX ON genesis_stone (wallet);
CREATE INDEX ON genesis_stone (element);
```

## Build plan (v1)
1. `StoneSource` port + `RpcStoneSource` + `HyperSyncStoneSource` stub  ← scaffolded with this RFC.
2. Anchor event decoder (discriminator match + borsh layout for the 4 fields).
3. Indexer loop: backfill from program genesis → then stream the tail → upsert (idempotent on `mint`).
4. Small Solana Postgres + Hasura (mirrors the EVM keep-set; own DB).
5. Gateway unification — a `genesis_stone` route on belt-gateway (consumers get EVM + SVM in one place).
6. Keep `source` column honest — when HyperSync-SVM swaps in, it's visible in the data.

## Why this informs the at-scale design
- **Substrate = swap, not rewrite** (the EVM cutover proved it; the seam generalizes to SVM).
- **At scale** (more programs/events), HyperSync's firehose beats RPC polling — the seam means we adopt it
  the day it's ready, with no consumer impact.
- **The gateway is the unification point** — chain-agnostic by construction, not by retrofit.
