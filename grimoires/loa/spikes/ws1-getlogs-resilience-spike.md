---
hivemind:
  schema_version: "1.0"
  artifact_type: technical-rfc
  product_area: "sonar-api — Ponder belt indexer (getLogs resilience)"
  workstream: delivery
  priority: high
  learning_status: strongly-validated
  source: team-internal
---

# WS1 spike — getLogs malformed-response resilience (#72)

> Bead: `bd-s11-erpc-1155-87l.1`. Spec: `grimoires/loa/specs/enhance-session-11-erpc-resilience-and-op1155-holders.md`.
> Decided 2026-06-15: **Layer 1 (Ponder custom viem transport) + eth-upstream harden.**

## Runtime verdict (OBSERVED — corrects the spec framing)

`belt-indexer-green-v3` runs **Ponder 0.16.6**, not Envio. Evidence chain:

- `Dockerfile.belt-ponder:113` → `exec pnpm ponder start --root "$PONDER_ROOT" --config "$BELT_CONFIG"`;
  `PONDER_ROOT=ponder-runtime` (L70-71), green `BELT_CONFIG=ponder.config.ts` (L21/52).
- `Dockerfile.belt-ponder:3` — "Replaces the envio Dockerfile.belt for the migration to Ponder."
- `package.json:35` pins `ponder: 0.16.6`; the crash error string lives only in `node_modules/ponder`.
- No `railway.json`/`railway.toml` — deploy authority is the Dockerfiles + Railway service vars.

**The spec's "HoneyJar / config.yaml:571-572 (Envio)" attribution is a misread.** `config.yaml` is the
retired Envio belt. The Ponder config's ONLY Ethereum contract is **MiladyCollection**
(`0x5af0d9827e0c53e4799bb226655a1de152a425a5`, startBlock 25,184,952). The crash block
`0x181fe0d` = **25,296,397** > that startBlock → the malformed getLogs was a **MiladyCollection**
request. HoneyJar (startBlock 17,085,858) is Envio-only and not in any Ponder config.

→ **Acceptance target correction:** WS1 is "fixed" when green-v3 indexes the **MiladyCollection**
Ethereum range that currently crash-loops it (around block 25,296,397) with zero `RpcProviderError`
shutdowns — NOT the HoneyJar range named in the spec.

## Crash origin

`node_modules/ponder/dist/esm/rpc/actions.js:687` — `standardizeLogs` throws
`RpcProviderError("Invalid RPC response: 'log.blockNumber' is a required property")` when
`log.blockNumber === undefined`. It fires **after** a 200 success, so Ponder's request-layer retry
(`rpc/index.js:377-491`, bucket rotation/backoff) never sees it. `sync-historical/index.js:82-115`
catches only block-*range* errors (`getLogsRetryHelper`); a non-range `RpcProviderError` is rethrown
at `:99-100` → **fatal, kills the sync** → the crash-loop.

## The three layers

| Layer | Effort | Robustness | Verdict |
|---|---|---|---|
| **L1 — Ponder custom viem transport** (intercept getLogs, re-fetch on missing `blockNumber`) | S–M | MED–HIGH | **CHOSEN.** Fix lives where the crash is; contained edit to `rpc:`; one-step revertable. |
| L2 — fork eRPC (add getLogs validator mirroring the `eth_getBlockReceipts` integrity hook) | L | HIGH | Deferred. Truest/durable, benefits all consumers, but own-the-fork maintenance. |
| L3 — validation sidecar in front of eRPC | M | MED–HIGH | Rejected. Permanent hot-path service, no robustness gain over L1. |

## Decision: L1 + harden

1. **L1 transport.** The seam is `chains.<name>.rpc` accepting a custom viem Transport
   (`node_modules/ponder/dist/esm/rpc/index.js:159-169`). Today the config passes a URL **string**
   (`ponder.config.mibera.ts:48`). Replace the Ethereum `rpc` with a custom transport wrapping
   `http(PONDER_RPC_URL_1)` that, for `eth_getLogs`, inspects each returned entry and on a missing
   `blockNumber` re-requests internally a bounded number of times (eRPC rotates upstreams between
   attempts; the lie is intermittent — clean from publicnode/tenderly, timeout from drpc), returning
   only a clean response. viem 2.21 is NOT on this path (Ponder builds a raw `custom()` transport and
   does its own validation), so the missing-field reaches actions.js:687 unformatted.
2. **Harden** by widening/reordering the eth getLogs upstream cluster (`erpc.yaml:317-325`:
   publicnode, tenderly, drpc) so a re-fetch reliably lands on a clean node. Also correct the stale
   comment `erpc.yaml:314-316` ("Ethereum … getLogs-liar class does NOT apply") — #72 falsifies it.

**Weak link to verify in review/acceptance:** L1 depends on a re-fetch landing on a clean upstream.
The internal retry bound + the eth-upstream widening are what make that reliable; acceptance is the
real MiladyCollection range indexing clean, not "the review looked fine."

## KF-012 relationship

KF-012 (`known-failures.md`, RESOLVED 2026-05-20) is a **different** failure mode: empty-but-valid
getLogs (Envio/Berachain, free upstream returned `[]`+200), fixed via `ignoreMethods: [eth_getLogs]`.
That remedy will NOT fix #72 — #72 is a structurally-malformed entry, intermittent across all three
eth upstreams, so `ignoreMethods` on one upstream is insufficient.
