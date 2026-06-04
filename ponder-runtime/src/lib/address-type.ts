// ponder-runtime/src/lib/address-type.ts
//
// Pure helpers for address-type classification (sonar-api#63). The testable core
// of "is this address a human EOA or a contract" — read from the indexer as a
// fact so score-api's sybil / wash-trading filter doesn't have to reconstruct it.
//
// The DB glue (touch-address.ts enqueue + address-resolve.ts block-handler that
// calls eth_getCode) stays out of this module so the classification logic is
// unit-testable without the ponder runtime. See sonar-api#63.

export type AddressTypeValue = "pending" | "eoa" | "contract" | "delegated_eoa";

/**
 * Composite primary key for a per-(chain, address) classification row.
 * Mirrors the repo's `{chainId}_{address}` id convention (e.g. TrackedHolder).
 * Address lowercased so the key is stable regardless of caller hygiene.
 */
export function addressTypeId(chainId: number, address: string): string {
  return `${chainId}_${address.toLowerCase()}`;
}

// EIP-7702 delegation designator: an EOA that has set code delegates to a
// contract via the EXACT 23-byte designator `0xef0100 || delegate` (3-byte magic
// prefix + 20-byte delegate address). Such an account is STILL a human-controlled
// EOA (MetaMask smart accounts, batchers) and MUST NOT be filtered as a contract.
// The issue notes 7 of 9 has-code wallets in their top-30 were these — a naive
// `code != 0x` ban would wrongly remove real holders.
//
// We require the EXACT length: EIP-3541 forbids any deployed contract code from
// starting with 0xef, so in practice only the well-formed 7702 designator can
// appear with this prefix — but we still classify a malformed/overlong 0xef…
// blob as `contract` (conservative: never mark an unknown 0xef shape as human).
// Exact EIP-7702 designator: 0xef0100 (3-byte magic) + a valid 20-byte (40-hex)
// delegate address, and nothing more. The hex-class + exact-length anchors reject
// malformed/overlong/non-hex blobs (those fall through to `contract`).
const EIP7702_DESIGNATOR_RE = /^0xef0100[0-9a-f]{40}$/;

/**
 * Classify an eth_getCode result.
 *   - undefined / null / "0x" / ""              → eoa (no code)
 *   - exact 0xef0100 + valid 20-byte delegate   → delegated_eoa (EIP-7702 — still human)
 *   - any other non-empty bytecode              → contract
 */
export function classifyCode(
  code: string | undefined | null,
): "eoa" | "contract" | "delegated_eoa" {
  if (code === undefined || code === null) return "eoa";
  const c = code.toLowerCase();
  if (c === "0x" || c === "") return "eoa";
  if (EIP7702_DESIGNATOR_RE.test(c)) return "delegated_eoa";
  return "contract";
}

/**
 * Whether a resolved type can still flip and therefore warrants a re-check.
 * Only `eoa` can: a counterfactual ERC-4337 smart wallet (common on Base) can
 * receive tokens BEFORE deployment — empty code at first sight, then `contract`
 * once deployed. `contract` is terminal; `delegated_eoa` stays human even if the
 * 7702 delegation target changes, so for the consumer's filter it is terminal too.
 */
export function needsRecheck(
  type: "eoa" | "contract" | "delegated_eoa",
): boolean {
  return type === "eoa";
}
