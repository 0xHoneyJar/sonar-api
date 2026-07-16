/**
 * Provenance redaction for CR-004 metadata egress (SDD §11.3).
 *
 * Never store or return userinfo, raw query, fragments, signed tokens, or
 * other secrets. Preserve origin plus only an explicit allowlist of structural
 * path segments and safe terminal filenames; every other nonempty segment is
 * hashed regardless of case or apparent entropy. A SHA-256 URI digest remains
 * available for correlation.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { TerminalAddressClass } from "./address-policy.js";
import type { AddressFamily, MetadataFailureReason } from "./types.js";
import {
  isAmbiguousRawIpv4Literal,
  rawAuthorityHostname,
} from "./url-policy.js";

const SECRETISH_QUERY_KEY =
  /^(?:token|access_token|refresh_token|id_token|auth|authorization|password|passwd|secret|signature|sig|api_key|apikey|key|session|jwt|bearer|credential|credentials)$/i;

/**
 * Explicit structural directory segments retained in provenance. Arbitrary
 * lowercase dictionary words and opaque credentials are NOT retained.
 */
const STRUCTURAL_PATH_SEGMENTS = new Set([
  "api",
  "v1",
  "v2",
  "v3",
  "collections",
  "collection",
  "metadata",
  "meta",
  "images",
  "image",
  "img",
  "assets",
  "asset",
  "nft",
  "nfts",
  "media",
  "static",
  "public",
  "files",
  "file",
  "download",
  "ipfs",
  "arweave",
  "ar",
]);

/** Basenames allowed for terminal filenames with allowlisted extensions. */
const SAFE_TERMINAL_BASENAMES = new Set([
  "metadata",
  "meta",
  "collection",
  "image",
  "img",
  "asset",
  "nft",
  "media",
  "data",
  "info",
]);

const ALLOWLISTED_EXTENSIONS = new Set([
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".txt",
  ".bin",
]);

export interface RedactedUri {
  /** scheme://[host]:port/path — no userinfo, query, fragment, or opaque secrets. */
  readonly safe_uri: string;
  /** SHA-256 (hex) over a normalized correlation form of the original URI. */
  readonly uri_sha256: string;
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

export const sha256Hex = (data: Uint8Array | string): string => {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return bytesToHex(sha256(bytes));
};

const redactedStub = (segment: string): string =>
  `[redacted:${sha256Hex(segment).slice(0, 12)}]`;

const tryDecodeSegment = (segment: string): string | undefined => {
  if (!/%[0-9a-fA-F]{2}/.test(segment)) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

/** True when the segment is on the explicit structural-directory allowlist. */
export const isStructuralPathSegment = (segment: string): boolean => {
  if (segment === "" || segment === "." || segment === "..") return true;
  if (/%[0-9a-fA-F]{2}/.test(segment)) return false;
  if (segment.length > 64) return false;
  const decoded = tryDecodeSegment(segment);
  if (decoded === undefined || decoded !== segment) return false;
  return STRUCTURAL_PATH_SEGMENTS.has(decoded.toLowerCase());
};

/**
 * Safe filename form (basename + allowlisted extension). Allowed only for the
 * final nonempty path segment — never for intermediate directories.
 */
export const isSafeTerminalFilename = (segment: string): boolean => {
  if (segment === "" || segment === "." || segment === "..") return false;
  if (/%[0-9a-fA-F]{2}/.test(segment)) return false;
  if (segment.length > 64) return false;
  const decoded = tryDecodeSegment(segment);
  if (decoded === undefined || decoded !== segment) return false;

  const extMatch = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\.[A-Za-z0-9]+)$/.exec(decoded);
  if (extMatch === null) return false;
  const base = extMatch[1]!.toLowerCase();
  const ext = extMatch[2]!.toLowerCase();
  return (
    ALLOWLISTED_EXTENSIONS.has(ext) &&
    (SAFE_TERMINAL_BASENAMES.has(base) || STRUCTURAL_PATH_SEGMENTS.has(base))
  );
};

/**
 * Conservative public-safe path segments: explicit structural allowlist, or
 * (when `isTerminal`) a safe filename+extension. Filename shapes in any
 * nonterminal position are not safe. Everything else is hashed.
 */
export const isPublicSafePathSegment = (
  segment: string,
  options?: { readonly isTerminal?: boolean },
): boolean => {
  if (isStructuralPathSegment(segment)) return true;
  if (options?.isTerminal === true && isSafeTerminalFilename(segment)) return true;
  return false;
};

const redactPathname = (pathname: string): string => {
  if (pathname === "" || pathname === "/") return pathname === "" ? "" : "/";
  const leadingSlash = pathname.startsWith("/");
  const parts = pathname.split("/");
  // Terminal = last nonempty segment (trailing empty from trailing slash ignored).
  let lastNonempty = -1;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i] !== "") {
      lastNonempty = i;
      break;
    }
  }
  const redacted = parts.map((segment, index) => {
    const isTerminal = index === lastNonempty;
    if (isPublicSafePathSegment(segment, { isTerminal })) return segment;
    return redactedStub(segment);
  });
  const joined = redacted.join("/");
  if (leadingSlash && !joined.startsWith("/")) return `/${joined}`;
  return joined;
};

/**
 * Build a correlation digest without retaining secrets. Userinfo and fragment
 * are excluded; query is replaced by a stable marker when present so digests
 * still distinguish credentialed vs clean URLs without storing values. Path
 * secrets are hashed into the digest via the original pathname (not retained
 * in safe_uri).
 */
const correlationForm = (url: URL): string => {
  const auth = `${url.protocol}//${url.host}${url.pathname}`;
  const hasUserinfo = url.username !== "" || url.password !== "";
  const hasQuery = url.search !== "" && url.search !== "?";
  const hasFragment = url.hash !== "" && url.hash !== "#";
  const flags = [
    hasUserinfo ? "u" : "",
    hasQuery ? "q" : "",
    hasFragment ? "f" : "",
  ].join("");
  return flags === "" ? auth : `${auth}|${flags}`;
};

export const redactUri = (raw: string): RedactedUri => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      safe_uri: "invalid://",
      uri_sha256: sha256Hex(`invalid|${raw.length}`),
    };
  }

  const rawHostname = rawAuthorityHostname(raw);
  if (
    rawHostname !== undefined &&
    isAmbiguousRawIpv4Literal(rawHostname)
  ) {
    // WHATWG rewrites legacy numeric IPv4 spellings (decimal, hex, shortened,
    // or octal-like) before provenance sees them. Never emit the rewritten
    // authority: it can reveal a denied private or loopback destination.
    return {
      safe_uri: `${url.protocol}//${redactedStub(rawHostname)}${redactPathname(url.pathname)}`,
      uri_sha256: sha256Hex(correlationForm(url)),
    };
  }

  // WHATWG URL pathname mutations are no-ops for opaque URLs (for example
  // data:, javascript:, and mailto:). Emit only the scheme plus a digest stub;
  // never let the opaque payload survive into a field named safe_uri.
  const afterScheme = raw.slice(url.protocol.length);
  if (url.host === "" && !afterScheme.startsWith("//")) {
    return {
      safe_uri: `${url.protocol}${redactedStub(url.pathname)}`,
      uri_sha256: sha256Hex(correlationForm(url)),
    };
  }

  const safe = new URL(url.href);
  safe.username = "";
  safe.password = "";
  safe.search = "";
  safe.hash = "";
  safe.pathname = redactPathname(safe.pathname);

  return {
    safe_uri: safe.href,
    uri_sha256: sha256Hex(correlationForm(url)),
  };
};

/** True when a query string key is secret-bearing (never logged/stored). */
export const isSecretishQueryKey = (key: string): boolean =>
  SECRETISH_QUERY_KEY.test(key);

export interface SafeProvenanceBase {
  readonly requested_uri: string;
  readonly requested_uri_sha256: string;
  readonly retrieved_at: string;
  readonly redirect_count: number;
  readonly failure_reason: MetadataFailureReason;
  readonly final_url?: string;
  readonly final_url_sha256?: string;
  readonly pinned_address?: string;
  readonly address_family?: AddressFamily;
  readonly terminal_address_class?: TerminalAddressClass;
  readonly content_type?: string;
  readonly content_sha256?: string;
  readonly byte_size?: number;
}

export const buildRequestedProvenance = (input: {
  readonly raw_uri: string;
  readonly retrieved_at: string;
}): Pick<
  SafeProvenanceBase,
  "requested_uri" | "requested_uri_sha256" | "retrieved_at" | "redirect_count" | "failure_reason"
> => {
  const redacted = redactUri(input.raw_uri);
  return {
    requested_uri: redacted.safe_uri,
    requested_uri_sha256: redacted.uri_sha256,
    retrieved_at: input.retrieved_at,
    redirect_count: 0,
    failure_reason: "missing",
  };
};

/** Scan a value tree and assert no injected secret substrings remain. */
export const assertNoInjectedSecrets = (
  value: unknown,
  secrets: ReadonlyArray<string>,
): void => {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret !== "" && serialized.includes(secret)) {
      throw new Error("provenance leaked an injected secret");
    }
  }
};
