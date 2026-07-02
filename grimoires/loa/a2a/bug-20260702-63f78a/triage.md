# Bug Triage: chain-1 Azuki TrackedErc721 never indexes holders after full belt reinit

## Metadata
- **schema_version**: 1
- **bug_id**: 20260702-63f78a
- **classification**: integration_issue
- **severity**: high
- **eligibility_score**: 4
- **eligibility_reasoning**: Reproducible via production GraphQL (+2), live production evidence (+1), regression after PR #114 Azuki config add (+1). Not a feature request — kitchen E2E #111 expects holders after onboarding.
- **test_type**: integration
- **risk_level**: medium
- **created**: 2026-07-02T03:40:53Z
- **related_issues**: #111 (Azuki kitchen E2E), blocks advance-ingredient

## Reproduction
### Steps
1. Confirm `belt-indexer-selfhost` runs with `BELT_CONFIG=config.yaml` (Railway var).
2. Confirm Azuki is in `config.yaml` chain 1 under `TrackedErc721` (`0xed5af388653567af2f388e6224dcc93746104133`, added PR #114 / fdcc7ab).
3. Run KF-013 seed dance (`ENVIO_RESTART=1` → deploy → delete var → redeploy). Redeploy `belt-hasura-selfhost` if KF-016 blocks indexing.
4. Wait until chain 1 `latest_processed_block` reaches head (~25.4M).
5. Query production GraphQL:

```graphql
query {
  cm: chain_metadata(where: { chain_id: { _eq: 1 } }) {
    latest_processed_block
  }
  azuki: TrackedHolder_aggregate(
    where: {
      chainId: { _eq: 1 }
      contract: { _eq: "0xed5af388653567af2f388e6224dcc93746104133" }
    }
  ) {
    aggregate { count }
  }
  th1: TrackedHolder_aggregate(where: { chainId: { _eq: 1 } }) {
    aggregate { count }
  }
  hold721: Action_aggregate(
    where: { chainId: { _eq: 1 }, actionType: { _eq: "hold721" } }
  ) {
    aggregate { count }
  }
}
```

### Expected Behavior
After full reindex past Azuki deploy block (~14.16M), `TrackedHolder_aggregate` for Azuki is > 0. Kitchen status can reach `indexed` and #111 advance-ingredient can run.

### Actual Behavior
As of 2026-07-02 (chain 1 at **25,442,180**):
- Azuki `TrackedHolder`: **0**
- All chain-1 `TrackedHolder`: **0** (Azuki is the only chain-1 `TrackedErc721` binding)
- chain-1 `hold721` actions: **0**
- Other chain-1 entities populate normally (`Token` ~30k, `NftBurn` Milady ~24)
- Optimism `TrackedErc721` on same belt: **~2,040** holders (handler + contract class work elsewhere)

### Environment
- Production: `belt-indexer-selfhost`, `BELT_CONFIG=config.yaml`, `sonar.0xhoneyjar.xyz/v1/graphql`
- Envio **3.2.1**, kitchen-api on shared belt Postgres

## Analysis
### Ruled out
| Hypothesis | Evidence against |
|------------|------------------|
| Missing `ENVIO_RESTART` / KF-013 | Seed dance completed; 6 chains seeded; chain 1 backfilled to head |
| `BELT_CONFIG=config.mibera.yaml` (Azuki not in mibera config) | Railway var is **`config.yaml`** on selfhost |
| `envio` missing from package.json (deploy fail) | Fixed in PR #117; belt deploys and indexes other contracts |
| Handler filters Azuki | `tracked-erc721.ts` uses address fallback for unknown keys; no early return |
| KF-016 Hasura block | HoneyJar/Milady/OP TrackedErc721 populate |

### Suspected Files
| File | Line(s) | Confidence | Reason |
|------|---------|------------|--------|
| `config.yaml` | 593–596 | high | Azuki binding lacks per-contract `start_block`; only chain-1 `TrackedErc721` address |
| `scripts/verify-belt-config.js` | 35–56 | high | `BELT_CONTRACTS` omits `{ TrackedErc721, chainId: 1 }` — CI allows silent drift |
| `test/verify-belt-config.test.ts` | 31–36 | high | Asserts TrackedErc721 only on chains 10 and 80094 |
| `src/kitchen/hasura-status-reader.ts` | — | medium | Status pipeline depends on GraphQL holder count; cannot pass while bug open |
| `Dockerfile.belt` | 40–53 | medium | KF-013 docs; may need additional validation after config-only contract adds |

### Related Tests
| Test File | Coverage |
|-----------|----------|
| `src/kitchen/config-patcher.test.ts` | Patches Azuki into fixture YAML only |
| `test/verify-belt-config.test.ts` | Does **not** cover chain-1 TrackedErc721 |
| `src/kitchen/hasura-status-reader.test.ts` | Status logic; no live belt integration |

### Test Target
Add an integration/contract test that:
1. Parses `config.yaml` and asserts chain-1 `TrackedErc721` includes Azuki.
2. (Stretch) Fails if `BELT_CONTRACTS` / monolith gate omits kitchen onboarding collections.
3. Documents expected GraphQL holder probe for operator verification post-deploy.

### Constraints
- Fix must not require another blind full belt wipe without proving subscription fix first.
- Kitchen ingest job row was lost on belt Postgres wipe; re-onboard after indexer fix.
- #111 remains blocked until holders > 0.

## Fix Strategy
1. **Prove subscription gap** — add test or script that validates chain-1 Azuki appears in Envio runtime contract set (config parse + optional `envio config view` / codegen artifact check on envio 3.2.1).
2. **Config hygiene** — add Azuki `start_block` (~14162194 deployment), optional `TRACKED_ERC721_COLLECTION_KEYS` entry `azuki_kitchen_e2e`.
3. **CI gate** — extend `BELT_CONTRACTS` or add `verify-monolith-indexer-contracts` for kitchen/community onboarding addresses on chain 1.
4. **Redeploy + KF-013** only after (1)–(3) land; verify Azuki holders via GraphQL before closing #111.
5. If config is correct but Envio still skips events, escalate to Envio 3.2.1 bug (single-address `TrackedErc721` on chain 1) with minimal repro config.

### Fix Hints
| File | Action | Target | Constraint |
|------|--------|--------|------------|
| `config.yaml` | add | `start_block` on chain-1 Azuki `TrackedErc721` network binding | Use Azuki deploy block ~14162194 |
| `scripts/verify-belt-config.js` | add | `{ name: 'TrackedErc721', chainId: 1 }` to `BELT_CONTRACTS` | Or separate kitchen gate if mibera belt must not include Azuki |
| `test/verify-belt-config.test.ts` | update | Expect chain-1 TrackedErc721 in footprint when present in monolith | Keep mibera parity rules |
| `src/handlers/tracked-erc721/constants.ts` | add | `azuki_kitchen_e2e` collection key | Optional; not root cause |
| `test/` (new) | add | GraphQL holder probe fixture / config subscription test | Vitest; no live Railway in CI |
