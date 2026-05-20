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
};
