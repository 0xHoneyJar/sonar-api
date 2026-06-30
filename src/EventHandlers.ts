/*
 * src/EventHandlers.ts — Green belt (config.yaml) Envio handler entry point.
 *
 * Restored 2026-06-29 (bd-z5sw). The original was DELETED at #75 (9cf7152f)
 * during the Envio 3.2.1 port: that change repointed config.mibera.yaml's
 * `handlers:` key but left config.yaml's `handler: src/EventHandlers.ts`
 * references dangling, breaking `envio codegen --config config.yaml` (and the
 * default `pnpm start`) — the live belt-indexer-selfhost service runs this
 * config, so the next redeploy from HEAD would fail. See
 * test/green-belt-handler-resolves.test.ts.
 *
 * SHAPE — side-effect imports, NOT named imports:
 *   In Envio 3.2.1 a handler self-registers as a module-load side effect
 *   (`indexer.onEvent(...)` / `indexer.contractRegister(...)`). Importing each
 *   module for its side effect runs that registration. We deliberately do NOT
 *   re-import named symbols the way the deleted file did — #75 renamed several
 *   exports (e.g. honey-jar-nfts `handleHoneyJarTransfer` → `handleTransfer`)
 *   and made others self-register inline, so named imports would break `tsc`.
 *   Side-effect imports are rename-proof and trigger the same registration.
 *   This mirrors src/belts/mibera/EventHandlers.mibera.ts (the already-ported
 *   blue belt). Envio also autoloads `src/handlers/**` for config.yaml (the
 *   default `handlers:` dir), so registration is doubly covered; this file
 *   exists so the per-contract `handler:` path resolves at codegen time.
 *
 * SCOPE: this is the FULL green belt — it imports every src/handlers/* module.
 * Scoped single-belt builds use their own entry (e.g. config.mibera.yaml →
 * src/belts/mibera). Keep this list in sync with src/handlers/*.ts.
 */

import "./handlers/apdao-auction";
import "./handlers/aquabera-vault-direct";
import "./handlers/aquabera-wall";
import "./handlers/badges1155";
import "./handlers/bgt";
// constants.ts is intentionally NOT imported here: it is shared config, not a
// handler — it registers nothing. The handlers that need it pull it in
// transitively, and Envio's autoload of src/handlers/ loads it regardless.
import "./handlers/crayons";
import "./handlers/crayons-collections";
import "./handlers/fatbera";
import "./handlers/fatbera-core";
import "./handlers/friendtech";
import "./handlers/henlo-vault";
import "./handlers/honey-jar-nfts";
import "./handlers/mibera-collection";
import "./handlers/mibera-liquid-backing";
import "./handlers/mibera-premint";
import "./handlers/mibera-sets";
import "./handlers/mibera-staking";
import "./handlers/mibera-zora";
import "./handlers/milady-collection";
import "./handlers/mints";
import "./handlers/mints1155";
import "./handlers/mirror-observability";
import "./handlers/moneycomb-vault";
import "./handlers/paddlefi";
import "./handlers/puru-apiculture1155";
import "./handlers/seaport";
import "./handlers/sf-vaults";
import "./handlers/tracked-erc20";
import "./handlers/tracked-erc721";
import "./handlers/vm-minted";
