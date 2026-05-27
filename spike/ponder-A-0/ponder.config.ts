// A-0 Verification Spike — Ponder 0.16.6
// Validates: T-A0.1 (exact pin), T-A0.2 (blocks: declaration + network-scoped
// block handler), T-A0.3 (Drizzle select.where), T-A0.4 (onConflict semantics),
// T-A0.6 (uint256 column type), T-A0.8 (eRPC transport — config-shaped for the
// railway-ssh runbook), T-A0.9 (deterministic outbox ID schema), T-A0.10
// (live-status from Ponder sync state).
import { createConfig } from "ponder";
import { ERC721TransferAbi } from "./abis/ERC721TransferAbi";

// ─── RPC selection ─────────────────────────────────────────────────────────
// Local-laptop verification: public RPC. Railway-ssh runbook (T-A0.8):
// PONDER_RPC_URL_1=http://erpc.railway.internal:4000/main/evm/1
const RPC_ETH = process.env.PONDER_RPC_URL_1 ?? "https://eth.merkle.io";

// Narrow tail-block window — completes in <2 minutes against a public RPC.
// MiladyCollection had heavy Transfer volume in this 1k-block range, so
// "T-A0.4 onConflict" and "T-A0.3 select-where" actually exercise real rows.
const START_BLOCK = 17_000_000;
const END_BLOCK = 17_001_000;

export default createConfig({
  chains: {
    mainnet: {
      id: 1,
      rpc: RPC_ETH,
    },
  },
  // SDD CORRECTION (see COOKBOOK §T-A0.2): the database config does NOT take
  // a `schema:` key in Ponder 0.16.6. The TypeScript shape is `{ kind:
  // "postgres", connectionString?, poolConfig? }`. Postgres schema namespace
  // is controlled via the env var `DATABASE_SCHEMA` (defaults to `public`),
  // or by passing `--schema <name>` to `ponder start`.
  database: {
    kind: "postgres",
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://ponder:ponder@127.0.0.1:5444/ponder",
  },
  contracts: {
    MiladyCollection: {
      chain: "mainnet",
      abi: ERC721TransferAbi,
      address: "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
    },
  },
  // T-A0.2: blocks: declaration is REQUIRED for any ponder.on(":block") handler
  // to fire. SDD §5.3 documents this — the spike validates it.
  //
  // CRITICAL FINDING (see COOKBOOK §T-A0.2): block-filter `startBlock` defaults
  // to 0 (chain genesis) and `interval: 1` means EVERY block fires the handler.
  // Without an explicit `startBlock`, cold sync indexes every block since the
  // chain began, which on Ethereum mainnet is ~25M blocks. SDD §5.3 omits
  // this. In production the outbox-flush block-filter MUST set startBlock to
  // match the contract's startBlock (or even slightly LATER — block-tick
  // doesn't need historical sweep; it's a real-time concern).
  blocks: {
    OutboxFlushEth: {
      chain: "mainnet",
      interval: 1,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
    },
  },
});
