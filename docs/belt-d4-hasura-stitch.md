# Belt D4 — Hasura Remote-Schema Federation Stitch

> **Scope**: This runbook covers the federation-Hasura stitch that ties the six
> per-chain belt Hasura instances into a single GraphQL endpoint behind the
> existing Caddy gateway.  It does not cover belt provisioning, blue/green
> cutover, or the Track-A raw-lake path — those live in
> `docs/A-4-cutover-runbook.md` and `grimoires/loa/sdd.md §7.4`.

---

## 1. Why a federation layer?

The D4 per-chain split replaces the single 6-chain `config.yaml` belt with six
single-chain belt services (`belt-eth`, `belt-arb`, `belt-zora`, `belt-op`,
`belt-base`, `belt-bera`).  Each belt owns its own Envio deployment and its own
Postgres.  Each belt therefore gets its own Hasura instance tracking that
Postgres.

**The problem**: all six `schema.graphql` files are identical — the entity names
(`TrackedErc721`, `TrackedHolder`, `Token`, `TrackedErc1155`, …) collide across
chains.  Stitching six Hasura instances directly into one GraphQL namespace
without prefixing produces type-name conflicts that Hasura will refuse at
registration time.  A chain-scoped namespace prefix is therefore **mandatory,
not optional** (SDD §2.1, `sdd.md:62-65`).

The solution is a **federation Hasura** that holds no Postgres of its own.  It
is a pure stitch layer: it registers each per-chain Hasura as a Hasura *remote
schema* under a chain-scoped namespace prefix.  Consumers continue to query
one endpoint; the federation Hasura routes each field to the correct per-chain
Hasura at runtime.

---

## 2. Topology

```
                       ┌─────────────────────────────────────────────────────┐
                       │           Caddy belt-gateway (Railway)              │
                       │  sonar.0xhoneyjar.xyz/v1/graphql                   │
                       │                                                     │
                       │  @kitchen /v1/collections/*  → $KITCHEN_UPSTREAM   │
                       │  default                      → $BELT_UPSTREAM      │
                       └──────────────────────────┬──────────────────────────┘
                                                  │  $BELT_UPSTREAM
                                                  ▼
                       ┌─────────────────────────────────────────────────────┐
                       │         federation-hasura  (no Postgres)            │
                       │   remote schemas (chain-scoped namespace prefixes)  │
                       └──┬────────┬────────┬────────┬────────┬─────────────┘
                          │        │        │        │        │
                    ns:eth│  ns:arb│  ns:op│  ns:base│  ns:zora│  ns:bera
                          ▼        ▼        ▼        ▼        ▼
                    hasura-eth  hasura-arb hasura-op hasura-base hasura-zora  hasura-bera
                          │        │        │        │        │        │
                    Postgres  Postgres Postgres Postgres Postgres Postgres
                    (belt-eth) (arb)   (op)    (base)   (zora)   (bera)
                          │        │        │        │        │        │
                    Envio   Envio   Envio   Envio   Envio   Envio
                    belt-eth belt-arb belt-op belt-base belt-zora belt-bera
```

**Key invariants from this diagram:**

- The federation Hasura has **no Postgres of its own**.  It is purely a
  GraphQL-over-GraphQL stitch layer.  All data lives in the six per-chain
  Postgres instances (SDD §2.1, `sdd.md:60-65`).
- The public alias `sonar.0xhoneyjar.xyz/v1/graphql` does not change.  The
  Caddy gateway continues to forward the default route to `$BELT_UPSTREAM`
  (`Caddyfile:50-52`).  Only the *value* of `$BELT_UPSTREAM` changes — from a
  single-chain Hasura to the federation Hasura.
- `$BELT_UPSTREAM` is written **exclusively by `scripts/promote.sh`**
  (`Caddyfile:47-48`, SDD §2.2, `sdd.md:76-82`).  Do not hand-edit the
  Caddyfile or set this variable through the Railway UI outside of `promote.sh`.

---

## 3. The six per-chain Hasura instances

Each per-chain Hasura (`belt-hasura-{chain}`) is a standard Hasura deployment
that tracks a single Postgres database.  The Railway service topology is
(`sdd.md:170-172`):

```
belt-{chain}        — Envio HyperIndex process (BELT_CONFIG=config.<chain_id>.yaml)
Postgres-{chain}    — dedicated Postgres for that chain's indexed data
belt-hasura-{chain} — Hasura tracking Postgres-{chain}
```

The six pairs:

| Railway service       | Postgres        | Chain ID | BELT_CONFIG          |
|-----------------------|-----------------|----------|----------------------|
| `belt-eth`            | `Postgres-eth`  | 1        | `config.1.yaml`      |
| `belt-arb`            | `Postgres-arb`  | 42161    | `config.42161.yaml`  |
| `belt-zora`           | `Postgres-zora` | 7777777  | `config.7777777.yaml`|
| `belt-op`             | `Postgres-op`   | 10       | `config.10.yaml`     |
| `belt-base`           | `Postgres-base` | 8453     | `config.8453.yaml`   |
| `belt-bera`           | `Postgres-bera` | 80094    | `config.80094.yaml`  |

`BELT_CONFIG` is the single per-chain knob.  It is set as a Railway build arg
(for `pnpm envio codegen`) and a Railway service env var (for the runtime CMD).
The `Dockerfile.belt` threads it through unchanged — no Dockerfile modification
is required (`Dockerfile.belt:30-31`, `Dockerfile.belt:42`, `Dockerfile.belt:61`).

---

## 4. Namespace requirement for remote-schema registration

All six `schema.graphql` files export identical top-level type names
(`TrackedErc721`, `TrackedHolder`, `Token`, `TrackedErc1155`, …).  Hasura
remote-schema stitching is additive within one GraphQL namespace, so duplicate
type names across remotes are a hard error.

Each remote schema **must** be registered with a unique `customization.root_fields_namespace`
(and, if using Apollo Federation style, `customization.type_prefix`) so that
the federation Hasura rewrites the merged schema to:

```
eth_TrackedErc721   arb_TrackedErc721   op_TrackedErc721
eth_TrackedHolder   arb_TrackedHolder   op_TrackedHolder
…
```

Recommended namespace values:

| Per-chain Hasura | namespace prefix |
|------------------|-----------------|
| `hasura-eth`     | `eth`           |
| `hasura-arb`     | `arb`           |
| `hasura-zora`    | `zora`          |
| `hasura-op`      | `op`            |
| `hasura-base`    | `base`          |
| `hasura-bera`    | `bera`          |

These match the Railway service naming convention and are consistent with the
`belt-{chain}` suffix pattern used throughout the codebase.

---

## 5. Caddy gateway — what changes and what does not

### What does not change

- The public URL `sonar.0xhoneyjar.xyz/v1/graphql` is unchanged.
- The Kitchen route is unchanged: `@kitchen path /v1/collections/*` proxies to
  `$KITCHEN_UPSTREAM` (`Caddyfile:40-45`).  The Kitchen API routes incoming
  requests to the correct per-chain belt internally using the `chain_id`
  extracted from the request path (SDD §6, `sdd.md:161-164`).
- The rate-limit (120 req/min/IP) and 50KB body cap (`Caddyfile:29-37`) are
  chain-agnostic and carry forward without modification.
- The Caddyfile itself requires **no structural change** for D4.

### What changes

The only mutation is the *value* of `$BELT_UPSTREAM` — it flips from a
single-chain `belt-hasura` URL to the `federation-hasura` URL.  This is
performed by `scripts/promote.sh` after the promotion gate passes
(`Caddyfile:47-48`, SDD §2.3, `sdd.md:84-94`).

The Caddyfile already anticipates this (`Caddyfile:48-49`):

```
# Federation-ready: a 2nd belt is an additive route here; the public URL is unchanged.
```

No operator action on the Caddyfile is needed.

---

## 6. Blast-radius before and after D4

### Today (6-chain monolith)

Adding or re-scanning a single contract requires setting `ENVIO_RESTART=1` on
the single belt service.  The `CMD` in `Dockerfile.belt:57-61` passes
`--restart` to `pnpm envio start`, which wipes **all chain state** and
re-syncs all 6 chains from their `start_block` values:

```dockerfile
# Dockerfile.belt:57-61
CMD ["sh", "-c", "if [ \"$ENVIO_RESTART\" = \"1\" ]; then \
  exec pnpm envio start --config \"$BELT_CONFIG\" --restart; \
  else exec pnpm envio start --config \"$BELT_CONFIG\"; fi"]
```

A restart on the 6-chain belt wipes Ethereum, Arbitrum, Zora, Optimism, Base,
and Berachain simultaneously — all 6 chains re-scan from genesis (PRD G-2
pre-state: blast radius = 6).

### After D4 (per-chain split)

Each per-chain belt service is independent.  Setting `ENVIO_RESTART=1` on
`belt-eth` restarts the Ethereum indexer only.  The other five belts
(`belt-arb`, `belt-zora`, `belt-op`, `belt-base`, `belt-bera`) continue serving
through the federation stitch without interruption (PRD G-2 post-state:
blast radius = 1).

The five unaffected belts remain behind the federation Hasura, so consumers
querying `eth_TrackedErc721` during an ETH restart will see the query fail (or
the federation Hasura return an error for the `eth` remote) while
`arb_TrackedErc721`, `bera_TrackedErc721`, etc. continue to resolve normally.

---

## 7. Step-by-step: adding a new chain belt to the stitch

Adding a seventh chain (or re-registering after a rebuild) is purely additive —
no public-URL change, no gateway Caddyfile edit, no `promote.sh` invocation
unless flipping the primary alias.

1. **Deploy the new belt services** on Railway: `belt-{chain}`,
   `Postgres-{chain}`, `belt-hasura-{chain}`.  Set `BELT_CONFIG=config.<id>.yaml`
   as both a Railway build arg and a service env var.

2. **Verify the per-chain Hasura** is reachable at its Railway-internal URL
   and has tracked the Postgres tables (`TrackedErc721`, `TrackedHolder`, etc.).
   The Hasura service must be live before registration — a missing Hasura at
   deploy time will cause the federation Hasura's remote-schema fetch to fail
   (KF-016, `known-failures.md:969`).

3. **Register the remote schema on the federation Hasura** via the Hasura
   console or Hasura Metadata API (`/v1/metadata`, action `add_remote_schema`).
   Provide:
   - `name`: a stable identifier (e.g., `belt-eth`)
   - `definition.url`: the per-chain Hasura GraphQL URL
   - `definition.customization.root_fields_namespace`: the chain prefix (e.g., `eth`)
   - `definition.customization.type_names.prefix`: same prefix (e.g., `eth_`)

   No Hasura config keys are invented here — these are the standard Hasura
   remote-schema `add_remote_schema` payload fields documented in the Hasura
   Metadata API.

4. **Reload federation Hasura metadata** (automatic on `add_remote_schema`;
   verify with `GET /healthz` returning `{"status":"OK"}`).

5. **Smoke test** the federation endpoint with a query scoped to the new
   namespace:

   ```graphql
   query {
     eth_TrackedErc721(limit: 1) { id token_id contract_address }
   }
   ```

6. **No public-URL change required.**  If this is the initial D4 cutover from
   the monolith, run `scripts/promote.sh` to flip `$BELT_UPSTREAM` from the
   old single-chain Hasura to the new federation Hasura endpoint (SDD §7.4,
   `sdd.md:174-197`).  For subsequent chain additions, the federation Hasura
   URL in `$BELT_UPSTREAM` is already correct — no `promote.sh` invocation
   is needed.

---

## 8. `NODE_OPTIONS` per chain

`Dockerfile.belt:51` bakes `NODE_OPTIONS=--max-old-space-size=12288` (12 GB,
sized for a 24 GB / 6-chain box).  Each single-chain belt runs in a smaller
Railway container and **must override this value** via a Railway service env
var (`Dockerfile.belt:49-50` shortcut note, KF-015, `known-failures.md:938-960`):

| Belt service | Chain density | Recommended ceiling |
|--------------|---------------|---------------------|
| `belt-bera`  | 28 contracts  | 8 000 – 12 000 MB   |
| `belt-eth`   | 8 contracts   | 4 000 MB            |
| `belt-op`    | 5 contracts   | 2 000 – 4 000 MB    |
| `belt-base`  | 5 contracts   | 2 000 – 4 000 MB    |
| `belt-arb`   | 1 contract    | 2 048 MB (default)  |
| `belt-zora`  | 1 contract    | 2 048 MB (default)  |

The KF-015 OOM that plagued the 6-chain monolith is structurally eliminated by
D4: a single-chain process never runs the concurrent multi-chain fetcher load
that exhausted the heap (`known-failures.md:938-946`).

---

## 9. References

| Citation | Location |
|----------|----------|
| SDD §2.1 per-chain belt split + remote-schema stitch | `sdd.md:60-65` |
| SDD §2.2 gateway + stable alias | `sdd.md:76-82` |
| SDD §2.3 promote.sh sole writer | `sdd.md:84-94` |
| SDD §6 API contracts (Kitchen chain routing) | `sdd.md:161-164` |
| SDD §7 Railway service topology | `sdd.md:170-172` |
| SDD §7.4 zero-downtime cutover | `sdd.md:174-197` |
| Caddyfile default upstream ($BELT_UPSTREAM) | `Caddyfile:50-52` |
| Caddyfile federation-ready comment | `Caddyfile:48-49` |
| Caddyfile Kitchen route | `Caddyfile:40-45` |
| Dockerfile.belt BELT_CONFIG ARG/ENV/CMD | `Dockerfile.belt:30-31,42,61` |
| Dockerfile.belt ENVIO_RESTART blast-radius | `Dockerfile.belt:57-61` |
| Dockerfile.belt NODE_OPTIONS bake + per-chain note | `Dockerfile.belt:44-51` |
| KF-015 OOM root cause + resolution | `known-failures.md:938-960` |
| KF-016 Hasura must be live at deploy | `known-failures.md:969` |
