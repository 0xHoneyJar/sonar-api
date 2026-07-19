# PRD — Robinhood live recognize + belt + StonkBrokers

**Status:** Implementing  
**Owner:** sonar-api / Kitchen  
**Date:** 2026-07-19

## Problem

Gate Leak resolve-probe and Kitchen preparation treated Robinhood Chain
(`eip155:4663`) as disabled. Belt `config.yaml` had no chain 4663. StonkBrokers
(`0x539cdd042c2f3d93ebc5be7dfff0c79f3b4fabf0`) could not be recognized or admitted.

## Goal

1. Include Robinhood in Kitchen live resolve-probe fanout.
2. Index Robinhood on the belt with TrackedErc721 for StonkBrokers.
3. Enable Kitchen preparation capability for 4663 so Ordering can admit the collection.
4. Deploy Kitchen (`RESOLVER_MODE=live`) and belt with Robinhood RPC.

## Acceptance

- Bare EVM probe diagnostics include `eip155:4663`.
- CAIP-10 `eip155:4663:0x539cdd…` pins Robinhood only.
- `config.yaml` has `- id: 4663` with StonkBrokers @ start_block `12493793`.
- `resolvePreparationCapability` for 4663 + erc721 is available (not kill_switch).
- Kitchen admit returns queued/indexed for StonkBrokers after belt accepts drain.

## Out of scope

- Testnet 46630
- Dashboard UI changes
- Score consumer graduation receipts
