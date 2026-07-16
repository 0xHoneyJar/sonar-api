/**
 * Canonical safe diagnostics for CR-103.
 *
 * Dependency-provided safe_message strings are never trusted verbatim.
 * Only locally owned SAFE_MESSAGES for known codes are emitted on ProbeUnavailable.
 */
import type { ProbeOutcome, ProbeTimeout, ProbeUnavailable } from "../../candidate.js";
import { SAFE_MESSAGES, type EvmRpcSafeErrorCode } from "./constants.js";
import type { EvmRpcFailure } from "./ports.js";

const KNOWN_CODES = new Set<string>(Object.keys(SAFE_MESSAGES));

export const canonicalUnavailable = (code: EvmRpcSafeErrorCode): ProbeUnavailable => ({
  kind: "unavailable",
  safe_code: code,
  safe_message: SAFE_MESSAGES[code],
});

export const timeoutOutcome = (): ProbeTimeout => ({ kind: "timeout" });

/**
 * Map an injected RPC failure to a probe outcome using canonical messages only.
 * Strips dependency safe_message (URLs, hosts, provider names, credentials, bodies).
 */
export const mapRpcFailure = (err: EvmRpcFailure): ProbeOutcome => {
  const code = err.safe_code;
  if (!KNOWN_CODES.has(code)) {
    return canonicalUnavailable("rpc_transport_failed");
  }
  if (code === "rpc_timeout" || code === "rpc_aborted") {
    return timeoutOutcome();
  }
  return canonicalUnavailable(code);
};
