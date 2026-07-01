# Beacon v2 gateway consumption contract

Root `beacon.yaml` (schema_version `"2"`) is the **federation broadcast** surface for sonar-api. The building identity beacon (BeaconV3) lives in `packages/protocol/beacon.yaml` and is not consumed directly by the MCP gateway tenant registry.

## Field mapping → freeside-mcp-gateway

| beacon v2 field | Gateway tenant field | Notes |
|-----------------|----------------------|-------|
| `read_surface.graphql.endpoint` | upstream GraphQL URL | Resolved at gateway boot; `${SONAR_GRAPHQL_ENDPOINT}` in v3 |
| `read_surface.auth.kind` | auth policy | `"none"` today — public read |
| `read_surface.mcp.shape` | MCP adapter shape | `"proxy"` — passthrough GraphQL tool |
| `read_surface.mcp.tools` | tool allowlist | `["graphql"]` single passthrough |
| `identity.name` | tenant slug / display | `sonar-api` |
| `read_surface.graphql.alias` | stable alias | `sonar.0xhoneyjar.xyz` |

## Required fields (contract test)

The committed root beacon MUST include:

- `read_surface.graphql.endpoint` (HTTPS URL)
- `read_surface.auth.kind`
- `read_surface.mcp.shape`
- `read_surface.mcp.tools` (non-empty array)

## Two-beacon discipline

| File | Schema | Maintainer |
|------|--------|------------|
| `packages/protocol/beacon.yaml` | v3 | Operator (hand) |
| `beacon.yaml` (repo root) | v2 | Operator + `pnpm self` (generated sections) |

Generated sections (`sources`, `read_surface`, `deploy_model`) are territory-derived. Declared blocks (`events`, `consumers`) are preserved across `--write`.

## Drift check

```bash
pnpm self:check          # CI — offline, exit 2 on unknown probes
pnpm self:write          # Regenerate after intentional territory change
```

See `grimoires/loa/cycles/sonar-self/prd.md` for exit code semantics.
