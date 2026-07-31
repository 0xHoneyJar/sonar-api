/*
 * src/EventHandlers.ts — Envio handler entry point for config.yaml.
 *
 * One handler per lane:
 *   TrackedErc721.Transfer                        → holders
 *   TrackedErc1155.TransferSingle/TransferBatch   → per-tokenId balances
 *   TrackedErc20.Transfer                         → token balances
 *   Seaport.OrderFulfilled                        → sales
 *
 * SHAPE — side-effect imports, NOT named imports: in Envio 3.2.1 a handler
 * self-registers as a module-load side effect (`indexer.onEvent(...)`), so
 * importing the module for its side effect performs the registration.
 *
 * All four are imported unconditionally, including lanes with no registered
 * contracts yet. gen-config.ts declares every lane in the top-level `contracts:`
 * block for exactly this reason — an onEvent call site with no matching config
 * pair is an orphan that never fires, and check-onevent-bijection.mjs fails it.
 * A lane with no addresses indexes nothing and costs nothing.
 */

import "./handlers/tracked-erc721";
import "./handlers/tracked-erc1155";
import "./handlers/tracked-erc20";
import "./handlers/seaport";
