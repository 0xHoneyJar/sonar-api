# PRD — Robinhood live recognize + ownership sidecar

**Status:** Partial — Kitchen recognize SHIPPED; ownership via sidecar DECIDED  
**Owner:** sonar-api / Kitchen  
**Date:** 2026-07-19  
**ADR:** `adr.robinhood-hyperindex-sidecar.md`

## Problem

Gate Leak resolve-probe and Kitchen preparation treated Robinhood Chain
(`eip155:4663`) as disabled. StonkBrokers
(`0x539cdd042c2f3d93ebc5be7dfff0c79f3b4fabf0`) could not be recognized.
Monobelt admission of chain 4663 crash-looped production (#231→#232/#234):
Envio refuses resume when topology changes without wipe or a second indexer.

## Goal

1. Include Robinhood in Kitchen live resolve-probe fanout. **DONE**
2. Do **not** index Robinhood on the Henlo monobelt. **DECIDED**
3. Index StonkBrokers on a **dedicated HyperIndex sidecar** (HyperSync-only,
   dedicated Postgres). **SCAFFOLD + CANARY**
4. Kitchen `ownership_index.v1` via adapter
   `belt.evm-erc721.robinhood-sidecar` / `rh-hyperindex-sidecar.v1`, with a
   routed `CollectionStatusReader` for chain 4663. **PENDING canary**

## Acceptance (current cut)

- Bare EVM probe diagnostics include `eip155:4663`.
- CAIP-10 `eip155:4663:0x539cdd…` pins Robinhood.
- Preparation capability for 4663 is **disabled** until sidecar readiness
  exists (contract truth — do not advertise healthy under `belt.evm-erc721`).
- `config.yaml` monobelt remains without chain 4663.
- `config.robinhood-sidecar.yaml` + canary checklist exist in-repo.

## Deferred (sidecar canary → enable)

- Pass `robinhood-sidecar-canary.md` proof sequence.
- Re-enable preparation with sidecar adapter + routed status/progress readers.
- `POST /v2/collection-preparations/ack` / coverage-bound ready for StonkBrokers.
- Production Railway service + dedicated DB (+ optional Hasura source).

## Out of scope

- Testnet 46630
- Dashboard UI changes
- Score consumer graduation receipts
- Adding 4663 to monobelt (tactical only after #236 + canary; not strategic)
