---
title: Address-type classification (eoa / contract / delegated_eoa)
issue: 0xHoneyJar/sonar-api#63
bead: bd-3lo
status: implemented (green/Ponder); deploy-pending (rides the #62 green-belt reindex)
plane: contract + execution
domain: shared
date: 2026-06-04
companion: sonar-api#62 (per-tokenId balance)
---

# sonar-api#63 — Address-type classification

## Problem

score-api's sybil / wash-trading filter needs to know whether an address is a
human EOA or a contract, read from the indexer as a fact. Contract addresses
(routers, conduits, distributors) move tokens without holding them and pollute
holdings leaderboards. Live example: `0x777777794a6e310f2a55da6f157b16ed28fa5d91`
is a router **contract** that holds **0** apiculture yet sat at **rank #3** (it
received 8,404 via 561 transfers). This is the on-chain twin of #62: same boundary
(sonar = on-chain facts), distinct property (a property of every address, not a
holding). It is NOT identity-api's job — that layer is off-chain human identity;
this is an on-chain property of every address, including routers that never link.

## Decision (consistent with #62)

A **general, community-agnostic** `addressType` entity, **populated by the puru
handler only** (the proven consumer need — the router appears in apiculture
transfers). General primitive, scoped fill; other handlers adopt `touchAddress`
later. Green/Ponder only; envio/blue parity is a tracked follow-up.

## Mechanism — `eth_getCode`, classified

| getCode result | type | note |
|---|---|---|
| `undefined` / `0x` / empty | `eoa` | no code |
| exact `0xef0100` + 20-byte delegate (regex `^0xef0100[0-9a-f]{40}$`) | `delegated_eoa` | EIP-7702 — **still human, do NOT filter** |
| any other non-empty bytecode | `contract` | filter target |

The EIP-7702 nuance is load-bearing: the issue found 7 of 9 has-code wallets in
their top-30 were delegated EOAs — a naive `code != 0x` ban wrongly removes real
holders. (EIP-3541 forbids deployed contract code starting with `0xef`, so only a
well-formed 7702 designator carries that prefix; malformed `0xef…` falls to
`contract` conservatively.)

## Implementation (green / Ponder)

| File | Change |
|---|---|
| `ponder.schema.ts` | `addressType` entity: id `{chainId}_{address}`, chainId/address/type/resolvedAtBlock/lastResolved/recheckAfter; index (address) + (chainId, type, recheckAfter). |
| `ponder-runtime/src/lib/address-type.ts` | pure helpers `addressTypeId`, `classifyCode`, `needsRecheck` — **unit-tested** (16 cases, the EIP-7702 boundary in depth). |
| `ponder-runtime/src/lib/touch-address.ts` | cheap hot-path enqueue (`pending`, no RPC, onConflictDoNothing). |
| `ponder-runtime/src/handlers/address-resolve.ts` | `AddressResolveBase:block` resolver (mirrors outbox-flush): caught-up gate, batched `getCode` pinned to currentBlock, classify, write. |
| `ponder.config.mibera.ts` | `AddressResolveBase` block filter (Base, interval 10). |
| `ponder-runtime/src/handlers/puru-apiculture1155.ts` | `touchAddress(from, to)` in TransferSingle + TransferBatch. |

## Resolution state machine

`pending` → resolver `getCode` → eoa | contract | delegated_eoa.
- **eoa** (the only flippable type — a counterfactual ERC-4337 wallet can flip
  empty→contract at any later block): stays on a **recurring** re-check cadence
  (`recheckAfter = block + WINDOW`, re-scheduled on every resolution). So a late
  deploy is caught within one window, with no dependence on the address being
  re-seen. (An earlier "one window + re-arm-on-sighting" design was simplified to
  this recurring cadence after the adversarial pass flagged the re-arm as subtle.)
- **contract / delegated_eoa**: terminal (delegated stays human even if re-delegated).
- **Backfill safety**: the resolver self-gates on caught-up (head − currentBlock ≤ 100) so it
  does not storm `getCode` over historical block-ticks and classifies against current state.
- **Determinism**: persisted values are deterministic (`lastResolved = event.block.timestamp`,
  getCode pinned to currentBlock); the latest-head read is control-flow only.

## Consumer contract (score-api)

Query `addressType` by `(chainId, address)` → `type`. Filter/flag `contract`; keep
`eoa` and `delegated_eoa` (both human). Treat `pending` as "not yet resolved"
(unknown), not as a class. No score-side RPC dependency — consistent with #62.

## Deploy dependencies (rides the #62 green-belt reindex)

`addressType` is empty for HISTORICAL addresses until a reindex replays past
transfers (touchAddress → pending → resolver drains at head). So this rides the
**same operator-led green-belt reindex** as #62 (ADR-010, Sprint B-1, blocked on
`bd-umw.4`). Hasura auto-tracks `address_type` at cutover
(`scripts/cutover-hasura-tracking.sh`, info_schema allowlist). The resolver drains
the pending backlog once the belt is at head (50/tick × interval-10).

## Scope boundary

Green/Ponder only; `touchAddress` wired into the puru handler only (general
primitive, scoped fill). envio/blue parity + extending `touchAddress` to other
1155/20/721 handlers = tracked follow-ups.

## Verification

- `npx tsc -p ponder-runtime/tsconfig.json --noEmit` — clean.
- `npx vitest run` — 200 passed / 34 skipped / 0 failed (16 new + byte-parity intact).
- FAGAN (`/fagan`) — APPROVED (0 findings) at iter-5 after 5 real fixes: Date.now→block-ts
  determinism, exact EIP-7702 regex, env validation, deterministic order, late-counterfactual
  handling. The post-adversarial simplification (recurring cadence) is a strict reduction of
  that approved diff; a re-FAGAN was blocked by a transient codex-substrate outage.
- 3-lens adversarial verify (state-machine / ponder-reorg / deploy-consumer) — outcomes:
  - *context.client unavailable in block handlers* (claimed critical) — **refuted**: Ponder's
    `virtual.d.ts` Context type includes `client: ReadonlyClient` and is parameterized over
    `config["blocks"]`, so block handlers DO get `context.client`. No change.
  - *re-armed eoa stuck* (claimed critical) — addressed by removing the re-arm: eoas are now on
    a recurring re-check cadence (obviously correct, catches late + inactive-then-deployed).
  - *pending leaks / reindex coverage* (deploy lens) — closed via schema-comment consumer +
    coverage notes (treat `pending` as unknown; rides the #62 green-belt reindex).
