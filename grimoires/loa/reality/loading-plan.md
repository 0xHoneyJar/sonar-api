# Loading Plan

> Phase 0.5 · `/ride` 2026-07-19

## Probe

| Scope | Files | Lines (approx) | Strategy |
|-------|------:|---------------:|----------|
| `src/` | 143 TS | ~14k | **Prioritized** (medium) |
| `test/` | 541 test files | large | Excerpt / sample gates only |
| `schema.graphql` + `config.yaml` | 2 | ~2.2k | **Full load** |
| `scripts/` | many | mixed | Prioritize promote/gate/verify |

Context-manager probe on `src/`: ~146k estimated tokens → excerpts + targeted reads.

## Always load

- `package.json`, `config.yaml`, `schema.graphql`
- `src/EventHandlers.ts`, `src/canonical/*`, `src/svm/sqd-*.ts`, `src/kitchen/*`
- `scripts/promote.sh`, Dockerfiles
- Active context ADRs under `grimoires/loa/context/`

## Excerpt / skip

- Generated Envio output
- Large fixture JSON
- Historical cycle seed markdown under `cycles/`
- Full vitest corpus (counts + notable gates only)
