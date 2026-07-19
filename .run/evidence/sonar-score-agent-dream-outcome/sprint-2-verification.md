# Sprint 2 Verification Receipt

Timestamp: `2026-07-19T06:13:10Z`

## Mechanical Gates

| Gate | Result |
|---|---|
| `pnpm run verify:truth-registry` | PASS; 5 suites / 50 tests |
| `pnpm run verify:truth-contract` | PASS; 3 suites / 20 tests |
| `pnpm run test:truth-promotion` | PASS; 4 tests |
| `pnpm run verify:truth-promotion` | PASS; `production_authority:false` |
| truth traceability | PASS; 13 requirements, 2 implemented, 11 planned |
| acceptance-criteria verification | PASS; 44 plan criteria walked |
| `git diff --check` | PASS |
| coordinated audit | APPROVED; 0C / 0H / 0M / 0L |

## Storage-Writer Negatives

- Forged audit body/signature rejected.
- Audit suffix deletion plus mutable-head reset rejected.
- Alternate valid signed prefix plus valid linked suffix rejected.
- Mid-read alternate-chain mutation cannot advance the protected baseline.
- Structural audit and revocation persistence imposters rejected.
- Revocation persisted-prefix substitution and coordinated tail/head rollback
  rejected.

## Operator Invariants

- Ethereum chain `1` network floor remains `12287507`.
- `ENVIO_RESTART` is unset.
- No floor lowering, wipe, restart, or KF-013 replay.
- No production signer, registry activation, deployment, Score graduation,
  index mutation, or database mutation.
- Filesystem adapter remains `STORE_UNAVAILABLE` for deployment;
  production authority remains false.
