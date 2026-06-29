# ponder-runtime handler guidelines

Short rules for writing handlers that survive replay and reorg. The
`scripts/lint-handler-determinism.sh` sensor (run in `ponder-ci.yml`) enforces
the two that bit us hardest; this file is the *why* behind it.

## Determinism is the contract

Ponder re-executes handlers — on reorg, on restart, on a fresh reindex. The
indexed state it produces must be **identical** every time for the same blocks.
A value that differs between runs corrupts the table silently. Two ways that
sneaks in:

### 1. Never persist wall-clock time

```ts
// ✗ replay writes a different value
await context.db.update(t, { id }).set({ lastSeen: Date.now() });

// ✓ a block's timestamp is fixed forever
await context.db.update(t, { id }).set({ lastSeen: event.block.timestamp });
```

Use `event.block.timestamp` (seconds) or `event.block.number`. The one exception
in this repo is `outbox-flush.ts`, which records the *actual* NATS-publish time
(a side-effect, not consensus state) — the lint allowlists it.

### 2. Pin block-handler RPC reads to a block

In an **event** handler, a state read (`getCode`, `getBalance`, `readContract`,
…) defaults to the event's block — deterministic. In a **block** handler the
default can be `latest`, which moves between runs:

```ts
// ✗ inside a ":block" handler — reads latest, nondeterministic
const code = await context.client.getCode({ address });

// ✓ pin to the tick's block (it is recent — non-archive nodes still serve it)
const code = await context.client.getCode({ address, blockNumber: currentBlock });
```

This was the sonar-api#63 fix. If the read genuinely needs current head (e.g. a
caught-up gate), that's fine for **control flow** — just don't write its result
into an onchainTable.

## Where validation lives

- `ponder-ci.yml` — typecheck (`tsc -p ponder-runtime/tsconfig.json`), `vitest`,
  and the determinism lint. This is the production gate. Green means shippable.
- `belt-build.yml` — config-fidelity (Gate 1, live); the envio gates are retired.
- Handlers can't be unit-tested without the runtime, so extract pure logic into
  `src/lib/*` and `vitest` that (see `erc1155-holder.ts`, `address-type.ts`).
