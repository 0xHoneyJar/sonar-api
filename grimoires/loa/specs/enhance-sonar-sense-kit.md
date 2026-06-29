# Session — Sonar Sense Kit (agentic chain-sensing tools)

> Sonar is the cluster's sense organ. This builds its declared **sense-edge**: an agent-callable
> chain-read kit where every read is a grounded `Observation`, and Score gets the first-hand verify
> path it never had.

## Context

`freeside-sonar` is today a **pure Ponder indexer** (`src/EventHandlers.ts`, `handlers/`, `belts/`) — it
publishes a derived index but has **no chain-read / IChainProvider / sense infra**. The cluster's chain-read
runtime already exists in `loa-freeside/packages/adapters/chain` (`IChainProvider`, `native-reader`, `hybrid`,
`two-tier`). So the honeycomb resolution: **build the IDENTITY (port + envelope) fresh in Sonar; consume the
RUNTIME (chain-read) from loa-freeside via the `live/` adapter.** *port-in-engine, runtime-in-module.*

Every sensor read returns an `Observation<T>` carrying a Hounfour **EpistemicTristate**
(`grounded | refuted | unverifiable`) + a mandatory `trace_id`. Refutation downgrades a read, never collapses
the port — **that** is Score's missing parity-check, made structural. Full design rationale + the Paradigm
transport DIG + the honeycomb/Hounfour reductions: `loa-freeside/grimoires/loa/context/2026-06-03-sonar-sense-kit-brief.md`.

## Run via — `code-implement-and-review` (REQUIRED)

@~/bonfire/construct-compositions/compositions/delivery/code-implement-and-review.yaml
→ the loop: **implement one verb/Layer → review (craft + protocol lens) → operator directs at the seam → next**.
RLHF-shaped: the operator's feedback at each review seam is the reward signal. Test-first per verb (the `mock/`
adapter makes every verb testable before `live/` exists). Do NOT batch all verbs — one verb per loop.

## Load Order

1. `~/bonfire/construct-compositions/compositions/delivery/code-implement-and-review.yaml` — the driving loop
2. this build doc
3. `loa-freeside/grimoires/loa/context/2026-06-03-sonar-sense-kit-brief.md` — the full brief (research + reductions)
4. **freeside-sonar real code**: `erpc.yaml` · `ponder.schema.ts` · `packages/protocol/beacon.yaml` (the identity) · `src/lib/events-publisher.ts` (the ACVP motor to mirror) · `scripts/parity-check.sh` (the verify pattern)
5. **loa-freeside chain runtime**: `packages/core/ports/chain-provider.ts` (`IChainProvider`) · `packages/adapters/chain/native-reader.ts` (the viem+breaker pattern) · `packages/events/src/index.ts` (the EventEnvelope shape to mirror)
6. **loa-hounfour**: `constraints/EpistemicTristate.constraints.json` + `docs/patterns/epistemic-tristate.md` (import the tristate; it's NOT yet in any cluster repo)
7. **construct-honeycomb-substrate** (gh): `patterns/domain-ports-live.md` · `patterns/suffix-as-type.md` · `schemas/grounding-envelope.schema.json`

## Persona

ARCH — the-arcade (OSTROM) + protocol + noether · craft lens = **DX-craft** (the CLI + envelope ergonomics, not pixels).

## Invariants (Ostrom Q1 — must not change)

- **The port is the identity.** `domain/` has ZERO deps; all chain/network/config lives in `live/`.
- **Every read is an `Observation<T>` with a TRUE tristate** (3 distinguishable consumer behaviors — never collapse to boolean, per Hounfour `EpistemicTristate`). Canonical third state is `unverifiable` (NOT "unverified").
- **`trace_id` is mandatory** on every Observation (the line back to the originating chain event).
- **Refutation downgrades, never collapses the port.** Agreement = silence.
- **Read-only sense.** The kit NEVER writes Bronze/Silver/Gold (the 6h cron owns that).
- **Belt direction:** Sonar (closer-to-raw) publishes; Score (closer-to-meaning) binds the port. The kit is Sonar-owned.
- **`tier ⊥ grounding`;** `tier` stays domain-local (NOT promoted to a Hounfour primitive this cycle).

## Blast Radius (Ostrom Q2)

| Artifact | Change | Risk |
|---|---|---|
| `freeside-sonar/packages/sense/` (NEW) | the four-folder port (`domain/ ports/ live/ mock/`) | low (net-new) |
| `freeside-sonar/packages/sense/cli` (NEW) | `sonar-sense` incur binary + MCP surface | low (net-new) |
| `freeside-sonar/packages/protocol/beacon.yaml` | add `consumes: chain-rpc(eRPC)` + declare the sense capability | low |
| `loa-hounfour` | import/declare `EpistemicTristate` (or vendor the constraint) | low (dep) |
| `@freeside/adapters/chain` (loa-freeside) | consume `IChainProvider` via SHA-pinned git-tarball dep | med (cross-repo dep) |
| `erpc.yaml` routing | `live/` points viem `http(eRPC_URL)`, not public RPCs | low (config) |

**Reversibility (Q3):** every piece is additive + behind the port. If the live adapter is wrong, swap it (the
contract is `SonarSense`, not the runtime). If the eRPC seam misbehaves, fall back to a direct RPC URL — one config line.

## What to Build (in order — dependency-ordered)

### 1. `domain/observation.domain.ts` — the envelope (pure, zero deps)
`Observation<T> = { value, grounding: 'grounded'|'refuted'|'unverifiable', tier, source, chain_id, block_number?, confidence, trace_id, schema_version }`. **DECLARE the `grounding` union LOCALLY (zero deps) — there is NOTHING to import** (HARDEN HIGH): loa-hounfour's EpistemicTristate is a *pattern* (constraint with `expression:'true'` + doc, FL-PRD-006: "value is in naming, not abstracting"), never an exported TS symbol; `grounded|refuted|unverifiable` exists in no hounfour src/dist. Reuse the canonical third state `unverifiable`; assert the 3-distinguishable-states invariant by **code review** (no runtime validator). Mirror `loa-freeside/packages/events/src/index.ts` EventEnvelope shape, scoped to a read.

### 2. `ports/sonar-sense.port.ts` — the declared edge (the identity)
The `SonarSense` interface: verb methods each returning `Promise<Observation<T>>`. V1 verbs: `doctor()`, `categories()`, `category(key, opts)`, `read(chain, addr, fnSig, args)`, `balance(...)`, `owns(...)`, `native(...)`. Conform to `loa-freeside/packages/core/ports/chain-provider.ts` verb shapes where they overlap (portability to the eRPC→HyperSync future).

### 3. `mock/sonar-sense.mock.ts` — deterministic fixtures
Canned `Observation`s for every verb (test-first; lets Score bind the port before `live/` exists).

### 4. `live/sonar-sense.live.ts` — the runtime (the ONLY place chain config lives)
Construct the chain reader via the **constructor's `rpcUrls` seam** (HARDEN HIGH): `new NativeBlockchainReader(logger, { chains: [{ chainId, …, rpcUrls: [<reachable-rpc>] }] })` — **NEVER `createChainProvider()`/`loadChainProviderConfig()`** (no RPC-URL option there; silently falls back to public RPCs → zero loa-freeside change needed, *contra the brief's "edit native-reader.ts"* which is SUPERSEDED). `balance/owns/native` → `getBalance/ownsNFT/getNativeBalance`; **`read` is a direct viem `readContract`** (mirror native-reader internals — the port has NO generic read verb). GraphQL/index source = **`belt-gateway-production.up.railway.app/v1/graphql` (live, 200)** — NOT the beacon's `b5da47c` (404) or `914708e` (500), both DEAD (live-probed). `doctor` probes belt-gateway + the chosen RPC + the dead-endpoint trap.

### 5. The grounding logic (in `live/`, the verify story)
eRPC redundant-upstream agreement / cache-hit ⇒ `grounded` · circuit-open or fallback-degraded ⇒ `unverifiable` · two sources contradict (e.g. different `ownerOf`) ⇒ `refuted`. Stamp `trace_id` from the Sonar event id / envelope hash.

### 6. `cli/sonar-sense.ts` — the agent surface (incur)
`Cli.create()` with zod arg/option/output schemas → `--help/--llms/--schema/--format toon|json/` + exit codes free. Same schemas serve MCP tools (`incur mcp add`). Deterministic exit codes: 0 ok / 2 bad-input / 3 not-found / 4 upstream-outage / 5 stale-degraded.

### 7. Wire the (reachable-)RPC seam + beacon
Resolve the **eRPC reachability fork** (HARDEN HIGH): `erpc.yaml`'s URL is `erpc.railway.internal:4000` — **private, off-Railway-unreachable**. Either ship `live/` co-located on Railway (server-side, not a laptop CLI) OR default to the public RPC upstreams (berachain publicnode/drpc/official, per `erpc.yaml`) for the local-CLI case. Do **NOT** hand-add `consumes: chain-rpc` to `beacon.yaml` — that key isn't in the BeaconV3 schema and contradicts Sonar's `is_not` ("a SOURCE, not a consumer"); `freeside-cli doctor` rejects/drops it. Correct beacon's dead `b5da47c` GraphQL default → belt-gateway; any membrane change is a separate schema-gated cycle.

## Shipping Scope (Barth)

- **V1 — ship now:** `domain` + `ports` + `mock` + `live`(`doctor`, `read`, `balance`, `owns`, `native` — all grounded sources) + the Observation envelope + the (reachable-)RPC seam + the incur CLI (**add incur as a net-new dep — it is NOT in freeside-sonar**). `category`/`categories` are DEFERRED pending a real index source (HARDEN CRITICAL — see fork D-V1).
- **V2 — after feedback:** `proxy`/`state`/`tx`/`sim` verbs (port construct-protocol's cast primitives) · **Score's parity-check Layer** (consumer #1 — diff Score's Bronze count vs Sonar GraphQL vs the kit's first-hand `read`) · the **alloy/reth Rust tier-2** escape hatch behind the same port.
- **Cut from V1:** the Rust substrate · the `RefinementTier` Hounfour primitive · Dune-Sim-exclusive sensors · any index writes.

## Design Rules (craft = DX)

- `suffix-as-type` filenames: `*.domain.ts` · `*.port.ts` · `*.live.ts` · `*.mock.ts`.
- Observation: TOON default, `--json` for chaining; the 3 grounding states MUST drive different consumer behavior.
- Self-describing: incur `--llms`/`--schema`; every verb has structured help + a next-command CTA hint.
- Canonical term `unverifiable`. Never inline secrets (env-only — do NOT copy any hardcoded-creds script).

## What NOT to Build

No index writes (read-only). No new chain-read impl (consume loa-freeside's `IChainProvider`). No Rust (tier-2 deferred). No `RefinementTier` in Hounfour (domain-local). No berachain-specific branching (the eRPC seam IS the chain-agnostic boundary).

## Verify

`pnpm build && pnpm typecheck` · mock test-first (every verb has a fixture test) · `sonar-sense doctor` probes live Sonar GraphQL + eRPC + the dead-endpoint · the Observation validates against the `EpistemicTristate` constraint · integration: `category <key> --json | read … --json` yields an Observation with `grounding: grounded` on a live wallet.

## Key References

| Topic | Path |
|---|---|
| The brief (research + reductions) | `loa-freeside/grimoires/loa/context/2026-06-03-sonar-sense-kit-brief.md` |
| Chain runtime to consume | `loa-freeside/packages/{core/ports/chain-provider.ts, adapters/chain/native-reader.ts}` |
| Envelope shape to mirror | `loa-freeside/packages/events/src/index.ts` |
| Tristate primitive | `loa-hounfour/{constraints/EpistemicTristate.constraints.json, docs/patterns/epistemic-tristate.md}` |
| Four-folder + suffix patterns | `gh:0xHoneyJar/construct-honeycomb-substrate/patterns/` |
| Sonar's verify pattern + identity | `freeside-sonar/{scripts/parity-check.sh, packages/protocol/beacon.yaml}` |

## Review provenance + Open operator decisions

**HARDEN gate** (`wf_594a60cd` · 4 grounded adversarial lenses + skeptical verify · all claims read against real code + live-probed). **Verdict: SHIPPABLE-WITH-FIXES** — port/runtime architecture + dependency-ordering are sound; the surviving HIGH/CRITICAL findings (above, folded into §1/§2/§4/§7 + blast radius) were dead-ends an implementer would hit. One finding ("914708e is a live mirror") was **REFUTED** by live probe (500). Counts: 1 CRITICAL · 9 HIGH · 10 MEDIUM · 7 LOW · 3 PRAISE.

**Surviving fixes already applied to this doc:** EpistemicTristate = declare-local not import (§1) · `read` = first-party viem, no port delegate (§2/§4) · live GraphQL = belt-gateway not the dead beacon defaults (§4) · construct via `NativeBlockchainReader` rpcUrls, never `createChainProvider` (§4) · eRPC URL is Railway-private (§7) · no hand-added `consumes:` beacon key (§7) · `category` ungrounded → deferred (V1 scope) · Sonar is not a workspace → `src/sense/` relative-import (blast radius) · incur is a net-new dep.

**Open operator decisions — resolve at the build session, NOT silently:**
- **D1 · HOME (the reframe — strongest signal)**: build the kit Sonar-internal vs **extract a shared chain-read building UPSTREAM of both Sonar and Score**. Grounded signals for extract: chain-read sits *below* Sonar in the raw→derived DAG (ADR-008 §D-3); the ≥2-consumer trigger is already met (Sonar + Score both read chain); the runtime lives in loa-freeside's PLATFORM substrate which "contains NO feature logic" yet chain-read IS scoring logic (a pre-existing CLAUDE.md violation); Sonar already does ad-hoc viem in `sf-vaults.ts` (a 4th duplicate read-site). **This changes which repo the port lives in.**
- **D2 · eRPC REACHABILITY**: server-side runtime co-located on Railway (private eRPC works; "local agent CLI" framing is then wrong) vs local/CI-anywhere CLI (must default to public RPC upstreams or require a public+authed eRPC ingress). Determines the default URL `live/` ships with.
- **D3 · CONSUMPTION CHANNEL (if Sonar-internal)**: whole `@freeside/adapters/chain` barrel (drags `@freeside/core` `file:` link + score-service-client; **no installable artifact today**) vs narrow leaf (`IChainProvider` type + a leaf-built reader, mirroring the proven `eventsPin`/`rebuild-events-dist.sh` pattern) vs vendor a thin reader. *The narrow-leaf path IS the extraction in disguise — it leans toward D1-extract.*
- **D4 · GRAPHQL SOURCE-OF-TRUTH**: Sonar is mid-migration (`envio-indexer` name + Envio `public.*` in prod; `ponder.*` under test). The verbs must declare which schema they read; the live endpoint is belt-gateway (200), not the beacon's dead hyperindex aliases.
- **D5 · V1 SCOPE**: keep `category`/`categories` (requires defining their source first — CRITICAL) vs cut to V2 and ship V1 = `doctor` + `read` + `balance` + `owns` + `native` (all grounded). Cutting de-risks the first ship.

PRAISE (HARDEN): the port/runtime split + the EpistemicTristate-as-verify spine + dependency-ordering were called architecturally sound.
