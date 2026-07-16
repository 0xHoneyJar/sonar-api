# CR-104 Solana DAS Recognition Adapter

Wraps the existing Sonar SVM DAS recognition path behind CR-102
`NetworkAdapterPort`. Recognition may ship before preparation/index parity
(CR-402).

## Ownership

| Surface | Role |
|---|---|
| `createSolanaDasNetworkAdapter` | `NetworkAdapterPort` implementation |
| `DasSamplePort` | Injected abort-aware DAS transport (no user RPC URLs) |
| `classifyDasSampleItems` | Shared with `src/svm/probe-collection.ts` |
| `findCollectionByMintExact` | Exact-case SVM registry enrichment only |
| `projectSolanaDasHit` | ProbeHitEvidence projection (no fabricated binding) |

## Invariants

1. **Exact-case Solana keys** — never lowercase collection mints across RPC
   params, registry lookup, evidence, logs, or responses.
2. **Bounded sample** — single `getAssetsByGroup` page (`page: 1`); never call
   full-paginating `DasNftCollectionSource.snapshot()` from the resolver.
3. **Typed failures** — HTTP 429/5xx/auth, RPC/malformed/incomplete/timeout →
   `unavailable` / `timeout` (no raw bodies, URLs, or secrets).
4. **Conclusive miss only on explicit empty** — only a successfully decoded
   `result.items: []` is a miss. Missing/null `result`, missing `items`,
   malformed schema, or a non-empty page where every asset fails shared
   parsing → typed `unavailable` (resolver partial; never authoritative
   negative cache).
5. **Recognition ≠ prepare** — classic / programmable / compressed typed from
   DAS evidence; index/readiness stay `missing` / `preparation_required`
   unless a distinct injected collection-specific readiness port observes
   otherwise. Capability support is only a ceiling — never auto-upgrade from
   coverage (CR-402).
6. **Member metadata ≠ collection identity** — sampled member name/image are
   provenance-only (`evidence_material`). Identity name/symbol/key come from
   exact registry match and/or bounded `getAsset(collection mint)`; omit
   otherwise. Registry match must not inherit the sampled member image.
   `getAsset.result.id` is required as a non-empty exact-case Solana key;
   missing/null/malformed id → incomplete/unavailable (never usable
   metadata). Returned id must equal `request.collection_mint` byte-for-byte;
   wrong case or a different asset → unavailable / metadata omission (never
   identity metadata, never a conclusive miss). Observation and evidence bind
   the **observed** returned id — never a request-stamped substitute.
7. **No fabricated binding** — omit `binding_evidence` (no honest Solana
   `code_digest` / matching finality from a DAS sample). CR-102 refuses
   positive/readiness cache writes.
8. **Registry enrichment** — exact mint match only; display name / symbol /
   `collection_key`; never cross-deployment equivalence.

## Production fixture note

`test/fixtures/pyth-das-getassetsbygroup.json` is a real Helius capture.
Items lack DAS `interface`, so the shared classifier currently reports
`coverage=unknown` / `token_standard=unknown` (ambiguous recognition). That
classification is asserted deliberately — do not silently treat missing
interface as programmable/classic.

## Downstream blockers

- Operator-sealed DAS endpoint wiring into production `resolveBounded` deps
- Solana prepare / ownership_index parity (CR-402) via injected readiness port
- Complete ProbeHitEvidence binding once a truthful Solana code/account /
  slot+blockhash observation path exists
