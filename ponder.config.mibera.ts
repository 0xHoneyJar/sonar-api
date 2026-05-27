// Ponder config — Mibera blue belt (sonar-ponder-migration-v1 · sprint A-1)
//
// Scope: 3 chains (Ethereum 1, Base 8453, Berachain 80094) — matches SDD §1.1
// BLUE BELT diagram. Optimism (10) Mibera contracts (MiberaSets, MiberaZora1155,
// MirrorObservability, TrackedErc721 lore) are out of A-1 scope; the green belt
// (B-1) ports them.
//
// Source-of-truth: ./config.mibera.yaml — contract addresses + start_blocks
// + event signatures extracted VERBATIM. See ./abis/MiberaAbis.ts for the
// typed ABI surface.
//
// Conventions (all A-0 verified — see grimoires/loa/spikes/ponder-api-verification/COOKBOOK.md):
//   - C-1: `database.schema` is NOT a config key. Postgres schema namespace
//     is controlled via `DATABASE_SCHEMA=ponder` env var or `--schema ponder`
//     CLI flag. The belt-ponder container MUST set DATABASE_SCHEMA=ponder.
//   - C-2: `blocks.<name>` uses `chain:` (not `network:`).
//   - C-3: Block events keyed by block-filter name (`OutboxFlushEth:block`).
//   - D-1: Block-filter startBlock defaults to chain genesis. ALWAYS set
//     startBlock — for outbox-flush, set to the earliest Mibera contract's
//     startBlock on that chain (block-tick has no need for historical sweep;
//     outbox publish is a real-time concern, but pinning startBlock keeps
//     dev cold-sync windows sane).
//   - IMP-005: chains 1, 8453, 80094 carry per-chain RPC URL env vars.

import { createConfig } from "ponder";
import {
  MiberaLiquidBackingAbi,
  Erc721TransferAbi,
  PaddleFiAbi,
  BgtTokenAbi,
  Erc1155Abi,
  GeneralMintsAbi,
  SeaportAbi,
  FriendtechSharesAbi,
  Erc20TransferAbi,
} from "./abis/MiberaAbis";

// ─── Per-chain RPC URLs (eRPC internal Railway endpoints) ──────────────
// The belt-ponder Railway service MUST set:
//   PONDER_RPC_URL_1     = http://erpc.railway.internal:4000/main/evm/1
//   PONDER_RPC_URL_8453  = http://erpc.railway.internal:4000/main/evm/8453
//   PONDER_RPC_URL_80094 = http://erpc.railway.internal:4000/main/evm/80094
//
// Local fallback: public-RPC defaults so `pnpm ponder dev` works on a laptop
// without Railway access. NOT for production — eRPC is the canonical substrate.
const RPC_ETH  = process.env.PONDER_RPC_URL_1     ?? "https://eth.merkle.io";
const RPC_BASE = process.env.PONDER_RPC_URL_8453  ?? "https://mainnet.base.org";
const RPC_BERA = process.env.PONDER_RPC_URL_80094 ?? "https://rpc.berachain.com";

// ─── Berachain contract addresses (from config.mibera.yaml) ────────────
const MIBERA_LIQUID_BACKING       = "0xaa04F13994A7fCd86F3BbbF4054d239b88F2744d";
const MIBERA_COLLECTION           = "0x6666397dfe9a8c469bf65dc744cb1c733416c420";
const PADDLEFI_VAULT              = "0x242b7126F3c4E4F8CbD7f62571293e63E9b0a4E1";
const BGT_TOKEN                   = "0x656b95E550C07a9ffe548Bd4085c72418Ceb1dBa";
const CUB_BADGES_1155             = "0x574617ab9788e614b3eb3f7bd61334720d9e1aac";

const CANDIES_MARKET_1155 = [
  "0x80283fbF2b8E50f6Ddf9bfc4a90A8336Bc90E38F",       // mibera_drugs / mibera_candies
  "0xeca03517c5195f1edd634da6d690d6c72407c40c",       // mibera_drugs / mibera_candies (secondary)
] as const;

const GENERAL_MINTS = [
  "0x048327A187b944ddac61c6e202BfccD20d17c008",       // mibera_vm / mibera_shadows
  "0x230945E0Ed56EF4dE871a6c0695De265DE23D8D8",       // mibera_gif
] as const;

const TRACKED_ERC721_BERA = [
  "0x4B08a069381EfbB9f08C73D6B2e975C9BE3c4684",       // mibera_tarot / mibera_quiz
  "0x86Db98cf1b81E833447b12a077ac28c36b75c8E1",       // fracture #1: miparcels
  "0x8D4972bd5D2df474e71da6676a365fB549853991",       // fracture #2: miladies (Berachain)
  "0x144B27b1A267eE71989664b3907030Da84cc4754",       // fracture #3: mireveal_1_1
  "0x72DB992E18a1bf38111B1936DD723E82D0D96313",       // fracture #4: mireveal_2_2
  "0x3A00301B713be83EC54B7B4Fb0f86397d087E6d3",       // fracture #5: mireveal_3_3
  "0x419F25C4f9A9c730AAcf58b8401B5b3e566Fe886",       // fracture #6: mireveal_4_20
  "0x81A27117bd894942BA6737402fB9e57e942C6058",       // fracture #7: mireveal_5_5
  "0xaaB7b4502251aE393D0590bAB3e208E2d58F4813",       // fracture #8: mireveal_6_6
  "0xc64126EA8dC7626c16daA2A29D375C33fcaa4C7c",       // fracture #9: mireveal_7_7
  "0x24F4047d372139de8DACbe79e2fC576291Ec3ffc",       // fracture #10: mireveal_8_8
  "0xFc2D7eBFEB2714fCE13CaF234A95dB129ecC43Da",       // apdao_seat
] as const;

const SEAPORT_V16                 = "0x0000000000000068F116a894984e2DB1123eB395";

// ─── Base (8453) contract addresses ─────────────────────────────────────
const FRIENDTECH_SHARES           = "0xCF205808Ed36593aa40a44F10c7f7C2F67d4A4d4";
const MIBERA_MAKER_333_TOKEN      = "0x120756ccc6f0cefb43a753e1f2534377c2694bb4";

// ─── Ethereum (1) contract addresses ────────────────────────────────────
const MILADY_COLLECTION           = "0x5af0d9827e0c53e4799bb226655a1de152a425a5";

// ─── Per-chain start blocks (earliest Mibera-belt contract per chain) ───
// Pulled from config.mibera.yaml's chain-level start_block.
// Block-tick outbox handlers anchor at this floor — historical sweep before
// startBlock is unnecessary because the outbox-flush handler is a real-time
// concern (D-1 in the cookbook).
const BERA_START_BLOCK = 8221;          // BgtToken deployment (earliest contract on Bera)
const BASE_START_BLOCK = 2430439;       // FriendtechShares deployment
const ETH_START_BLOCK  = 13090020;      // Milady contract deployment

export default createConfig({
  chains: {
    ethereum:  { id: 1,     rpc: RPC_ETH  },
    base:      { id: 8453,  rpc: RPC_BASE },
    berachain: { id: 80094, rpc: RPC_BERA },
  },
  // SDD §3.1 + cookbook §C-1: NO `schema` key on database. Schema namespace
  // is controlled via DATABASE_SCHEMA env or --schema CLI. The belt-ponder
  // container MUST set DATABASE_SCHEMA=ponder.
  database: {
    kind: "postgres",
    connectionString: process.env.DATABASE_URL,
  },

  // ─── Contracts (Berachain 80094) ──────────────────────────────────────
  contracts: {
    MiberaLiquidBacking: {
      chain: "berachain",
      abi: MiberaLiquidBackingAbi,
      address: MIBERA_LIQUID_BACKING,
      startBlock: 3971122,
    },

    MiberaCollection: {
      chain: "berachain",
      abi: Erc721TransferAbi,
      address: MIBERA_COLLECTION,
      startBlock: 3837808,
    },

    PaddleFi: {
      chain: "berachain",
      abi: PaddleFiAbi,
      address: PADDLEFI_VAULT,
      startBlock: 5604652,
    },

    BgtToken: {
      chain: "berachain",
      abi: BgtTokenAbi,
      address: BGT_TOKEN,
      startBlock: 8221,
    },

    CubBadges1155: {
      chain: "berachain",
      abi: Erc1155Abi,
      address: CUB_BADGES_1155,
      startBlock: 1080991,
    },

    CandiesMarket1155: {
      chain: "berachain",
      abi: Erc1155Abi,
      // Ponder accepts an array of addresses for multi-deploy contracts.
      address: CANDIES_MARKET_1155,
      startBlock: 3716959,           // earliest of the two
    },

    GeneralMints: {
      chain: "berachain",
      abi: GeneralMintsAbi,
      address: GENERAL_MINTS,
      startBlock: 4130866,
    },

    TrackedErc721Bera: {
      chain: "berachain",
      abi: Erc721TransferAbi,
      address: TRACKED_ERC721_BERA,
      startBlock: 4029732,
    },

    Seaport: {
      chain: "berachain",
      abi: SeaportAbi,
      address: SEAPORT_V16,
      startBlock: 3837808,
    },

    // ─── Contracts (Base 8453) ─────────────────────────────────────────
    FriendtechShares: {
      chain: "base",
      abi: FriendtechSharesAbi,
      address: FRIENDTECH_SHARES,
      startBlock: BASE_START_BLOCK,
    },

    MiberaMaker333: {
      chain: "base",
      abi: Erc20TransferAbi,
      address: MIBERA_MAKER_333_TOKEN,
      startBlock: 33657372,
    },

    // ─── Contracts (Ethereum 1) ────────────────────────────────────────
    MiladyCollection: {
      chain: "ethereum",
      abi: Erc721TransferAbi,
      address: MILADY_COLLECTION,
      startBlock: ETH_START_BLOCK,
    },
  },

  // ─── Block-tick outbox flush (SDD §5.3 + cookbook §C-2/C-3/D-1) ──────
  // Required for the block-handler to fire. Without `blocks:` declared,
  // ponder.on("<name>:block", fn) never registers.
  // Property is `chain:` (not `network:`). startBlock is REQUIRED — without
  // it the block-tick fires from chain genesis (D-1 cold-sync footgun).
  blocks: {
    OutboxFlushEth: {
      chain: "ethereum",
      interval: 1,
      startBlock: ETH_START_BLOCK,
    },
    OutboxFlushBase: {
      chain: "base",
      interval: 1,
      startBlock: BASE_START_BLOCK,
    },
    OutboxFlushBera: {
      chain: "berachain",
      interval: 1,
      startBlock: BERA_START_BLOCK,
    },
  },
});
