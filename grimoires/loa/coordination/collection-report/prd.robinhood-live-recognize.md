# PRD — Robinhood live recognize + belt + StonkBrokers

**Status:** Partial — Kitchen live recognize SHIPPED; belt chain deferred (SCALE)  
**Owner:** sonar-api / Kitchen  
**Date:** 2026-07-19

## Problem

Gate Leak resolve-probe and Kitchen preparation treated Robinhood Chain
(`eip155:4663`) as disabled. StonkBrokers
(`0x539cdd042c2f3d93ebc5be7dfff0c79f3b4fabf0`) could not be recognized.

## Goal

1. Include Robinhood in Kitchen live resolve-probe fanout. **DONE** (merged #231 + Kitchen deploy).
2. Enable Kitchen preparation capability for 4663. **DONE** (admit queues; drain=`external_scale`).
3. Index Robinhood on the monobelt with TrackedErc721 for StonkBrokers. **BLOCKED** — Envio 3.2.1 refuses resume when adding `evm.chains.4663` without `envio start -r` (full wipe) or a second indexer (`ENVIO_PG_SCHEMA`). Production belt was crash-looped by #231 auto-deploy; restored via CLI rollback to pre-#231 image; this hotfix removes 4663 from `config.yaml` so auto-deploy stays healthy.

## Acceptance (current cut)

- Bare EVM probe diagnostics include `eip155:4663`.
- CAIP-10 `eip155:4663:0x539cdd…` pins Robinhood.
- `resolvePreparationCapability` for 4663 + erc721 is available (not kill_switch).
- StonkBrokers admit returns `queued` under `external_scale` drain (ack after SCALE apply).

## Deferred (operator / SCALE window)

- Add `- id: 4663` + StonkBrokers @ `12493793` to live `config.yaml`.
- Choose: authorized wipe+resume (KF-013 pattern) **or** green/second-schema indexer.
- `POST /v2/collection-preparations/ack` after belt accepts the chain.
- Holders/status ready for StonkBrokers.

## Out of scope

- Testnet 46630
- Dashboard UI changes
- Score consumer graduation receipts
