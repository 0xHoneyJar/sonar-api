// Hot-path enqueue for address-type classification (sonar-api#63).

import type { EvmOnEventContext } from "envio";

import { addressTypeId } from "./address-type";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export async function touchAddress(
  context: EvmOnEventContext,
  chainId: number,
  address: string,
): Promise<void> {
  const addr = address.toLowerCase();
  if (addr === ZERO_ADDRESS) return;

  const id = addressTypeId(chainId, addr);
  const existing = await context.AddressType.get(id);
  if (existing) return;

  context.AddressType.set({
    id,
    chainId,
    address: addr,
    type: "pending",
    resolvedAtBlock: undefined,
    lastResolved: undefined,
    recheckAfter: undefined,
  });
}
