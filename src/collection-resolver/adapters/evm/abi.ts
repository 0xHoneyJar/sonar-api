/**
 * Minimal ABI encode/decode for ERC-165 / name / symbol / contractURI.
 * No full ABI library surface — selectors and ABI encoding only.
 */
import {
  INTERFACE_ID_ERC1155,
  INTERFACE_ID_ERC721,
  MAX_CONTRACT_URI_CHARS,
  MAX_ONCHAIN_STRING_CHARS,
  SELECTOR_CONTRACT_URI,
  SELECTOR_NAME,
  SELECTOR_SUPPORTS_INTERFACE,
  SELECTOR_SYMBOL,
} from "./constants.js";

const strip0x = (hex: string): string =>
  hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;

/** Encode supportsInterface(bytes4); fixed-size bytes are ABI right-padded. */
export const encodeSupportsInterface = (interfaceId: `0x${string}`): `0x${string}` => {
  const id = strip0x(interfaceId).toLowerCase().padEnd(64, "0");
  return `${SELECTOR_SUPPORTS_INTERFACE}${id}` as `0x${string}`;
};

export const encodeNameCall = (): `0x${string}` => SELECTOR_NAME;
export const encodeSymbolCall = (): `0x${string}` => SELECTOR_SYMBOL;
export const encodeContractUriCall = (): `0x${string}` => SELECTOR_CONTRACT_URI;

export const ERC721_SUPPORTS_CALLDATA = encodeSupportsInterface(INTERFACE_ID_ERC721);
export const ERC1155_SUPPORTS_CALLDATA = encodeSupportsInterface(INTERFACE_ID_ERC1155);

/**
 * Decode ABI bool from eth_call success data. Malformed → undefined (absent).
 */
export const decodeAbiBool = (data: `0x${string}`): boolean | undefined => {
  const body = strip0x(data);
  if (body.length < 64) return undefined;
  const word = body.slice(0, 64).toLowerCase();
  if (word === "0".repeat(64)) return false;
  if (word === `${"0".repeat(63)}1`) return true;
  return undefined;
};

/**
 * Decode ABI string (dynamic). Returns undefined on malformed / empty.
 * Truncates to maxChars.
 */
export const decodeAbiString = (
  data: `0x${string}`,
  maxChars: number,
): string | undefined => {
  const body = strip0x(data).toLowerCase();
  if (body.length < 128) return undefined;
  if (!/^[0-9a-f]+$/.test(body)) return undefined;

  try {
    const offset = Number(BigInt(`0x${body.slice(0, 64)}`));
    if (!Number.isFinite(offset) || offset < 32) return undefined;
    const offsetHex = offset * 2;
    if (body.length < offsetHex + 64) return undefined;
    const length = Number(BigInt(`0x${body.slice(offsetHex, offsetHex + 64)}`));
    if (!Number.isFinite(length) || length < 0 || length > maxChars * 4) return undefined;
    const dataStart = offsetHex + 64;
    const hexLen = length * 2;
    if (body.length < dataStart + hexLen) return undefined;
    const bytes = Buffer.from(body.slice(dataStart, dataStart + hexLen), "hex");
    const text = bytes.toString("utf8").replace(/\u0000/g, "").trim();
    if (text.length === 0) return undefined;
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  } catch {
    return undefined;
  }
};

export const decodeBoundedName = (data: `0x${string}`): string | undefined =>
  decodeAbiString(data, MAX_ONCHAIN_STRING_CHARS);

export const decodeBoundedSymbol = (data: `0x${string}`): string | undefined =>
  decodeAbiString(data, MAX_ONCHAIN_STRING_CHARS);

export const decodeBoundedContractUri = (data: `0x${string}`): string | undefined =>
  decodeAbiString(data, MAX_CONTRACT_URI_CHARS);

/** Extract 20-byte address from a 32-byte storage word. */
export const addressFromStorageWord = (
  word: `0x${string}`,
): `0x${string}` | undefined => {
  const body = strip0x(word).toLowerCase();
  if (body.length !== 64 || !/^[0-9a-f]+$/.test(body)) return undefined;
  const addr = `0x${body.slice(24)}` as `0x${string}`;
  if (addr === "0x0000000000000000000000000000000000000000") return undefined;
  return addr;
};

/** True when a 32-byte storage word is all zeros (no EIP-1967 implementation). */
export const isZeroStorageWord = (word: `0x${string}`): boolean => {
  const body = strip0x(word).toLowerCase();
  return body.length === 64 && /^0+$/.test(body);
};

export const isValidStorageWord = (word: string): boolean => {
  const body = strip0x(word);
  return body.length === 64 && /^[0-9a-fA-F]{64}$/.test(body);
};

export const isEmptyBytecode = (code: string): boolean => {
  const body = strip0x(code);
  return body.length === 0 || /^0*$/.test(body);
};
