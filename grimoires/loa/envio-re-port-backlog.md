# Envio re-port backlog (post-#110 ponder-runtime removal)

Capabilities merged in `ponder-runtime/` then **explicitly dropped** when kitchen rehome deleted Ponder (#110). Re-open as Envio ports only if downstream consumers confirm need.

| Capability | Issue | Consumer | Notes |
|------------|-------|----------|-------|
| Per-tokenId ERC-1155 holder balance | [#62](https://github.com/0xHoneyJar/sonar-api/issues/62) | apiculture | Was Ponder #64 |
| Address-type classification (EOA/contract/delegated) | [#63](https://github.com/0xHoneyJar/sonar-api/issues/63) | Score | Was Ponder #65 |
| Per-token ERC-721 ownership projection | _(file if inventory-api blocked)_ | inventory-api / Stash | Was Ponder #69 |
| NATS outbox + DLQ + reorg-safe publish | [#48](https://github.com/0xHoneyJar/sonar-api/issues/48), [#20](https://github.com/0xHoneyJar/sonar-api/issues/20) | cluster-events | Best-effort `events-publisher.ts` on Envio today |

**Ground truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md), [`SOUL.md`](../../SOUL.md)

**Label:** `envio-re-port`
