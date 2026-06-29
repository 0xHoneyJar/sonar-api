# Session — Sonar Sense: chain-agnostic port unification (#1)

> The kit can *read* Berachain and Solana today through two separate doors. This session makes it **one door** — the verb-concept stays, the chain enriches, and the merged EVM V1 must not flinch.

## Context

V1 shipped an EVM-only `SonarSense` (viem) and merged into `b-1-green-belt` (PR #61). A mini-prototype (`feat/sonar-sense-solana`, commit `440fd356`) then proved the thesis: the chain-neutral `Observation` envelope (grounding tristate = the verified-state primitive, per ACVP) carries a **real Solana mainnet read** unchanged (5/5 live smoke). This session does **#1 from the roadmap**: unify the two adapters behind one chain-agnostic port — `Address` union + `ChainAdapter` registry — so a consumer (Score, any agent) calls `sense.native(chain, account)` and the runtime dispatches to viem or web3.js by chain, with the grounding/verify spine living **once** at the port level.

The operator's steer (2026-06-03) is load-bearing: **do not lock chain-specific verbs — hoist the concept, let the chain enrich.** `native`/`balance`/`owns` are agnostic concepts; `read`'s *descriptor* is chain-enriched (EVM `{contract, fnSig}` vs Solana `{account, idlType}`). Sovereign + cheap by default (public RPC; Helius/eRPC opt-in).

## Run via — `code-implement-and-review` (REQUIRED)

`~/bonfire/construct-compositions/compositions/delivery/code-implement-and-review.yaml`

The loop: **implement ONE layer (test-first) → cheval-routed multimodal review → operator directs at the seam → next layer.** The composition's `review_routing` block auto-mandates the cheval council on `data-validity`/`financial` surface classes — this work is `data-validity`, so the routing fires. Operator steps in at each layer seam (the RLHF curation point).

## Review Cadence — HIGH STAKES (data-validity)

The `Observation` IS the verified-state primitive; a wrong grounding is a silent data-integrity failure. **Per-layer review is the cheval-routed multimodal council** — `construct-fagan/scripts/cheval-council.sh` (voices → headless adapters: `gpt-reviewer`→`openai:codex-headless`, `reviewing-code`→a claude reviewer, `deep-thinker`→`google:gemini-headless`). Single-model review (even multiple Claude subagents) is FORBIDDEN — one corpus shares its blind spots. `--skip-harden` is NOT offered. Doctrine: `grimoires/loa/context/2026-06-03-intelligence-router-coherence.md`.

## Load Order

1. `~/bonfire/construct-compositions/compositions/delivery/code-implement-and-review.yaml` — the driving loop
2. `grimoires/loa/specs/enhance-sonar-sense-kit.md` — the V1 spec (what shipped; do not re-derive)
3. `src/sense/domain/observation.domain.ts` — the envelope being widened (chain_id)
4. `src/sense/ports/sonar-sense.port.ts` — the port being widened (Address, ChainId)
5. `src/sense/live/sonar-sense.live.ts` — the EVM viem reader (becomes the EVM adapter — WRAP, don't rewrite)
6. `src/sense/live/solana/sonar-sense-solana.live.ts` — the Solana adapter (conform to ChainAdapter)
7. `grimoires/loa/context/2026-06-03-intelligence-router-coherence.md` — the review doctrine

## Persona

ARCH — the-arcade (OSTROM, structural/blast-radius) + the honeycomb four-folder discipline. Craft lens = **DX/API ergonomics** (ALEXANDER applied to the consumer's call-site, not pixels): the unified call must read as cleanly as the EVM-only one did.

## Invariants (what MUST NOT change)

1. **The merged EVM V1 behavior** — every existing EVM call (`native`/`balance`/`owns`/`read`/`doctor` with a numeric chain + `0x` address) returns the byte-identical Observation it did at PR #61. The 42 V1 tests are the tripwire; they stay green at every step.
2. **The `Observation` envelope's chain-neutral fields** — `grounding`/`tier`/`trace_id`/`confidence`/`schema_version` semantics. `schema_version` stays `sonar-sense/observation@1` (widening `chain_id`'s type is additive, not a breaking field change).
3. **The grounding tristate semantics** — `grounded`/`refuted`/`unverifiable` each drive a distinct consumer behavior; never collapsed. The implementor contract (port docblock L65-87) holds for BOTH families: malformed input ⇒ `unverifiable` + descriptive source, NEVER throws.
4. **The verb-concepts** — `native`/`balance`/`owns`/`read`/`doctor`. No chain-specific verbs added (operator steer). The chain param + descriptor enrich.
5. **Sovereign-cheap default** — public RPC; `ERPC_URL`/`SOLANA_RPC_URL` opt-in. No paid dependency baked in.

## What to Build (dependency-ordered — derisking-first)

Each step ends with the **regression gate**: `npx vitest run src/sense` (the 42 V1 + Solana tests) green + `tsc --noEmit` clean, BEFORE the cheval-council review. The build order is deliberately additive — EVM-safe widenings first, Solana wiring last.

### 1. Widen the domain — `chain_id: number → number | string`
`observation.domain.ts:66` (`Observation.chain_id`) + `:84` (`ObservationInit.chain_id`). Purely additive (number ⊆ number|string). The Solana adapter can then stamp the real cluster string (`"mainnet-beta"`) instead of the prototype's sentinel `101`. **Derisk:** EVM callers pass numbers unchanged; assert the 42 V1 tests green. The CLI's `OBS_OUTPUT` zod (`cli/sonar-sense.ts:59` `chain_id: z.number()`) must widen to `z.union([z.number(), z.string()])`.

### 2. Widen the port — `Address` union + `ChainId`
`ports/sonar-sense.port.ts:22,29`. `Address = EvmAddress | SolanaAddress` (EvmAddress = `0x${string}`; SolanaAddress = branded base58 string). `ChainId = number | string`. The verb signatures stay — they now accept either family. **Derisk:** EVM call-sites (`0x` + number) still typecheck (union is wider).

### 3. The `ChainAdapter` interface — the family contract
New `src/sense/adapters/chain-adapter.ts`. The verbs at the adapter level, chain-typed: an adapter declares which `ChainId`s it serves + implements `native`/`balance`/`owns`/`read`/`doctor` returning `Observation<T>`. This is the anti-corruption seam between the agnostic port and the family runtimes.

### 4. EVM adapter — WRAP the existing viem reader (do NOT rewrite)
`src/sense/adapters/evm.adapter.ts`. The merged `makeLiveSonarSense` (`live/sonar-sense.live.ts`) already IS the EVM runtime; the adapter is a thin conformance shim around it. **Derisk:** the EVM path is behavior-unchanged by construction — the V1 reader is untouched, only re-exposed through the adapter shape.

### 5. Solana adapter — conform the prototype to `ChainAdapter`
`live/solana/sonar-sense-solana.live.ts` (exists). Make `makeSolanaSense` satisfy `ChainAdapter`; switch chain_id from sentinel `101/103` to the real cluster strings (now that step 1 widened the type). Serves `ChainId ∈ {"mainnet-beta","devnet"}`.

### 6. The unified `SonarSense` factory — dispatch by chain
`src/sense/live/sonar-sense.unified.ts` (or fold into a `makeSonarSense({ adapters })`). A registry maps `ChainId → ChainAdapter` (number → EVM, string → Solana); each verb resolves the adapter for `chain` and delegates. **The grounding/verify spine stays at THIS level, adapter-agnostic** — the `verify` cross-check orchestrates "read from the adapter's ≥2 upstreams + compare" without knowing the family. Unknown chain ⇒ `unverifiable` source `unsupported-chain` (the V1 contract, generalized).

### 7. Solana verify cross-check — port the spine
The prototype is basic grounded-on-success. Implement `verify` for Solana: read the same account from ≥2 Solana RPCs (public + a second public/Helius) and apply the same agreement logic as the EVM `crossCheck` (≥2 agree ⇒ grounded · contradict ⇒ refuted · <2 ⇒ unverifiable). This is the load-bearing "verified state, any chain" proof.

### 8. The `read` chain-enriched descriptor
The one verb that bends. `read(chain, ref, opts)` where `ref` is a discriminated descriptor: EVM `{ kind: "evm", address, fnSig, args }` | Solana `{ kind: "solana", account | { seeds, program }, idlType? }`. EVM → `readContract`; Solana → `getAccountInfo` + (raw bytes V1; Anchor-IDL decode is design-noted). **This is an Open Operator Decision — see below; confirm the descriptor shape before building.**

### 9. CLI cluster-routing
`cli/sonar-sense.ts` — the `chain` arg accepts a cluster string; dispatch through the unified factory. The exit-code map + `OBS_OUTPUT` already generalize once chain_id widens (step 1).

## Blast Radius

| Artifact | Change | Risk |
|---|---|---|
| `domain/observation.domain.ts` | `chain_id` type widen (additive) | LOW (additive) |
| `ports/sonar-sense.port.ts` | `Address` union, `ChainId` widen | LOW (wider type) |
| `adapters/chain-adapter.ts` | NEW interface | NONE (new) |
| `adapters/evm.adapter.ts` | NEW (wraps existing reader) | LOW (no reader change) |
| `live/solana/*.ts` | conform to ChainAdapter + real cluster ids | LOW (new family) |
| `live/sonar-sense.unified.ts` | NEW dispatch + spine | MED (the new orchestration) |
| `cli/sonar-sense.ts` | chain-routing + zod widen | MED (touches shipped CLI) |
| `mock/sonar-sense.mock.ts` | accept widened types | LOW |
| deps | `@solana/web3.js` (already added) | NONE |

## Design Rules (DX craft — ALEXANDER at the call-site)

- The unified call MUST read as cleanly as V1: `sense.native(80094, "0x..")` and `sense.native("mainnet-beta", "9xQ..")` are the SAME ergonomics — the union is invisible at a correct call-site.
- The `Address` brand must not force casts on EVM literals (`0x..` stays assignable). Validate family at the runtime boundary, not by forcing consumer ceremony.
- One verb = one concept. If you reach for a Solana-only verb name, stop — that's the descriptor's job.
- Every adapter stamps a NON-EMPTY `trace_id` and never throws (the V1 implementor contract, unchanged).

## What NOT to Build (Barth)

- **The Solana "ears" / event indexer** (compass's radar) — that's the read-side's sibling, a separate, larger lift.
- **Helius DAS / compressed-NFT richness** — `owns` stays the free token-account scan; DAS is a later opt-in.
- **Full Anchor-IDL account decode** — `read` returns raw account bytes in V1 of this work; IDL decode is design-noted.
- **Removing the V1 EVM reader** — it becomes the EVM adapter's engine, untouched. No rewrite.
- **New chains beyond Berachain + Base (EVM) and Solana** — the registry makes them cheap later; don't add speculatively.

## Verify

- `npx tsc --noEmit -p tsconfig.json` clean · `npx vitest run src/sense` (42 V1 + Solana) green at EVERY step.
- `SONAR_SENSE_LIVE=1 npx vitest run src/sense/live` — both EVM (Berachain) and Solana (mainnet) live smokes pass through the unified factory.
- Integration: one consumer call-site reads BERA and SOL through the same `sense` instance, both returning grounded Observations.

## Review provenance + Open operator decisions

*Provenance:* this spec is grounded against the real code — every citation verified by reading the file this session: `chain_id: number` at `observation.domain.ts:66,84`; `Address = 0x${string}` at `ports/sonar-sense.port.ts:22`; `ChainId = number` at `:29`; `OBS_OUTPUT chain_id: z.number()` at `cli/sonar-sense.ts:59` — plus the live Solana smoke (5/5). HARDEN cheval-council pass (deep-thinker · gpt-reviewer · reviewing-code, headless adapters): **0 concrete findings** (reviewing-code APPROVED; the other two returned bare CHANGES_REQUIRED with no articulable defect — the spec-vs-code-diff tool mismatch, the council is tuned for diffs). The load-bearing HARDEN here is the grounding (above) + the surfaced forks (below), not the diff-shaped verdict.

**Open operator decisions (do NOT silently resolve):**
- **D1 — `read` descriptor shape** (step 8): discriminated `{kind: "evm"|"solana", ...}` vs a thinner overload. The operator steered toward "chain-enriched descriptor, not a separate verb" — confirm the exact discriminator before building step 8. *(Recommend: discriminated union on `kind`.)*
- **D2 — `chain_id` value for Solana**: real cluster string (`"mainnet-beta"`) now that the type widens, vs keep sentinel numbers. *(Recommend: cluster string — the prototype's `101` sentinel was a type-fit hack the widen removes.)*
- **D3 — `SolanaAddress` brand**: branded `string & {__brand}` (type-safe, needs a validator-at-boundary) vs plain `string`. *(Recommend: branded, validated in the adapter.)*
- **D4 — CLI scope**: unify the CLI (step 9) this session, or defer to a follow-up and ship the library-level unification first. *(Recommend: defer 9 — ship steps 1-8 as the port unification; CLI routing is a thin follow-up.)*

## Key References

| Topic | Path |
|---|---|
| V1 spec | `grimoires/loa/specs/enhance-sonar-sense-kit.md` |
| Envelope (widen target) | `src/sense/domain/observation.domain.ts` |
| Port (widen target) | `src/sense/ports/sonar-sense.port.ts` |
| EVM reader (→ adapter) | `src/sense/live/sonar-sense.live.ts` |
| Solana adapter (prototype) | `src/sense/live/solana/sonar-sense-solana.live.ts` |
| Review doctrine | `grimoires/loa/context/2026-06-03-intelligence-router-coherence.md` |
| Composition | `~/bonfire/construct-compositions/compositions/delivery/code-implement-and-review.yaml` |
