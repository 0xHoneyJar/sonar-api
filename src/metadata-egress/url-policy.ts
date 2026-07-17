/**
 * URI / host canonicalization for CR-004 metadata egress.
 *
 * Unsupported schemes, credentials-in-URL, non-canonical IP literals,
 * disallowed ports, and ambiguous host forms are refused before any DNS or
 * connect. Brackets appear only in URI/Host authority for IPv6.
 */

import {
  classifyIpAddress,
  formatHostAuthority,
  isCloudMetadataHostname,
  parseCanonicalIpv4,
} from "./address-policy.js";
import { DEFAULT_ALLOWED_PORTS } from "./limits.js";
import type { MetadataFailureReason } from "./types.js";

export interface ParsedMetadataUrl {
  readonly url: URL;
  readonly scheme: "http" | "https";
  readonly hostname: string;
  readonly port: number;
  readonly host_is_ip_literal: boolean;
  readonly host_authority: string;
}

export type UrlPolicyError = {
  readonly reason: MetadataFailureReason;
  readonly safe_message: string;
};

const DEFAULT_PORTS: Record<"http" | "https", number> = {
  http: 80,
  https: 443,
};

/**
 * Extract the hostname spelling from the original authority before WHATWG URL
 * canonicalization. Browsers normalize legacy IPv4 forms (for example,
 * `001.001.001.001` and `16843009`) into ordinary dotted decimal, which would
 * otherwise erase the evidence needed to reject an ambiguous input.
 */
export const rawAuthorityHostname = (raw: string): string | undefined => {
  const match = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(raw.trim());
  if (match === null) return undefined;
  const authority = match[1]!;
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostAndPort.startsWith("[")) {
    const closingBracket = hostAndPort.indexOf("]");
    return closingBracket < 0 ? undefined : hostAndPort.slice(0, closingBracket + 1);
  }
  const colonCount = hostAndPort.split(":").length - 1;
  if (colonCount > 1) return undefined;
  const colon = hostAndPort.lastIndexOf(":");
  return (colon < 0 ? hostAndPort : hostAndPort.slice(0, colon)).toLowerCase();
};

/** Decimal, hexadecimal, octal-like, or shortened IPv4 accepted by WHATWG. */
export const isAmbiguousRawIpv4Literal = (rawHostname: string): boolean => {
  if (rawHostname.startsWith("[")) return false;
  const candidate = rawHostname.endsWith(".")
    ? rawHostname.slice(0, -1)
    : rawHostname;
  const parts = candidate.split(".");
  if (!parts.every((part) => /^(?:\d+|0x[0-9a-f]+)$/i.test(part))) {
    return false;
  }
  return parseCanonicalIpv4(candidate) === undefined;
};

export const parseMetadataUrl = (
  raw: string,
  options?: {
    readonly allowed_ports?: ReadonlyArray<number>;
  },
): ParsedMetadataUrl | UrlPolicyError => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      reason: "ambiguous_host",
      safe_message: "metadata URI is not a valid absolute URL",
    };
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return {
      reason: "unsupported_scheme",
      safe_message: `unsupported URI scheme "${protocol.replace(":", "")}"`,
    };
  }

  if (url.username !== "" || url.password !== "") {
    return {
      reason: "ambiguous_host",
      safe_message: "metadata URI must not embed userinfo credentials",
    };
  }

  if (url.hostname === "") {
    return {
      reason: "ambiguous_host",
      safe_message: "metadata URI is missing a host",
    };
  }

  const originalHostname = rawAuthorityHostname(raw);
  if (
    originalHostname !== undefined &&
    isAmbiguousRawIpv4Literal(originalHostname)
  ) {
    return {
      reason: "ambiguous_host",
      safe_message: "metadata URI host is an ambiguous non-canonical IPv4 literal",
    };
  }

  // Reject hostnames with whitespace/backslash, and C0/DEL controls anywhere
  // in the serialized URI. The control class is ONLY U+0000–U+001F and U+007F
  // — not `@`–`^`, `_`, letters, or `[`/`]` — so bracketed IPv6, underscore
  // paths, mixed-case paths, and query values containing `@` remain valid.
  const hasControlChars = (value: string): boolean =>
    /[\u0000-\u001f\u007f]/.test(value);
  if (
    /[\s\\]/.test(url.hostname) ||
    hasControlChars(url.hostname) ||
    hasControlChars(url.href)
  ) {
    return {
      reason: "ambiguous_host",
      safe_message: "metadata URI host contains prohibited characters",
    };
  }

  const scheme = protocol === "https:" ? "https" : "http";
  // Node/WHATWG may retain brackets on IPv6 hostnames; normalize to bare form.
  let hostname = stripIpv6Brackets(url.hostname.toLowerCase());

  const hostIsIp = looksLikeIpLiteral(hostname);

  if (hostIsIp) {
    const classified = classifyIpAddress(hostname);
    if (classified.denied) {
      return {
        reason: "denied_address",
        safe_message: `IP literal denied (${classified.reason ?? "policy"})`,
      };
    }
    hostname = classified.canonical;
  } else {
    if (hostname.endsWith(".")) {
      hostname = hostname.slice(0, -1);
    }
    if (hostname === "" || hostname.includes("..")) {
      return {
        reason: "ambiguous_host",
        safe_message: "metadata URI host is non-canonical",
      };
    }
    if (hostname.includes("%")) {
      return {
        reason: "ambiguous_host",
        safe_message: "metadata URI host is an ambiguous non-canonical literal",
      };
    }
    // Reject dotted forms that are almost-IPv4 but non-canonical (e.g. 127.1).
    if (/^\d+(?:\.\d+){1,3}$/.test(hostname) && parseCanonicalIpv4(hostname) === undefined) {
      return {
        reason: "ambiguous_host",
        safe_message: "metadata URI host is a non-canonical IPv4 form",
      };
    }
    if (isCloudMetadataHostname(hostname)) {
      return {
        reason: "denied_address",
        safe_message: "cloud metadata hostname is denied",
      };
    }
  }

  const port = url.port === "" ? DEFAULT_PORTS[scheme] : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      reason: "ambiguous_host",
      safe_message: "metadata URI port is invalid",
    };
  }

  const allowedPorts = options?.allowed_ports ?? DEFAULT_ALLOWED_PORTS;
  if (!allowedPorts.includes(port)) {
    return {
      reason: "denied_port",
      safe_message: `port ${port} is not in the egress allowlist`,
    };
  }

  // Rebuild a canonical URL. IPv6 hostnames stay unbracketed in URL.hostname;
  // brackets appear only via host authority / href serialization.
  const canonical = new URL(url.href);
  canonical.protocol = `${scheme}:`;
  canonical.username = "";
  canonical.password = "";
  canonical.hostname = hostname;
  if (
    (scheme === "https" && port === 443) ||
    (scheme === "http" && port === 80)
  ) {
    canonical.port = "";
  } else {
    canonical.port = String(port);
  }

  const host_authority = formatHostAuthority({ hostname, port, scheme });

  return {
    url: canonical,
    scheme,
    hostname,
    port,
    host_is_ip_literal: hostIsIp,
    host_authority,
  };
};

const stripIpv6Brackets = (hostname: string): string => {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
};

const looksLikeIpLiteral = (hostname: string): boolean => {
  if (hostname.includes(":")) return true;
  return parseCanonicalIpv4(hostname) !== undefined;
};

export const isUrlPolicyError = (
  value: ParsedMetadataUrl | UrlPolicyError,
): value is UrlPolicyError => "reason" in value && "safe_message" in value;
