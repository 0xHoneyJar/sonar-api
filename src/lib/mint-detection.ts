/*
 * Address semantics shared by both handlers: what counts as a mint, and what
 * counts as a burn.
 */

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Burn destination many projects use alongside the zero address. */
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";

/** A transfer out of the zero address is a mint. */
export function isMintFromZero(fromAddress: string): boolean {
  return fromAddress.toLowerCase() === ZERO_ADDRESS;
}

/** True for the zero address and the conventional dead address. */
export function isBurnAddress(address: string): boolean {
  const lower = address.toLowerCase();
  return lower === ZERO_ADDRESS || lower === DEAD_ADDRESS;
}
