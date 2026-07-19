# Structure

> Ride 2026-07-19 · annotated (depth-limited)

```
sonar-api/
  config.yaml              # Green 6-chain Envio config
  config.mibera.yaml       # Scoped mibera belt
  schema.graphql           # 95 entities
  package.json             # envio-indexer, node≥22, pnpm
  Dockerfile.belt|gateway|kitchen|erpc|svm-webhook
  src/
    EventHandlers.ts       # Green registration hub
    handlers/              # Domain Envio handlers
    belts/mibera/          # Scoped entry
    canonical/             # NftActivity map/emit/parity
    svm/                   # Solana SQD/warehouse/Helius
    kitchen/               # HTTP ordering service
    self/ · sense/         # Operator CLIs
    evm/ · labels/ · lib/
  scripts/                 # promote, gates, verify, pulse
  test/                    # Vitest + bats
  abis/                    # Contract ABIs
  docs/                    # Ops + architecture ADRs
  grimoires/loa/           # Loa state (this ride)
```

## Module responsibilities

| Path | Responsibility |
|------|----------------|
| handlers/* | Decode chain events → entity sets |
| canonical/* | Normalize to shared NftActivity; parity gates |
| svm/* | Solana collection_event pipeline |
| kitchen/* | On-demand collection ingest/orders |
| self/* | ACVP self-description CLI |
| scripts/promote.sh | Consumer-facing upstream swap |
