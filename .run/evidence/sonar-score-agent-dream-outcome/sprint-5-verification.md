# Sprint 5 — Agent Consumption and Staged Truth Proof

Run: `run-20260718-19763105`
Branch: `feature/sprint-plan`
Authority: staged/read-only only; `production_authority:false`

## Pre-change production observation

Three read-only GraphQL samples were taken from
`https://sonar.0xhoneyjar.xyz/v1/graphql` at
`2026-07-19T08:47:22Z`, `08:47:32Z`, and `08:47:42Z`.
The local Python trust store required
`SSL_CERT_FILE=/etc/ssl/cert.pem`; TLS verification was not disabled.

The complete six-chain follow-up sample at `2026-07-19T09:16Z` was:

| Chain | Configured floor | Head | Processed | Fetched | Events | Lag | State / ETA |
|---|---:|---:|---:|---:|---:|---:|---|
| Ethereum `1` | `12287507` | `25565797` | `25565797` | `25565797` | `31999702` | `0` | `TIP_FOLLOW`; caught up |
| Optimism `10` | `107558369` | `154426895` | `154426895` | `154426895` | `196894` | `0` | `TIP_FOLLOW`; caught up |
| Base `8453` | `2430439` | `48831610` | `48831610` | `48831610` | `14259647` | `0` | `TIP_FOLLOW`; caught up |
| Arbitrum `42161` | `102894033` | `485446022` | `485446022` | `485446022` | `29250` | `0` | `TIP_FOLLOW`; caught up |
| Berachain `80094` | `8221` | `23718925` | `23718925` | `23718925` | `5633827` | `0` | `TIP_FOLLOW`; caught up |
| Zora `7777777` | `18071873` | `48879364` | `48879364` | `48879364` | `24422` | `0` | `TIP_FOLLOW`; caught up |

All six reported chains had zero lag in all three samples. No mutation,
restart, floor change, wipe, or database operation was performed.

## Read-only Mibera current-evidence quorum

Two independent Berachain JSON-RPC providers returned the same finalized block:

- number: `0x169e924`
- hash: `0xcdf90542afbee65e908eacec5481088e9eec1993d682c1268647f4a1ddbb33cb`
- parent: `0x56eea765d9a824b6af85961bbb39e20081e7e6375e1df9fb4f9419df64d7e706`
- timestamp: `0x6a5c9004`

For MiberaCollection
`0x6666397dfe9a8c469bf65dc744cb1c733416c420`, both providers returned
9,067 bytes of code with the same binary-bytecode digest:
`sha256:6cbf0a2f6bde17afc7d0c56f67675964b57d6e4168c6d302e7f284770f287f6f`.
The normalized hex-string digest was
`sha256:d4da3d41ee2a8796309c91cdcc721abbcf69a2d9395efe1c1b5280197d576a2d`.
The observation route was read-only and the domain compiler receives the
result as injected evidence; it has no network authority.

The GraphQL indexer head and the later finalized JSON-RPC observation are
separate, time-bounded planes: the former proves indexer progress at its sample
time; the latter proves the finalized block and bytecode seen by two independent
RPC providers. Neither is substituted for the other.

The staged proof binds those observations exactly:

- finalized height `23718180` / `0x169e924`;
- finalized block
  `cdf90542afbee65e908eacec5481088e9eec1993d682c1268647f4a1ddbb33cb`;
- binary code hash
  `6cbf0a2f6bde17afc7d0c56f67675964b57d6e4168c6d302e7f284770f287f6f`;
- normalized provider-response commitment
  `d4da3d41ee2a8796309c91cdcc721abbcf69a2d9395efe1c1b5280197d576a2d`;
- collection `0x6666397dfe9a8c469bf65dc744cb1c733416c420`;
- the closed `Transfer(address,address,uint256)` event slice only.

`compileMiberaStagedCurrentProofV1` rejects any split provider commitment,
non-independent provider, different address/event, or observation that is not
already committed by its readiness provider. The locally sealed,
filesystem-context-bound signed inspection envelope for this run is
`0c309b3999ac9fde35016d7d7c0e1dc259b344a427ab92e142c3c177e261aa42`,
published by the explicitly pinned staged key `sonar-staged-publisher`.
Filesystem/process-separation realpaths intentionally remain signed, so a
different runner generates and pins its own exact envelope hash; the semantic
slice and all observation commitments above remain portable. The proof passes
unchanged under `TMPDIR=/tmp`.

## Projection and consumption boundary

Two projections are intentionally checked for two different claims:

1. the supplied reconciliation projection proves that the reconciled artifact
   is currently `READY` under the reconciliation authority; and
2. the inspection projection is a new signed read surface with the exact chain
   `producer readiness -> reconciler-signed reconciliation -> Score
   NotConsumed`, including the prerequisite edges.

Agents trust the outer signed inspection envelope only after rebuilding the
second projection from its bounded signed events and authority grants. Both
claimed projection digests must equal that replay; caller-supplied equal strings
are insufficient.

Sprint 5 proves the strict receipt seam, the signed `NOT_CONSUMED` handoff, and
agent read surfaces. It does **not** claim actual Score consumption:

- `consumed`, `live_proven`, and `graduated` remain exit `2`;
- `NOT_CONSUMED` / `NOT_CONSUMED_OVERDUE` name owner `bd-v54z.1` and the
  seven-day deadline;
- Score-owned projection integration, live serving/user-meaning proof,
  compatibility enforcement, production signing, and rollout remain planned.

## Verification gates

Local hermetic verification ran against the exact repaired worktree with
`ENVIO_RESTART` unset:

| Gate | Result | Evidence |
|---|---|---|
| `pnpm verify:truth-agent` | PASS — `47/47` tests | invariant JSON: floor `12287507`, restart `unset`, `production_authority:false`; traceability `13` total / `9` implemented / `4` explicitly planned |
| `pnpm verify:truth-contract` | PASS — `65/65` tests | producer, readiness, reconciliation, invalidation, and reorg-serving suites |
| `pnpm verify:truth-registry` | PASS — `50/50` tests | registry, trust-root, revocation, filesystem, and trust E2E suites |
| `pnpm verify:truth-promotion` | PASS | authorized implementation receipt; `production_authority:false`; pre-Sprint-5 head `d09745ae7f41a47ef69d1afbbe1e6af072156d4c` |
| `git diff --check` | PASS | no whitespace errors |

The Truth Contract GitHub workflow now runs those four gates and is pinned to
immutable action SHAs. Its trigger surface includes the truth contract, shared
signature primitives, traceability/invariant inputs, compiler config, and this
evidence directory. No remote workflow run is claimed before push; this local
receipt and the implementation are committed atomically, and the containing
commit is the reproducible tree identity.

Flatline was attempted twice. Both runs honestly ended `DEGRADED 2/3`: Claude
and Cursor completed, while both Codex-headless calls returned empty. Phase 2
was skipped and no convergence is claimed. Their actionable CI, credential,
resource-limit, traceability, and evidence findings were repaired; the repeated
adapter failure is recorded as `KF-021`. Independent final acceptance,
cryptographic/property, and code reviewers each returned `APPROVED` with no
remaining actionable finding; their verdicts are sealed under
`grimoires/loa/a2a/sprint-5/`.

## Frozen invariants

- Ethereum chain `1` `start_block` remains `12287507`.
- `ENVIO_RESTART` was unset for every gate.
- No floor lowering, wipe, KF-013 replay, production signer, deployment,
  Score graduation, index mutation, or database mutation occurred.
- Staged evidence is labeled `STAGED_CURRENT` / `STAGED_VALID` /
  `RECONCILED_STAGED`; it cannot alias production authority.
- Actual Score consumption remains owned by `bd-v54z.1`.
