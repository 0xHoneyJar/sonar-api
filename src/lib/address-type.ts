// Address-type classification helpers (sonar-api#63).
// Pure core ported from ponder-runtime; resolver glue in address-resolve.ts.

export type AddressTypeValue = "pending" | "eoa" | "contract" | "delegated_eoa";

export function addressTypeId(chainId: number, address: string): string {
  return `${chainId}_${address.toLowerCase()}`;
}

const EIP7702_DESIGNATOR_RE = /^0xef0100[0-9a-f]{40}$/;

export function classifyCode(
  code: string | undefined | null,
): "eoa" | "contract" | "delegated_eoa" {
  if (code === undefined || code === null) return "eoa";
  const c = code.toLowerCase();
  if (c === "0x" || c === "") return "eoa";
  if (EIP7702_DESIGNATOR_RE.test(c)) return "delegated_eoa";
  return "contract";
}

export function needsRecheck(
  type: "eoa" | "contract" | "delegated_eoa",
): boolean {
  // eoa: counterfactual ERC-4337 deploy may flip empty→contract.
  // delegated_eoa: EIP-7702 revocation may flip delegated→plain EOA.
  return type === "eoa" || type === "delegated_eoa";
}
