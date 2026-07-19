/**
 * Robinhood HyperIndex sidecar — handler registration entrypoint.
 *
 * `config.robinhood-sidecar.yaml` sets `handlers: src/sidecars/robinhood` so
 * Envio's autoload glob only picks up this file (mibera / DISS-001 pattern).
 *
 * Ownership logic reuses `handleTrackedErc721Transfer`. Importing that module
 * also registers EthTrackedErc721 (monobelt #120 fix) — harmless if absent
 * from this config; do not add EthTrackedErc721 addresses here.
 *
 * Canary audit entity (optional): see robinhood-sidecar-canary.md.
 */

import { handleTrackedErc721Transfer } from "../../handlers/tracked-erc721";

export { handleTrackedErc721Transfer };
