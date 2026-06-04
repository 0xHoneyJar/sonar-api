// ponder-runtime/src/lib/touch-address.ts
//
// Hot-path enqueue for address-type classification (sonar-api#63). When a handler
// observes an address (a transfer from/to, a holder, an action actor), it calls
// touchAddress to record that we've SEEN it. This writes a cheap "pending" row;
// the actual eth_getCode classification happens off the hot path in the
// AddressResolve block-handler. No RPC here — keeping the per-event cost flat.
//
// Idempotent: onConflictDoNothing preserves an already-tracked row. Re-resolution
// of mutable cases (a counterfactual ERC-4337 wallet deploying empty→contract) is
// owned by the resolver, which keeps every eoa on a recurring re-check cadence —
// so a repeat sighting needs no special handling here.

import { addressType } from "../../ponder.schema";
import { addressTypeId } from "./address-type";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export async function touchAddress(
  context: any,
  chainId: number,
  address: string,
): Promise<void> {
  const addr = address.toLowerCase();
  if (addr === ZERO_ADDRESS) return;

  await context.db
    .insert(addressType)
    .values({
      id: addressTypeId(chainId, addr),
      chainId,
      address: addr as `0x${string}`,
      type: "pending",
      resolvedAtBlock: null,
      lastResolved: null,
      recheckAfter: null,
    })
    .onConflictDoNothing();
}
