---
title: Per-tokenId ERC-1155 holder balance (trackedHolder1155)
issue: 0xHoneyJar/sonar-api#62
bead: bd-qua
status: implemented (green/Ponder); deploy-pending (blue-green reindex)
plane: contract + execution
domain: shared
date: 2026-06-03
---

# sonar-api#62 — Per-tokenId ERC-1155 holder balance

## Problem (observed failure)

sonar-api tracks ERC-1155 holdings at **whole-contract** granularity only:
`trackedHolder.id = {contract}_{chainId}_{address}`, `tokenCount` sums every
edition. `apiculture` (`0x6cfb9280767a3596ee6af887d900014a755ffc75`, Base 8453)
is multi-edition — only **token-id 4** is the Purupuru edition; ids 1,2,3,5,6
are unrelated and widely held. score-api needs each wallet's **current balance
of token-4 specifically** and can't get it, so its `apiculture` factor falls
back to lifetime gross inflow (never subtracts sends). Measured distortion:

- a wallet holding **2,575** token-4 on-chain scores **12,993** (~5× inflated);
- a router contract holding **0** scores **8,404**.

Both land at the top of the Purupuru leaderboard — the dominant top distortion.

Per-token **event** data already exists (`mint1155`/`transfer1155`/`burn1155`
carry `numeric2 = tokenId`); only the **balance/holder** side is whole-contract.

## Decision (operator-confirmed 2026-06-03)

Add a **general, community-agnostic** per-token holder entity, **populated by the
puru-family handler only** (apiculture + elemental_jani + boarding_passes +
introducing_kizuna — all 4 already live in one handler). Blast radius = 1 handler
× the Ponder (green/production) runtime. Other 1155 handlers may adopt the shared
helper later. In-repo precedent: `badgeBalance` already does per-tokenId 1155.

Rejected alternatives: apiculture-only (special-cased, not reusable); all-1155
fan-out (speculative, larger reindex/storage for no-consumer collections).

## Implementation (green / Ponder runtime)

| File | Change |
|---|---|
| `ponder.schema.ts` | New `trackedHolder1155` onchainTable: id `{contract}_{chainId}_{tokenId}_{address}`, fields contract/collectionKey/chainId/tokenId(numeric78)/address/balance(numeric78)/lastUpdated; indexes on address, collectionKey, (contract,chainId,tokenId). |
| `ponder-runtime/src/lib/erc1155-holder.ts` | Pure helpers (the entire new logic, unit-tested): `erc1155HolderId`, `nextBalance` (floor-at-zero + delete-on-empty), `aggregateBatchDeltas` (per-tokenId batch rollup). |
| `ponder-runtime/src/handlers/puru-apiculture1155.ts` | New `adjustHolder1155Token` (per-token twin of `adjustHolder1155`); called per-tokenId from TransferSingle and from the aggregated batch in TransferBatch. Whole-contract `trackedHolder` behavior unchanged (additive). No new action emitted — events stay exactly as they are (#62 constraint). |
| `ponder-runtime/tests/erc1155-holder.test.ts` | 16 unit tests over the pure helpers (id-keying, balance math, batch aggregation incl. repeated-id sum + length-mismatch). |

Whole-collection count stays `trackedHolder.tokenCount`; whole-collection from
here = `SUM(balance)` over tokenId, so single-edition collections are unaffected.

## Consumer contract (score-api)

score reads per-token balance as a **fact** and drops its balance-reconstruction:
query `trackedHolder1155` filtered by `contract` + `chainId` + `tokenId` (apiculture
token-4) → `balance` per `address`. `balance` is uint256-safe BigInt (matches
`trackedTokenBalance.balance`).

## Deploy dependencies (NOT code — required before the consumer benefits)

Deploy order: **(1) reindex → (2) Hasura track → (3) score-api repoint.** All three
must land in one window or apiculture scoring stays broken.

1. **Full blue-green reindex from genesis** (apiculture startBlock 13,803,165, Base).
   No backfill script — the new entity is empty until reindex. Rides the in-flight
   green-build rail (`bd-umw*`). ~10–15 min cold-start; real-world 30 min–2 h.
2. **Hasura tracking — AUTO.** `scripts/cutover-hasura-tracking.sh` derives its
   allowlist from `information_schema.tables WHERE table_schema='ponder'`, so once
   `tracked_holder_1155` exists post-reindex it is tracked at cutover with no manual
   metadata edit. Caveat: it is a *new ponder-only* table (no envio snapshot), so its
   consumer-facing root field is the default (`trackedHolder1155` / `tracked_holder_1155`),
   NOT a baked PascalCase `TrackedHolder1155` like the envio-era tables. The
   `test/hasura-contract/metadata-diff.test.ts` snapshot will need regenerating to
   include the new table.
3. **score-api consumer PR (separate)** — repoint the apiculture factor to read
   `trackedHolder1155.balance` filtered by contract + chainId + tokenId=4, and drop
   its gross-inflow fallback. score currently reads `hold1155` actions, not
   `TrackedHolder` by name, so the new query is additive.

## Scope boundary (intentional)

**Green/Ponder only.** Envio `schema.graphql` + `src/handlers/` left untouched —
blue is a hot failback to the *pre-fix* whole-contract behavior, and wiring it
would force a heavy `envio codegen` regeneration of `generated/`. Rollback
green→blue reverts to today's behavior (score reverts to its current fallback).
**Tracked follow-up:** envio/blue parity, gated on blue retirement.

## Verification

- `npx tsc -p ponder-runtime/tsconfig.json --noEmit` — clean.
- `npx vitest run` — 182 passed / 34 skipped / 0 failed (incl. 16 new + byte-parity intact).
- FAGAN (`/fagan --diff`) — APPROVED, 0 findings, fabrication-check passed.
- 3-lens adversarial verify (correctness / ponder-runtime / deploy-consumer) — resolutions:
  - *Self-transfer* (flagged critical): the example (transfer > balance) is on-chain-impossible;
    reachable self-transfers net correctly since sender/receiver deltas are equal-magnitude on
    one row (mirrors the proven whole-contract `adjustHolder1155`). Hardened anyway with an
    explicit `from===to` skip — provably no-op, no reachable-behavior change.
  - *Batch `.map` coercion* (major): dropped — `idsArray`/`valuesArray` are already `bigint[]`;
    pass directly (no crash vector, helper guards live).
  - *Redundant `BigInt()` wrap* (minor): unwrapped — `balance` is native bigint.
  - *Index*: (contract, chainId, tokenId) — both FAGAN and the deploy lens converged on adding
    chainId to match the row key (same-address contracts can exist cross-chain). Adopted.

## Bridgebuilder (BEAUVOIR) triage — PR #64

| # | Finding | Verdict | Rationale |
|---|---------|---------|-----------|
| F-01 | composite `(address,contract,chainId)` index | defer | a wallet holds ≤34 puru-edition rows total; `addressIdx` post-filter is trivial. Revisit when the entity expands beyond the puru family. |
| F-02 | O(4N) sequential DB ops per batch → bulk upsert | defer | mirrors the proven whole-contract `adjustHolder1155` path; puru batches are tiny (≤13 ids); reindex is one-time. Revisit on scope expansion / large semi-fungible batches. |
| F-03 | `onConflictDoNothing` race drops a delta | push back | impossible under Ponder's sequential single-writer (BEAUVOIR concedes); the suggested SQL-additive `excluded.balance` upsert can't express floor-at-zero + delete-on-empty (which require the read). Consistent with the existing handler. |
| F-04 | puru-only scope → empty-vs-unsupported ambiguity | **accepted** | added a COVERAGE consumer note to the schema comment (`SELECT DISTINCT collectionKey` enumerates live coverage). |
| F-05 | `context: any` loses DB type-safety | push back + note | handler-wide pattern; typed Context not cleanly available this Ponder version. Added a tracking-debt comment. |
| F-06/07 | PRAISE (pre-DB delta reduction; pure-helper extraction) | — | confirms the design. |

## Acceptance criteria

- [x] `trackedHolder1155` maintains per-(contract,chain,tokenId,wallet) balance with delete-on-zero.
- [x] TransferSingle + TransferBatch (incl. repeated tokenId) covered; whole-contract unchanged.
- [x] Pure-helper unit tests green; typecheck clean; no test regressions.
- [ ] Deploy: green-build reindex + Hasura track-table (deploy gate, not this PR).
- [ ] score-api repoints apiculture factor to `trackedHolder1155` (consumer PR, separate).
