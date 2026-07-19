---
hivemind:
  schema_version: "1.0"
  artifact_type: product-spec
  product_area: "sonar-api — EVM Collection Onboarding Contract v1 (canonical NftActivity adoption + Token ownership index)"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "onboard the Nth EVM collection by looking up ONE documented, versioned contract — not reverse-engineering the per-collection Action-overlay grammar — and give every consumer (inventory-api, score-mibera, freeside-dashboard) an indexed, presence-guaranteed ownership + activity surface. Two deliverables: adopt the already-built canonical NftActivity contract via its go-live handshake, and land the one genuine gap — the Token ownership index (#153) — fresh on main with a reindex runbook."}
  learning_status: directionally-correct
  source: team-internal
---

# PRD — EVM Collection Onboarding Contract v1

> **Status**: draft · **Date**: 2026-07-07 · **Repo**: 0xHoneyJar/sonar-api (thj-envio / freeside-sonar)
> **Phase**: `/plan-and-analyze` output → feeds `/architect`. This is the **canonical** `grimoires/loa/prd.md`
> (promoted 2026-07-07 when the belt cycle completed). Golden-path skills run against it directly.
> **Sibling PRD** (NOT superseded — parallel track, archived by name): `grimoires/loa/prd-belt-zero-downtime.md`
> (EVM belt zero-downtime re-platform).
> **Agent door**: `grimoires/loa/ARRIVAL.md` — which doc to load (planning vs as-built vs belt sibling).
> **Encoding**: Effect Schema / EffectTS — the estate already runs `effect@3.10` + `@effect/schema@0.75`;
> the canonical layer (`src/canonical/`) is the reference.
> **Doctrine**: contract-first — *schema-is-not-the-contract* (a schema is shape; the contract is shape
> **+** semantics **+** invariants **+** version) and *contracts-as-bridges* (the contract is the seam
> two buildings cross, so it is versioned and its parity is executable, not prose).

---

## 1. Problem & Context

> Sources: `src/handlers/tracked-erc721.ts`, `schema.graphql:350` (Token) + `:287,294,305` (indexed peers), `src/canonical/{map-evm,map-svm,emit,parity}.ts`; issues #151, #153, #115, #120, #121, #135, #95, inventory-api#27.

Onboarding a new EVM community to sonar today is a **per-collection reverse-engineering task**, not a
lookup. Three concrete failures make this the urgent problem:

- **The grammar is undocumented and must be re-derived per collection.** #151 ("EVM action_type
  vocabulary — semantics + full enum needed to onboard Azuki") exists because a consumer could not tell
  what the `Action` overlay rows *mean*. The answer (grounded in `src/handlers/tracked-erc721.ts`) is that
  every `Transfer(from,to,tokenId)` fans out into `hold721` (the per-wallet ownership ledger: `actor`=wallet,
  `context.direction` in/out, `numeric1`=resulting balance) **plus** `mint`/`transfer`/`burn` label overlays
  joinable by `txHash+logIndex`. That answer had to be excavated by hand — it is not a contract anyone can
  look up.

- **The ownership index is missing in prod.** #153 ("Land belt-factory Token ownership index on main —
  Mibera owner→tokenIds empty in prod") is blocking **inventory-api#27** ("EVM getNftsForOwner returns
  empty nfts[] while holdings reports tokenCount > 0"). The `type Token` entity exists in
  `schema.graphql:350` (`id, collection, chainId, tokenId, owner, isBurned, mintedAt, lastTransferTime`)
  but carries **no `@index`** on `owner` / `collection` / `isBurned` — the exact fields an
  owner→tokenIds lookup filters on (contrast the indexed entities at `schema.graphql:287,294,305`). Holdings
  (aggregate count) is correct while the enumerable per-token list is empty/unindexed.

- **Value-at-stake is absent for EVM.** #115 ("Decode + emit EVM marketplace sale price for purupuru —
  Base Seaport — the EVM twin of `svm_collection_event.price`") exists because no priced-sale action is
  emitted on EVM today; the only sale signal is `transfer.context.viaMarketplace` (a boolean flag, no price).

The scale driver behind all three is **#121 / #135**: score-api is ramping to **~100 collections**. At that
cardinality, "reverse-engineer the grammar + hand-check config + discover the index is missing" per
collection does not survive. #120 (Azuki still 0 holders after a config fix) and #95 (tag the main Mibera
collection) are the recurring per-collection config-correctness tax this ramp pays today.

**The asset we already hold.** `src/canonical/` is a mature, FAGAN-reviewed Effect-Schema **canonical
contract layer** that already answers #151 and #115 by construction — it is built, tested, and **shipped
inert** (deployed-but-unconsumed, gate default OFF), awaiting a consumer handshake:

- `src/canonical/map-evm.ts` — pure mapper: EVM legs → canonical `NftActivity`, returning
  `Either<NftActivity, SchemaInvalid>`, validated through the sealed `NftActivitySchema` from
  `@0xhoneyjar/events`. Derives the verb vocabulary (`mint`/`burn`/`sale`/`transfer`) — **this is #151 as a
  typed contract, not a per-collection excavation** — and re-derives sale seller/buyer/price
  (`value` = wei decimal string + `decimals:18`) — **this is #115**. The sale derivation is a *versioned
  producer contract* (`map-evm.ts:34`): re-derivable from `(tx, log_index, token_id)`; a heuristic change
  re-runs under a new `schema_version` (runbook), never an in-place mutation.
- `src/canonical/map-svm.ts` — the SVM twin (same `NftActivity` target), so the contract is already
  chain-agnostic.
- `src/canonical/emit.ts` — the NATS emission layer under a **distinct** publisher identity
  (`emitted_by="sonar-canonical"`, separate hash chain, F1 fix), gated by `isCanonicalEmitEnabled`
  (default OFF) with named S6 go-live prerequisites.
- `src/canonical/parity.ts` — an **executable** S5 consumer-parity gate: a pure function comparing the
  canonical stream's `(tx, asset_ref, verb)` key-set against the legacy consumer's, so "does canonical lose
  nothing the consumer relies on?" is a test, not a checklist.

So v1 is **not** a green-field contract design. It is: **adopt the contract that exists** (complete its
go-live handshake) and **build the one genuine gap** (the #153 Token index), documenting both as the single
thing an operator looks up to onboard collection N+1.

---

## 2. Vision & Goals

> Sources: §1 problem synthesis; issues #151/#115/#153/#121; `src/canonical/parity.ts` (S5 gate), `src/canonical/emit.ts` (S6 prereqs).

**Vision.** Onboarding an EVM collection is a **lookup against one versioned contract**, not a reverse-
engineering session. Every consumer reads ownership and activity from an indexed, presence-guaranteed,
schema-versioned surface; adding the 100th collection is config + backfill, not archaeology.

**Goals (v1):**

| # | Goal | Success signal |
|---|------|----------------|
| G1 | The canonical `NftActivity` stream is THE documented onboarding contract — verb vocabulary (#151) and sale value (#115) answered by construction, versioned. | A new-collection onboarder reads one contract doc + the sealed schema; no per-collection grammar excavation. |
| G2 | Land the Token ownership index on main (#153) so owner→tokenIds is non-empty and indexed in prod. | inventory-api#27's `getNftsForOwner(Mibera)` returns the correct token list; `Token.owner`/`collection`/`isBurned` are `@index`-backed. |
| G3 | Migrate the first consumer (score-mibera) onto canonical via the S5 parity handshake with zero silent loss. | `parity.ts` reports `legacyOnly` **empty** (presence parity holds) + a passed value-parity step for sales; canonical gate flipped ON for that consumer. |
| G4 | The per-collection **onboarding operational contract** is documented: config shape, a backfill/coverage watermark consumers can query, and the capacity envelope for the ~100-collection ramp. | #120-class config mistakes are caught by the onboarding checklist; #135's status-endpoint shape is served; #121 capacity questions have a documented answer. |

**Non-goals (v1 — explicitly out):**

- **N1** — Ripping out the legacy raw `Action` table. It becomes *legacy* (canonical is the new contract)
  but stays serving until every consumer has completed its own S5 handshake. v1 migrates **one** consumer
  (score-mibera); the rest is v2.
- **N2** — cNFT / compressed-NFT or non-721/1155 standards on the EVM side.
- **N3** — A durable prev-hash store as new infrastructure. v1 uses the accepted in-memory store (matching
  the existing sonar-api publisher) **or** a consumer-side chain-reset handshake — whichever the S6
  checklist selects; a durable store is a shared future improvement, not this scope.
- **N4** — Re-backfilling all 6 EVM chains. The #153 index lands via a scoped reindex runbook, not a full
  re-ingest (that is the sibling belt-zero-downtime PRD's concern).
- **N5** — Sale-price *attribution beyond the ETH/WETH v1 baseline* (aggregator-sweep decomposition, non-ETH
  ERC-20 currencies). The uniform priced-sale decode itself is now **in scope as FR-6** (un-deferred per #115
  comment 4911466984); improving coverage past the ~71% ETH/WETH baseline is a later `schema_version` bump.

---

## 3. Users & Consumers

> Sources: inventory-api#27, issues #151/#115/#121/#135; `src/canonical/parity.ts` (score-mibera as S5 consumer).

| Consumer | Needs from the contract | Current blocker |
|----------|-------------------------|-----------------|
| **inventory-api** (#27) | Enumerable owner→tokenIds per collection | Empty `nfts[]` — Token index missing/unindexed (#153) |
| **score-mibera / score-api** (#151, #115, #121, #135) | A stable verb vocabulary + sale value + presence guarantee, at ~100-collection scale | Reverse-engineers the Action overlay per collection; no priced EVM sale; no documented capacity/status contract |
| **freeside-dashboard** [ASSUMPTION — needs confirm] | A read surface for onboarding/coverage status | — |

---

## 4. Functional Requirements

> Sources: `src/canonical/map-evm.ts` (:34 versioned sale derivation), `map-svm.ts`, `emit.ts` (F1/S6), `parity.ts` (S5, MAJOR-1/2/3); `schema.graphql:350`; issues #153/#151/#115/#120/#95/#121/#135, inventory-api#27.

### FR-1 — Adopt canonical `NftActivity` as the onboarding contract
The sealed Effect-Schema `NftActivity` (from `@0xhoneyjar/events`, produced by `src/canonical/map-evm.ts`
/ `map-svm.ts`) is designated THE onboarding contract. Onboarding docs point at the schema + the verb
vocabulary + the versioning rule. This **subsumes #151** (verb vocabulary is a typed field, not a
per-collection excavation) and **#115** (sale `value` + `decimals` are contract fields, re-derivable and
versioned per `map-evm.ts:34`). The raw `Action` table is reclassified *legacy* (see N1).

- **FR-1a** — The contract is versioned: every activity carries `schema_version`; a sale-derivation
  heuristic change re-runs under a new version (runbook), never mutates in place.
- **FR-1b** — Producer identity is distinct (`emitted_by="sonar-canonical"`, separate hash chain) —
  already enforced in `emit.ts` (F1). Do not reuse the sonar-api publisher chain or signer.

### FR-2 — Land the Token ownership index on main (#153), re-implemented fresh
Re-implement the belt-factory Token ownership index **fresh on main** (do not cherry-pick a diverged
branch) so owner→tokenIds is populated and indexed in prod.

- **FR-2a** — `type Token` (`schema.graphql:350`) gains `@index` on `owner`, `collection`, and `isBurned`
  (the fields inventory-api#27's query filters on).
- **FR-2b** — A **reindex runbook** brings prod to the indexed state without a full 6-chain re-backfill
  (scoped reindex; ties into the belt cutover mechanics from the sibling PRD where they overlap).
- **FR-2c** — Acceptance is inventory-api#27: `getNftsForOwner(Mibera owner)` returns the correct,
  non-empty token list, and `holdings.tokenCount` reconciles with `len(nfts[])`.

### FR-3 — Migrate score-mibera onto canonical via the S5 parity handshake
Complete the executable S5 gate (`src/canonical/parity.ts`) against score-mibera's current fetchers before
flipping the consumer live.

- **FR-3a** — **Presence parity**: `parity.ts` reports `legacyOnly` **empty** — the canonical stream loses
  nothing the consumer relies on, dedup-keyed by `(tx, asset_ref, verb)`. This is the cardinal-sin /
  silent-loss guard and is a hard gate.
- **FR-3b** — **Value parity** (separate step): for `matched` sale keys, confirm re-derived
  `from`/`to`/`value` agree with legacy (parity.ts checks presence only, `valueParityChecked:false` —
  MAJOR-2). A demoted sale (`verbDisagreements`, MAJOR-1) is a real loss and blocks go-live.
- **FR-3c** — Quantify and DECIDE on `canonicalOnly` over-emits (the known MAJOR-3 market-routing-hop
  `verb=transfer` extras): tolerate or suppress with real marketplace topology. Extras do not break parity
  but must be an explicit decision, not a silent surplus.

### FR-4 — Satisfy the S6 go-live prerequisites, then flip the gate
Before setting `isCanonicalEmitEnabled` true for the migrated consumer (per `emit.ts` S6 carry-forward):

- **FR-4a** — Durable prev-hash store **OR** a consumer-side chain-reset handshake (a restart re-genesis-es
  the chain; a verifying consumer would otherwise surface prev-hash-broken every restart).
- **FR-4b** — Build the live emitter only via the capability factory (`makeCanonicalEmitterIfEnabled` —
  null when disabled); the live path must be unconstructable while off.
- **FR-4c** — Seed the signer from a DISTINCT secret (`SONAR_CANONICAL_SIGNING_SEED_HEX`); never reuse
  `SONAR_SIGNING_SEED_HEX`.
- **FR-4d** — Wire `recovery` (maxRetries + deadLetter + onAlert) so a NATS blip is an observable
  dead-letter, not a silently-dropped `Left`.

### FR-5 — Document the per-collection onboarding operational contract
The lookup that replaces per-collection archaeology (covers #120, #95, #121, #135):

- **FR-5a** — **Config shape**: the per-collection onboarding descriptor (chain, address(es),
  tracked-vs-holder mode, standard 721/1155) + a checklist that would have caught #120 (Azuki 0 holders
  post-config) and #95 (main Mibera 0x6666 on Berachain).
- **FR-5b** — **Coverage watermark**: a status surface consumers can query for "is collection X backfilled
  to block/slot N?" — the shape #135 asks for. [VERIFY — reconcile with the belt `sync_status` /
  watermark surface so there is ONE watermark contract, not two.]
- **FR-5c** — **Capacity envelope**: a documented answer to #121's ~100-collection capacity & contract
  questions (per-collection cost, indexer/query headroom). [ASSUMPTION — concrete numbers are an SDD/spike
  task; v1 PRD commits to producing the envelope, not to specific limits.]

### FR-6 — Uniform priced EVM sale decode (extends #115 to the whole EVM ramp)
Per #115 comment 4911466984 (score-api, after onboarding Azuki): make **every** EVM collection emit the SAME
classified, priced sale — the `evm_collection_event` twin of `svm_collection_event` — so score-api runs ONE
consumer path instead of `operator`-vs-`viaMarketplace`-vs-SVM branches. Today the sale signal is
per-collection: SVM `kind='sale'`+price ✓; purupuru `context.operator` (no price); Azuki
`context.viaMarketplace` bool (no price — 107k transfers, 40%); Mibera/HoneyJar Seaport→`amountPaid` ✓. The
uniform shape is the canonical `NftActivity` sale (FR-1: `verb="sale"` + `value` wei + `decimals` +
`marketplace`) — this FR makes it actually *priced* across the ramp, not just shaped.

- **FR-6a** — Extend the Seaport `OrderFulfilled` decode
  (`src/handlers/seaport.ts::handleSeaportOrderFulfilled` — already sums native + wrapped-native into
  `amountPaid` and emits priced SALE/PURCHASE) to **mainnet (chain 1)**: add the mainnet Seaport binding +
  mainnet WETH (`0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`) to `SEAPORT_CONFIG` (today 80094 + 8453 only).
  Copy-adapt, not a design — the consideration/offer split (listing vs accepted-bid) is already written.
- **FR-6b** — Wire Azuki (`0xed5af388653567af2f388e6224dcc93746104133`, chain 1, key `azuki`) and the rest
  of the indexed EVM queue so `OrderFulfilled` produces a priced SALE row that `map-evm.ts` surfaces as
  canonical `value` (today null — the gap the comment reports).
- **FR-6c** — ETH/WETH-only is acceptable for v1 (same ~71%-coverage rationale as the purupuru analysis;
  null/skip aggregator sweeps + non-ETH ERC-20). Improving attribution beyond that is a `schema_version`
  bump (N5).
- **FR-6d** — Boundary unchanged (#85): the indexer emits only the event fact ("sale settled for X wei of
  token Y on marketplace M"); score-api owns all downstream floor/filter/scoring.

---

## 5. Thread → Requirement Traceability

> Sources: `gh issue view` titles for #153/#151/#115/#121/#135/#120/#95 (0xHoneyJar/sonar-api) + #27 (0xHoneyJar/inventory-api).

| Issue | Title (abbrev) | Resolution in v1 |
|-------|----------------|------------------|
| **#153** | Land Token ownership index on main | **FR-2** (the urgent build gap) |
| **inventory-api#27** | getNftsForOwner returns empty nfts[] | **FR-2c** acceptance |
| **#151** | EVM action_type vocabulary | **FR-1** — subsumed by canonical verb (answered on-issue) |
| **#115** | Decode + emit EVM sale price — **now: uniform priced sale across the whole EVM ramp** (comment 4911466984) | **FR-1** (uniform *shape*) + **FR-6** (mainnet Seaport decode → *price* for Azuki + queue) |
| **#121** | Ramp to ~100 collections — capacity | **FR-5c** capacity envelope |
| **#135** | Ramp readiness — status-endpoint shape | **FR-5b** coverage watermark |
| **#120** | Azuki still 0 holders post config | **FR-5a** onboarding config checklist |
| **#95** | Tag main Mibera (0x6666, Berachain) | **FR-5a** config instance |

---

## 6. Constraints, Doctrine & Dependencies

> Sources: `package.json` (`effect@3.10`, `@effect/schema@0.75`); `src/canonical/*` idiom; `@0xhoneyjar/events` (sealed `NftActivitySchema`); doctrine — schema-is-not-the-contract, contracts-as-bridges.

- **Effect Schema throughout** — `effect@3.10` + `@effect/schema@0.75` are already deps; `src/canonical/`
  is the pattern (`Schema as S`, `Either`, `TreeFormatter`, sealed `NftActivitySchema`). New contract code
  follows it; no new validation dependency.
- **Contract-first** — the schema is *shape*; the contract adds *semantics* (verb meanings), *invariants*
  (presence / never-drop, `legacyOnly` empty), and *version* (`schema_version`). The seam is versioned
  because two buildings cross it.
- **NEVER-DROP discipline** — a mapping failure returns `Either.Left(SchemaInvalid)` (observable), never a
  silent drop; the S5 gate enforces zero `legacyOnly`.
- **Dependency on `@0xhoneyjar/events`** — the sealed `NftActivitySchema` lives upstream; a contract change
  is a coordinated package bump, not a local edit.
- **Zone** — schema + mapper code is App zone (`src/`, `schema.graphql`) → confirm writes; runbook/docs are
  State zone (`grimoires/`).

---

## 7. Risks

> Sources: `src/canonical/parity.ts` (MAJOR-1/2/3, value-vs-presence parity), `emit.ts` (S6 prev-hash re-genesis); #153 branch-divergence; sibling belt PRD (watermark/reindex overlap).

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Branch divergence on #153** — the belt-factory index exists on a diverged branch; cherry-pick could reintroduce stale assumptions | Wrong index / silent reconcile drift | FR-2 mandates **re-implement fresh on main**; reindex runbook is the reconcile path (not a merge) |
| **Value-parity divergence on sales** — `map-evm.ts` re-derives seller/buyer/price; a re-impl can diverge from legacy `fetchMiberaBuyers/Sellers`, and the consumer *scores* on those values | Consumer scores on wrong sale party/price → GREEN presence-parity hides it | FR-3b makes value-parity a **separate, explicit** go-live step; `verbDisagreements` (demoted sale) is a hard block |
| **Over-emit surplus (MAJOR-3)** — canonical emits extra `verb=transfer` routing hops | Consumer double-counts activity | FR-3c: quantify by verb, DECIDE tolerate/suppress with real topology before go-live |
| **Prev-hash re-genesis on restart** — in-memory store re-genesis-es the chain; a verifying consumer sees prev-hash-broken | Canonical's whole value (verifiability) breaks per restart | FR-4a: durable store OR consumer chain-reset handshake before flip |
| **Two watermark contracts** — belt `sync_status` vs a new onboarding watermark | Consumers query the wrong one | FR-5b [VERIFY]: reconcile to ONE watermark surface with the belt PRD |
| **Reindex touching prod serving** | Downtime during #153 landing | Scoped reindex runbook (FR-2b); coordinate with belt zero-downtime cutover mechanics |

---

## 8. Acceptance (v1 done-when)

> Sources: FR-2c (inventory-api#27), FR-3 (`parity.ts` S5), FR-5 (onboarding doc), FR-1 (#151/#115 by construction).

1. **#153/`#27`**: `getNftsForOwner(Mibera)` returns the correct non-empty token list in prod; `Token`
   is `@index`-backed on `owner`/`collection`/`isBurned`; reindex runbook committed.
2. **Canonical adopted for one consumer**: score-mibera reads canonical `NftActivity`; `parity.ts` shows
   `legacyOnly` empty **and** the value-parity step passed; gate flipped ON with FR-4 prereqs met.
3. **Onboarding contract documented**: a single doc an operator uses to onboard collection N+1 — schema +
   verb vocabulary + versioning rule + config checklist + watermark query + capacity envelope.
4. **#151 and #115 closed by construction** (referenced to the canonical schema, not a new per-collection
   artifact); raw `Action` table reclassified legacy (still serving un-migrated consumers).

---

## 9. Open Questions (for `/architect`)

> Sources: FR-5b [VERIFY] watermark reconcile, FR-2 (#153 index shape), FR-5c (#121 capacity spike), N1/OQ-4 (consumer migration order).

- **OQ-1** — One watermark contract: does the onboarding coverage surface (FR-5b) reuse the belt
  `sync_status` table, or is it a distinct read model? (Resolve before SDD.)
- **OQ-2** — #153 index: is the fresh-on-main implementation an Envio entity `@index` change only, or does
  it need a derived owner→tokenIds projection entity for enumerability at scale?
- **OQ-3** — Capacity envelope (FR-5c): what are the real per-collection cost + query-headroom numbers at
  ~100 collections? (Likely a small spike, BOEHM-shaped.)
- **OQ-4** — Consumer migration order after score-mibera (v2 scope boundary): which consumer is second, and
  does inventory-api read canonical or stay on the Token index read model?
