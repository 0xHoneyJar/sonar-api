/*
 * src/EventHandlers.ts — Envio handler entry point for config.yaml.
 *
 * Two handlers, because config.yaml binds two contracts (bd-dwq5.3):
 *   TrackedErc721.Transfer   → holders
 *   Seaport.OrderFulfilled   → sales
 *
 * SHAPE — side-effect imports, NOT named imports: in Envio 3.2.1 a handler
 * self-registers as a module-load side effect (`indexer.onEvent(...)`), so
 * importing the module for its side effect performs the registration.
 *
 * The ~20 off-path handlers (vaults, staking, BGT, badges, mints, friendtech,
 * paddlefi, aquabera, fatbera, henlo, moneycomb, crayons, milady, honey-jar,
 * mibera-*) were deleted here, not disabled — git history is the archive.
 */

import "./handlers/tracked-erc721";
import "./handlers/seaport";
