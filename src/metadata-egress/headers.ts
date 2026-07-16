/**
 * Deny-by-default request headers for metadata egress.
 *
 * Never forwards ambient cookies, Authorization, proxy credentials, cloud
 * credentials, or caller-controlled hop-by-hop / sensitive headers.
 * Host authority includes non-default port and brackets public IPv6.
 */

import { EGRESS_USER_AGENT } from "./limits.js";
import type { EgressRequestHeaders, MetadataRetrievalPurpose } from "./types.js";

/** Headers that must never be accepted from callers or ambient environment. */
export const FORBIDDEN_REQUEST_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
  "x-aws-ec2-metadata-token",
  "x-aws-ec2-metadata-token-ttl-seconds",
  "x-google-metadata-request",
  "metadata-flavor",
  "x-metadata-token",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "http2-settings",
  "host",
]);

const ACCEPT_FOR_PURPOSE: Record<MetadataRetrievalPurpose, string> = {
  // Explicit metadata types only — no wildcard, no denied image MIME.
  collection_metadata: "application/json, application/ld+json, text/plain;q=0.5",
  // PNG-only trusted images — do not advertise formats this boundary refuses.
  collection_image: "image/png",
  report_enrichment:
    "application/json, application/ld+json, text/plain;q=0.5, image/png",
};

export const buildEgressRequestHeaders = (input: {
  readonly purpose: MetadataRetrievalPurpose;
  /** Already-formatted Host authority (IPv6 brackets + non-default port). */
  readonly host_authority: string;
  readonly allow_compression?: boolean;
}): EgressRequestHeaders => {
  const headers: EgressRequestHeaders = {
    accept: ACCEPT_FOR_PURPOSE[input.purpose],
    "user-agent": EGRESS_USER_AGENT,
    host: input.host_authority,
  };
  if (input.allow_compression !== false) {
    return {
      ...headers,
      "accept-encoding": "gzip, deflate",
    };
  }
  return headers;
};

/**
 * Strip any caller-supplied header map down to an empty allowlist.
 * Callers cannot inject headers into the egress request.
 */
export const sanitizeCallerHeaders = (
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, never> => {
  if (headers === undefined) return {};
  for (const name of Object.keys(headers)) {
    if (FORBIDDEN_REQUEST_HEADER_NAMES.has(name.toLowerCase())) {
      // Explicitly ignored — never forwarded.
      continue;
    }
  }
  // Deny-by-default: no caller headers are forwarded.
  return {};
};

export const assertNoSensitiveHeadersForwarded = (
  headers: EgressRequestHeaders,
): void => {
  const entries: ReadonlyArray<readonly [string, string | undefined]> = [
    ["accept", headers.accept],
    ["user-agent", headers["user-agent"]],
    ["host", headers.host],
    ["accept-encoding", headers["accept-encoding"]],
  ];
  for (const [name, value] of entries) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (FORBIDDEN_REQUEST_HEADER_NAMES.has(lower) && lower !== "host") {
      throw new Error(`internal: forbidden header "${name}" would be forwarded`);
    }
  }
};
