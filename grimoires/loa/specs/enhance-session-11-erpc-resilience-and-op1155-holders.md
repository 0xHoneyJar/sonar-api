---
hivemind:
  schema_version: "1.0"
  artifact_type: product-spec
  product_area: "sonar-api — Ponder belt indexer (data validity + ownership surfaces)"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "keep the live indexer alive through bad-RPC and ship Optimism 1155 ownership so inventory-api can drop Alchemy"}
  learning_status: directionally-correct
  source: team-internal
---

# Session 11 — eRPC getLogs resilience + Optimism ERC-1155 holder balances

> The belt keeps lying to itself, and the Stash still can't see who owns the Optimism sets.
> This session makes the indexer survive a lying upstream, gives it room to breathe, and
> teaches it Optimism 1155 ownership — the last piece before Alchemy comes out.

## Context

Three workstreams, born from the #71 Railway-cleanup investigation (2026-06-15) plus the
standing `feat/per-token-ownership` migration arc:

- **WS1 (#72) — getLogs resilience [LIVE BLOCKER].** `belt-indexer-green-v3` (the live indexer
  feeding `ponder_v3`, what the gateway serves) crash-loops at a fixed Ethereum block range:
  an upstream returns a structurally-malformed `eth_getLogs` (a log entry missing the required
  `blockNumber` field), ponder rejects it (`RpcProviderError: Invalid RPC response:
  'log.blockNumber' is a required property`) and shuts down. It crashed 2026-06-15 20:07 UTC,
  was restarted, ran ~15 min, **re-crashed 21:38 at the same block** — deterministic crash-loop.
  While it is down, `ponder_v3` is frozen and every consumer (gateway, score-api, inventory) is
  served stale data. **This blocks the genesis reindex (bd-r90) that WS3 needs.**
- **WS2 (#73) — eRPC cache volume.** The finalized cache (`erpc.yaml:43-48`, `ttl: 0`) grows
  unbounded; its Postgres volume hit 100%, the `Postgres` service went Offline, and eRPC could
  not resolve it → every cache write failed → paid-HyperRPC fallthrough + (linked) the WS1 crash
  got worse with the cache cold. Stopgapped 2026-06-15 by resizing to 100GB; needs the durable fix.
- **WS3 (#62) — Optimism 1155 holder balances.** inventory-api `/holdings` + `/nfts/:contract/owner`
  cannot answer current ownership for the Optimism ERC-1155 collections (Mibera Sets, Mibera Zora):
  the `mibera-sets.ts` / `mibera-zora.ts` handlers write only `erc1155MintEvent` + `action`, no
  holder-balance table. This blocks the mibera-dimensions Alchemy→Freeside migration (cycle-022 P0).
  The Berachain Candies equivalent (`candiesHolderBalance`) already shipped FAGAN-reviewed; WS3
  extends the **same pattern**. Source spec: `mibera-dimensions/grimoires/loa/specs/bldg-sonar-optimism-1155-holder-spec.md`.

**Dependency chain:** WS1 unblocks the reindex (bd-r90) → WS3's new balances backfill in that
reindex → the migration's P0 closes. WS2 is independent hygiene (parallelizable).

**Stakes tier: DATA-VALIDITY → HIGH.** Indexer correctness + conservation invariants. The
`## Review Cadence` section is binding: every verb/layer gets the cheval-routed multimodal council.
`--skip-harden` is forbidden for this work.

## Run via — `code-implement-and-review` (REQUIRED)

`@~/.loa/constructs/substrates/construct-compositions/compositions/delivery/code-implement-and-review.yaml`

The loop: **implement (general-purpose) → FAGAN reviews the diff → apply fixes → re-review →
converge.** The operator directs at each seam (accept/redirect the review verdict). For this
HIGH-stakes work the review stage runs the **cheval-routed council** (see Review Cadence), not a
single model. Drive it with `/compose` (Form C runtime) — do not hand-run.

WS1 is a **spike-then-build**: its first iteration is investigation (feasibility of the three
fix layers), and the operator picks the approach at the spike seam before any implementation.

## Review Cadence (binding — HIGH stakes)

- Each workstream's implementation diff → **`construct-fagan/scripts/cheval-council.sh`**
  (cheval-routed multimodal council; `~/Documents/GitHub/construct-fagan/scripts/cheval-council.sh`).
  Single-model review (even multiple Claude subagents) is FORBIDDEN — one corpus shares its blind spots.
- cheval voices pin to **headless CLI adapters** (subscription auth, no API key): probe with
  `python3 .claude/adapters/cheval.py --validate-bindings`.
- The WS3 balance helper additionally carries the **candies-balance conservation test** as a
  hard gate (see Quality Rules).

## Load Order

1. `@~/.loa/constructs/substrates/construct-compositions/compositions/delivery/code-implement-and-review.yaml` — the driving loop
2. `@grimoires/loa/specs/enhance-session-11-erpc-resilience-and-op1155-holders.md` — this doc (source of truth)
3. `@mibera-dimensions/grimoires/loa/specs/bldg-sonar-optimism-1155-holder-spec.md` — the WS3 source spec (cross-repo)
4. `@ponder-runtime/src/handlers/candies-balance.ts` — the pattern WS3 replicates (FAGAN-reviewed)
5. `@ponder-runtime/src/handlers/candies-market1155.ts` — the exact handler-integration pattern
6. `@ponder.schema.ts` (lines 123-142) — the `candiesHolderBalance` table to mirror
7. `@erpc.yaml` (lines 43-55, 317-325) — the cache policy (WS2) + eth upstreams (WS1)
8. `@grimoires/loa/runbooks/candies-holder-balance-reindex.md` — the reindex procedure (WS3 backfill)
9. `@grimoires/loa/known-failures.md` (KF-012) — the getLogs-liar history (WS1 context)

## Persona

ARCH (OSTROM) + **resolved craft lens = data-integrity / invariant-correctness**. No single
construct cleanly owns "indexer data validity"; apply the closest two:
- **scar** lens for WS1/WS2 (trust boundary = "is this RPC response trustworthy?", blast radius of
  a malformed response, reversibility of a config/volume change).
- The **candies-balance FAGAN invariants** as the measurable quality bar for WS3 (conservation,
  clamp-at-0, self-transfer no-op, ZERO_ADDRESS skip).
- FAGAN (`construct-fagan`) owns the review gate. Flag (clew): sonar lacks a first-class
  "indexer-correctness" construct — this work is its recurring home.

## What to Build (in order)

### WS1 — getLogs resilience (#72) — SPIKE then build [do FIRST: unblocks the reindex]

**Grounded constraint (verified this session, do not re-derive):** eRPC **cannot** detect a
malformed `eth_getLogs` via config. Its structural response validators run only on
`eth_getBlockReceipts` (`UpstreamIntegrityConfig` has no `eth_getLogs` sibling); for getLogs the
only integrity hook is block-*range* availability. A 200 + valid-JSON getLogs with a log missing
`blockNumber` is classified **success** and passed through to ponder. This gap persists through
eRPC latest (0.1.0). Live-probe (2026-06-15): the exact crashing range returned clean empties from
publicnode + tenderly, timeout from drpc — **the lie is intermittent**, so `ignoreMethods` on one
upstream will NOT reliably catch it.

**Step 1 — SPIKE (operator picks the layer at the seam).** Investigate all three, report effort +
robustness, recommend:
1. **Ponder layer (lightest):** can ponder/viem's transport be configured or wrapped to **retry**
   the range on a schema-invalid getLogs response instead of throwing? (A transient lie resolves on
   re-fetch via eRPC's upstream rotation.) Check ponder's RPC request/retry config + whether a
   custom viem transport can intercept-and-retry the malformed response. This is the most direct fix
   — the crash is in ponder.
2. **Patch eRPC:** fork `erpc/erpc`, add an `eth_getLogs` response validator mirroring the
   `eth_getBlockReceipts` integrity hook (missing field → `ErrEndpointContentValidation` → eRPC
   walks to next upstream). Build + deploy a patched image; maintain the fork. Truest fix, heaviest.
3. **Validation sidecar:** a thin proxy in front of eRPC that validates getLogs entries and returns
   a retryable JSON-RPC error. Keeps eRPC stock; adds an always-on hot-path component.

**Step 2 — implement the chosen layer.** Acceptance: green-v3 indexes the Ethereum HoneyJar range
(`0xa20cf9b0…`/`0x98dc31a9…`, ~block `0x181fe0d`) that currently crash-loops it, with **zero**
`RpcProviderError` crashes and no climbing retry backoff. getLogs completeness unchanged (reconcile-range check).

### WS3 — Optimism 1155 holder balances (#62) [do SECOND: lands before the reindex]

Replicate the **candies-balance pattern** exactly. Canonical dir is `ponder-runtime/src/handlers/`
(the root `src/handlers/` is **dead Envio legacy** — do not touch; authority: `Dockerfile.belt-ponder`
`PONDER_ROOT=ponder-runtime`).

**1. Schema — `ponder.schema.ts`** (mirror `candiesHolderBalance`, lines 123-142). Generic, keyed
by `collectionKey` to cover sets + zora + future 1155s:
```ts
export const erc1155HolderBalance = onchainTable("erc1155_holder_balance", (t) => ({
  id: t.text().primaryKey(),                                  // `${contract}-${chainId}-${tokenId}-${holder}` (lowercased)
  holder_id: t.hex().notNull(),                               // snake_case ON PURPOSE → Hasura exposes holder_id (the inventory filter field)
  collectionKey: t.text().notNull(),                          // "mibera_sets" | "mibera_zora"
  contract: t.hex().notNull(),
  chainId: t.integer().notNull(),
  tokenId: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  amount: t.numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
  updatedAt: t.bigint().notNull(),
}), (table) => ({ holderIdx: index().on(table.holder_id), contractIdx: index().on(table.contract) }));
```

**2. Helper — `ponder-runtime/src/handlers/erc1155-balance.ts`** (generalize `candies-balance.ts`):
- `computeNextBalance(current, quantity, direction)` — clamp at 0; negative input → no-op (copy verbatim).
- `makeErc1155BalanceId(contract, chainId, tokenId, holder)` → `${contractLower}-${chainId}-${tokenId}-${holderLower}`.
- `applyErc1155Balance({context, holder, contract, collectionKey, tokenId, chainId, quantity, direction, timestamp})`
  — atomic `insert(...).onConflictDoUpdate(...)`; **skip if holder === ZERO_ADDRESS; skip if quantity === 0n.**
- `applyErc1155TransferBalances({context, from, to, contract, collectionKey, tokenId, chainId, quantity, timestamp})`
  — **self-transfer short-circuit (`from===to` → no-op)**, then debit `from` + credit `to` (every transfer).
- Pure-arithmetic + thin upsert (unit-testable without the runtime).

**Invariants (carry over from candies-balance — these are FAGAN-MAJOR-earned, non-negotiable):**
- CREDIT `to` when `to !== ZERO_ADDRESS` (incl. mint); DEBIT `from` when `from !== ZERO_ADDRESS` (incl. burn).
- Runs on **every** transfer (mint/airdrop/secondary/burn) — NOT mint-only.
- `amount` clamps at 0 (defends partial-history reindex windows).
- `from === to` is a no-op (no double-write / inflation).
- NOTE (reconcile vs candies): candies collapses two market addresses onto one `CANONICAL_CANDIES_CONTRACT`.
  Sets/zora have no such market split → key by `collectionKey` + raw `contract`, **no canonical collapse**
  unless a collection later gets a separate market contract.

**3. Wire — `ponder-runtime/src/handlers/mibera-sets.ts` + `mibera-zora.ts`** (pattern: `candies-market1155.ts`
TransferSingle ~lines 90-105 — call balances FIRST, before the mint-only early return):
- **TransferSingle**: after parsing `from/to/contractAddress/tokenId(=BigInt(id))/quantity(=BigInt(value))`
  and before the existing mint/action writes, call `applyErc1155TransferBalances(...)` with `collectionKey = COLLECTION_KEY`.
- **TransferBatch**: call it **inside** the per-token loop (before the mint-only branch), once per (id,value) leg.
- `mibera-sets.ts` is ACTIVE (chain 10). `mibera-zora.ts` is NOT active yet (contract not in `ponder.config.mibera.ts`,
  pending B-1) — write the handler wiring, but its rows won't populate until the zora contract is registered. Note this, don't block on it.

**4. Tests — `ponder-runtime/tests/erc1155-balance.test.ts`** (mirror `candies-balance.test.ts`):
mint→credit, trade→move, burn→debit, self-transfer no-op, over-debit clamp-at-0, zero-qty no-op,
**conservation across a synthetic transfer sequence** (Σ balances per (contract,tokenId) == mints − burns).
No live runtime needed.

### Reindex (bd-r90) [do THIRD: after WS1 + WS3 land]

Green reindex from genesis backfills `token` + `candies_holder_balance` + **the new `erc1155_holder_balance`**.
Follow `grimoires/loa/runbooks/candies-holder-balance-reindex.md`. **CRITICAL:** re-apply the
`chain_metadata` freshness view after the `DROP … CASCADE` (the runbook's known footgun). Operator-gated
(ADR-010, rides bd-umw.4). With WS1 landed, the reindex no longer crash-loops on the HoneyJar getLogs.

### WS2 — eRPC cache volume durable (#73) [independent — anytime]

Per #73: keep the 100GB volume + add a **~75% disk-usage alarm** (Railway metric) + a one-time and
periodic **prune of decommissioned-chain cache rows only** (`DELETE` on `erpc_json_rpc_cache` scoped to
retired chains, then `VACUUM`). **Do NOT add a blanket TTL to the finalized policy** (`erpc.yaml:44-48`) —
it would preferentially evict the deep-genesis cache that gives the 5-20x re-sync speedup. The eRPC
cache DB (`ERPC_DATABASE_URL` / `erpc_json_rpc_cache`) is the `Postgres` service, distinct from `Postgres-vRR1`.

## Quality Rules (data-integrity lens)

- **Conservation is a test, not a hope.** WS3's helper ships with the conservation invariant test
  (Σ balances == mints − burns across a synthetic sequence) as a hard gate. A diff that can't prove it doesn't merge.
- **Every balance mutation is idempotent + reorg-safe.** Single atomic `INSERT … ON CONFLICT DO UPDATE`;
  no read-then-write window (copy the candies atomic shape exactly).
- **Lowercase every address at the boundary.** id, holder_id, contract — all lowercased (the Hasura/consumer filter contract).
- **WS1: "fixed" means the crash range passes.** Acceptance is the real HoneyJar range indexing clean, not "the review looked fine."
- **WS1/WS2 reversibility:** config + volume changes must be revertable in one step; name the rollback in the PR.
- **No silent scope into the dead `src/handlers/`** — canonical is `ponder-runtime/` only.

## What NOT to Build

- **No blanket finalized TTL in erpc.yaml** (WS2) — explicitly cut; it kills the re-sync speedup.
- **No eRPC config change pretending to fix WS1** — grounded-verified impossible; the fix is ponder/patch/sidecar.
- **No new contract config for zora** in this session beyond the handler wiring (registration is B-1's job).
- **No touching the live blue stack / the #71 Tier-1/2/4 deletes** — that's separately NO-GO (see #71).
- **No reindex from an agent session** — operator-gated (bd-r90, ADR-010, green-PG≠blue-PG wipe guard).

## Verify

- **WS1:** restart green-v3 after the fix; it indexes past the HoneyJar crash range with zero `RpcProviderError`
  shutdowns (watch `railway logs -s belt-indexer-green-v3` through the range; confirm backfill % advances past 63%).
- **WS3:** `pnpm test` green on `erc1155-balance.test.ts` (incl. conservation). Post-reindex: a known Sets holder's
  `erc1155_holder_balance` rows (amount>0) match on-chain holdings; inventory-api `/nfts/0x886d2176…/owner/:addr`
  (chain 10) returns those tokenIds; Σ per (contract,tokenId) == circulating supply.
- **WS2:** volume usage has a monitored ceiling + alarm; the prune reclaims decommissioned-chain rows; active-chain
  finalized cache retained.

## Key References

| Topic | Path |
|---|---|
| WS3 source spec (cross-repo) | `mibera-dimensions/grimoires/loa/specs/bldg-sonar-optimism-1155-holder-spec.md` |
| Pattern to replicate | `ponder-runtime/src/handlers/candies-balance.ts` |
| Integration pattern (call-first) | `ponder-runtime/src/handlers/candies-market1155.ts` (~L90-105) |
| Schema to mirror | `ponder.schema.ts:123-142` (`candiesHolderBalance`) |
| Handlers to wire | `ponder-runtime/src/handlers/{mibera-sets,mibera-zora}.ts` |
| Test posture | `ponder-runtime/tests/candies-balance.test.ts` |
| Reindex runbook | `grimoires/loa/runbooks/candies-holder-balance-reindex.md` |
| eRPC cache policy (WS2) | `erpc.yaml:43-55` |
| eRPC eth upstreams (WS1) | `erpc.yaml:317-325` |
| getLogs-liar history | `grimoires/loa/known-failures.md` (KF-012) |
| Sets contract (chain 10) | `0x886d2176d899796cd1affa07eff07b9b2b80f1be` (tokenIds 8-11 Strong, 12 Super) |
| Zora contract (chain 10) | `0x427a8f2e608e185eece69aca15e535cd6c36aad8` (not yet registered) |
| GitHub issues | #72 (WS1), #73 (WS2), #62 (WS3) |

## Review provenance + Open operator decisions

**Grounded this session (2026-06-15):**
- eRPC v0.0.64→0.1.0 has NO config-level `eth_getLogs` response validation (verified vs config schema +
  docs; `UpstreamIntegrityConfig` exposes only `eth_getBlockReceipts`). → WS1 cannot be an erpc.yaml edit.
- Live probe: the crashing getLogs range returns clean empties from publicnode/tenderly, timeout from drpc →
  the malformed response is **intermittent**, not a single deterministic upstream → `ignoreMethods` insufficient.
- WS3 pattern fully mapped from `candies-balance.ts` + `candies-market1155.ts` + `ponder.schema.ts` (grounded, real).
- Canonical handler dir = `ponder-runtime/` (root `src/handlers/` is dead Envio legacy; authority: Dockerfile.belt-ponder).
- green-v3 confirmed crash-looping at 20:07 + 21:38 on HoneyJar1/HoneyJar6 (`config.yaml:571-572`) getLogs.

**Open operator decisions (do not silently resolve):**
1. **WS1 layer** — operator chose "investigate all 3, recommend in doc." The spike (Step 1) decides
   ponder-retry vs eRPC-patch vs sidecar at the seam. Ponder-retry is the lightest if feasible.
2. **Live freeze** — operator chose to fold the #72 fix into this session (no immediate hotfix);
   `ponder_v3` stays frozen until WS1 lands. Re-confirm acceptable if the freeze window grows.
3. **Reindex timing** — bd-r90 is operator-gated; sequence it after WS1 + WS3 merge.
