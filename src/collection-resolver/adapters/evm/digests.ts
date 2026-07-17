/**
 * Digest helpers for probe binding evidence.
 * Digests are sha-256 hex (64 lowercase chars) — never raw bytecode in evidence.
 */
import { createHash } from "node:crypto";

const strip0x = (hex: string): string =>
  hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;

export const sha256HexBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const sha256HexUtf8 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const isValidBytecodeHex = (bytecode: string): boolean => {
  const body = strip0x(bytecode);
  return body.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(body);
};

/** Digest of contract bytecode for code_digest binding. */
export const codeDigestFromBytecode = (bytecode: `0x${string}` | string): string => {
  const body = strip0x(bytecode);
  if (!isValidBytecodeHex(bytecode)) {
    throw new TypeError("bytecode must be even-length hexadecimal data");
  }
  const bytes = Uint8Array.from(Buffer.from(body.length === 0 ? "" : body, "hex"));
  return sha256HexBytes(bytes);
};

/**
 * Account-content digest for EVM contracts: bind address + code digest so
 * identity drift is observable without storing bytecode.
 */
export const accountDigestFromAddressAndCode = (
  normalizedAddress: `0x${string}`,
  codeDigest: string,
): string => sha256HexUtf8(`${normalizedAddress.toLowerCase()}:${codeDigest}`);

/** Normalize a 32-byte hash (block / storage) to 64 lowercase hex chars. */
export const digest32FromHex = (hex: `0x${string}` | string): string | undefined => {
  const body = strip0x(hex).toLowerCase();
  if (body.length !== 64 || !/^[0-9a-f]{64}$/.test(body)) return undefined;
  return body;
};
