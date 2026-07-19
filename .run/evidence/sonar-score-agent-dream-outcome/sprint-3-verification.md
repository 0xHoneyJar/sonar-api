# Sprint 3 Verification Receipt

Timestamp: `2026-07-19T06:54:59Z`

## Outcome

The closed initial producer slice is exactly Berachain `MiberaCollection`
`0x6666397dfe9a8c469bf65dc744cb1c733416c420` plus
`Transfer(address,address,uint256)`. Its committed denominator, source config,
handler, and adapter bytes are pinned and checked before a hermetic generation
can reach `PRODUCED`.

The generation is labeled `FIXTURE_VALID` and
`production_authority:false`. A `STAGED_CURRENT` claim requires a separately
signed, trusted, bounded-age read-only observation receipt over the complete
observation set. Score consumption, live authority, and graduation are not
claimed.

## Mechanical Gates

| Gate | Result |
|---|---|
| `pnpm run verify:truth-producer` | PASS; 4 suites / 22 tests |
| `pnpm run verify:truth-contract` | PASS; 6 suites / 38 tests |
| `pnpm run verify:truth-registry` | PASS; 5 suites / 50 tests |
| capability registry hermetic suite | PASS; 35 tests |
| `pnpm run test:truth-promotion` | PASS; 4 tests |
| `pnpm run verify:truth-promotion` | PASS; `production_authority:false` |
| truth traceability | PASS; 13 requirements, 5 implemented, 8 planned |
| `git diff --check` | PASS |
| acceptance audit | APPROVED; 0C / 0H / 0M / 0L |
| crypto/property audit | APPROVED; 0C / 0H / 0M / 0L |
| adversarial review | APPROVED; 0C / 0H; residual proxy/request findings fixed |

## Fail-Closed Proofs

- Resolver transport failure, malformed observations, incomplete proxies,
  metamorphic upgrades, correlated providers, block-depth fallback, and
  finalized disagreement cannot produce an admitted identity.
- Provider IDs and independence metadata must equal the signed policy; two
  independently operated providers must agree on the same finalized height and
  hash.
- Identity, event denominator, network policy, activity profile, and source
  claims are recomputed from the exact signed normative closure and verified
  bundle root.
- Quiet data needs finalized head quorum, advancing cursor, heartbeat,
  cross-source availability, complete coverage, and a signed effective
  activity profile.
- Coverage horizon must equal the finalized watermark. Zero rows alone cannot
  pass.
- Worst-source precedence covers `READY`, `DEGRADED`, `EXPIRED`, `UNKNOWN`,
  `NOT_READY`, and `SUSPENDED`.
- Readiness expiry is capped by every underlying evidence, provider, cadence,
  identity, activity, reconciliation, and live-receipt boundary.
- Fixture-to-staged relabeling, signer substitution, root/closure mismatch,
  replay, provider duplication, stale evidence, and observation-set splicing
  are rejected.

## Operator Invariants

- Ethereum chain `1` floor remains `12287507`.
- `ENVIO_RESTART` is unset.
- No floor lowering, wipe, restart, or KF-013 replay.
- No production signer, registry activation, deployment, Score graduation,
  index mutation, or database mutation.
- The only resolver policy change replaces Berachain block-depth fallback with
  its required `finalized` tag.
