/*
 * Mibera belt — Envio handler registration entrypoint (Deployment #1).
 *
 * Lives in its own directory because Envio's HandlerLoader.registerAllHandlers
 * (node_modules/envio/src/HandlerLoader.res.mjs) ALWAYS runs
 * autoLoadFromSrcHandlers(config.handlers) — it globs `<handlers>/**\/*.{js,mjs,ts}`
 * and imports every match, independent of any per-contract `handler:` field. The
 * top-level `handlers` config key defaults to `src/handlers`. config.mibera.yaml
 * sets `handlers: src/belts/mibera`, so the autoload glob matches ONLY this file —
 * a scoped `envio codegen --config config.mibera.yaml` build never imports the
 * other contracts' handler modules (review finding DISS-001).
 *
 * Importing the two Mibera handler modules below runs their registration calls —
 * each exported const is a `MiberaLiquidBacking.<Event>.handler(...)` /
 * `MiberaCollection.Transfer.handler(...)` expression. Their transitive imports
 * are belt-safe: the only `generated` value imports are MiberaLiquidBacking /
 * MiberaCollection (both in the belt config); lib/actions uses a type-only
 * `generated` import; lib/mint-detection + handlers/constants import nothing from
 * `generated`. Handler *logic* (src/handlers/mibera-*.ts) is reused unchanged
 * (SDD §3.2). Per-belt entrypoint directories are the factory-model norm —
 * HoneyJar/Purupuru/Sprawl belts will each get a src/belts/<belt>/ directory.
 */

// Mibera Liquid Backing handlers (loans, RFV, defaulted NFT marketplace)
import {
  handleLoanReceived,
  handleBackingLoanPayedBack,
  handleBackingLoanExpired,
  handleItemLoaned,
  handleLoanItemSentBack,
  handleItemLoanExpired,
  handleItemPurchased,
  handleItemRedeemed,
  handleRFVChanged,
} from "../../handlers/mibera-liquid-backing";

// Mibera Collection handlers (transfer/mint/burn tracking)
import { handleMiberaCollectionTransfer } from "../../handlers/mibera-collection";

// ── Mibera ecosystem handlers (Berachain) — extends the belt to the full ecosystem
// footprint score-api consumes. Importing each module runs its registration calls; each
// module's only `generated` value-imports are its own belt-config contract(s) + schema
// entities (DISS-001-safe — verified). See grimoires/loa/context/mibera-sovereign-indexer-experiment.md.
import { handlePaddleMint, handlePaddlePawn, handlePaddleLiquidateBorrow } from "../../handlers/paddlefi";
import { handleBgtQueueBoost } from "../../handlers/bgt";
import { handleCubBadgesTransferSingle, handleCubBadgesTransferBatch } from "../../handlers/badges1155";
import { handleCandiesMintSingle, handleCandiesMintBatch } from "../../handlers/mints1155";
import { handleGeneralMintTransfer } from "../../handlers/mints";
import { handleVmMinted } from "../../handlers/vm-minted";
import { handleTrackedErc721Transfer } from "../../handlers/tracked-erc721";
import { handleSeaportOrderFulfilled } from "../../handlers/seaport"; // Berachain: Mibera secondary sales → MintActivity SALE/PURCHASE (filtered to Mibera)

// ── Mibera ecosystem handlers (Base / Optimism / Ethereum) — multi-chain extension.
// Same DISS-001 boundary: each module's only `generated` value-imports are its own
// belt-config contract(s) + schema entities. Contract defs are in config.mibera.yaml.
import { handleFriendtechTrade } from "../../handlers/friendtech"; // Base: FriendtechShares
import { handleTrackedErc20Transfer } from "../../handlers/tracked-erc20"; // Base: TrackedErc20 (MiberaMaker333)
import { handleMiberaSetsSingle, handleMiberaSetsBatch } from "../../handlers/mibera-sets"; // OP: MiberaSets
import { handleMiberaZoraSingle, handleMiberaZoraBatch } from "../../handlers/mibera-zora"; // OP: MiberaZora1155
import { handleWritingEditionPurchased } from "../../handlers/mirror-observability"; // OP: MirrorObservability
import { handleMiladyCollectionTransfer } from "../../handlers/milady-collection"; // ETH: MiladyCollection

// Re-export the handler consts so the imports above are "used" — registration is
// the side-effect of importing the modules. Mirrors src/EventHandlers.ts.
export {
  handleLoanReceived,
  handleBackingLoanPayedBack,
  handleBackingLoanExpired,
  handleItemLoaned,
  handleLoanItemSentBack,
  handleItemLoanExpired,
  handleItemPurchased,
  handleItemRedeemed,
  handleRFVChanged,
  handleMiberaCollectionTransfer,
  handlePaddleMint,
  handlePaddlePawn,
  handlePaddleLiquidateBorrow,
  handleBgtQueueBoost,
  handleCubBadgesTransferSingle,
  handleCubBadgesTransferBatch,
  handleCandiesMintSingle,
  handleCandiesMintBatch,
  handleGeneralMintTransfer,
  handleVmMinted,
  handleTrackedErc721Transfer,
  handleSeaportOrderFulfilled,
  handleFriendtechTrade,
  handleTrackedErc20Transfer,
  handleMiberaSetsSingle,
  handleMiberaSetsBatch,
  handleMiberaZoraSingle,
  handleMiberaZoraBatch,
  handleWritingEditionPurchased,
  handleMiladyCollectionTransfer,
};
