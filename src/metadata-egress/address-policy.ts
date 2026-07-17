/**
 * Deny-by-default address policy for CR-004 metadata egress.
 *
 * IPv4: private/loopback/link-local/CGNAT/docs/reserved/multicast/IMDS plus
 * IANA non-global specials (including deprecated 6to4 relay anycast
 * 192.88.99.0/24). IPv6: public-only within 2000::/3, minus IANA
 * special-purpose ranges, with explicit decode-or-deny for IPv4-embedding /
 * transition spaces.
 *
 * Registry basis: IANA IPv4/IPv6 Special-Purpose Address Registries
 * (https://www.iana.org/assignments/iana-ipv4-special-registry/,
 * https://www.iana.org/assignments/iana-ipv6-special-registry/).
 */

import type { AddressFamily } from "./types.js";

export type AddressDenialReason =
  | "unspecified"
  | "loopback"
  | "private"
  | "link_local"
  | "multicast"
  | "carrier_grade_nat"
  | "documentation"
  | "reserved"
  | "broadcast"
  | "cloud_metadata"
  | "ipv4_mapped_ipv6"
  | "ipv4_embedded"
  | "transition"
  | "discard"
  | "segment_routing"
  | "non_global"
  | "invalid";

/** Terminal address class retained in provenance (SDD §11.3). */
export type TerminalAddressClass =
  | "public_ipv4"
  | "public_ipv6"
  | "denied"
  | "unknown";

export interface AddressClassification {
  readonly family: AddressFamily;
  readonly canonical: string;
  readonly denied: boolean;
  readonly reason: AddressDenialReason | undefined;
  readonly terminal_address_class: TerminalAddressClass;
}

const IPV4_OCTET = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** Parse a dotted-decimal IPv4; rejects octal/hex/ambiguous forms. */
export const parseCanonicalIpv4 = (raw: string): number | undefined => {
  const parts = raw.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!IPV4_OCTET.test(part)) return undefined;
    // Leading zeros (except "0") are non-canonical / historically octal.
    if (part.length > 1 && part.startsWith("0")) return undefined;
    octets.push(Number(part));
  }
  return ((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!;
};

const formatIpv4 = (ip: number): string =>
  [(ip >>> 24) & 0xff, (ip >>> 16) & 0xff, (ip >>> 8) & 0xff, ip & 0xff].join(
    ".",
  );

const ipv4InCidr = (ip: number, base: number, prefix: number): boolean => {
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (~0 << (32 - prefix)) >>> 0;
  return (ip & mask) === (base & mask);
};

/**
 * IANA IPv4 Special-Purpose ranges that are not globally reachable (plus
 * multicast / class-E reserved). Deny-by-default for egress peers.
 *
 * Registry: https://www.iana.org/assignments/iana-ipv4-special-registry/
 * Notably includes deprecated 6to4 relay anycast 192.88.99.0/24 and
 * 6a44-relay 192.88.99.2/32 (covered by the /24). Globally-reachable
 * specials (AS112, AMT, …) are intentionally left routable.
 */
const IPV4_DENY: ReadonlyArray<{
  base: string;
  prefix: number;
  reason: AddressDenialReason;
}> = [
  { base: "0.0.0.0", prefix: 8, reason: "unspecified" },
  { base: "10.0.0.0", prefix: 8, reason: "private" },
  { base: "100.64.0.0", prefix: 10, reason: "carrier_grade_nat" },
  { base: "127.0.0.0", prefix: 8, reason: "loopback" },
  { base: "169.254.0.0", prefix: 16, reason: "link_local" },
  { base: "172.16.0.0", prefix: 12, reason: "private" },
  { base: "192.0.0.0", prefix: 24, reason: "reserved" },
  { base: "192.0.2.0", prefix: 24, reason: "documentation" },
  // Deprecated 6to4 relay anycast + 6a44-relay (RFC7526 / RFC6751).
  { base: "192.88.99.0", prefix: 24, reason: "transition" },
  { base: "192.168.0.0", prefix: 16, reason: "private" },
  { base: "198.18.0.0", prefix: 15, reason: "reserved" },
  { base: "198.51.100.0", prefix: 24, reason: "documentation" },
  { base: "203.0.113.0", prefix: 24, reason: "documentation" },
  { base: "224.0.0.0", prefix: 4, reason: "multicast" },
  { base: "240.0.0.0", prefix: 4, reason: "reserved" },
];

const CLOUD_METADATA_IPV4 = new Set<number>([
  parseCanonicalIpv4("169.254.169.254")!,
  parseCanonicalIpv4("169.254.170.2")!,
  parseCanonicalIpv4("100.100.100.200")!,
]);

export const classifyIpv4 = (raw: string): AddressClassification => {
  const ip = parseCanonicalIpv4(raw);
  if (ip === undefined) {
    return {
      family: "ipv4",
      canonical: raw,
      denied: true,
      reason: "invalid",
      terminal_address_class: "denied",
    };
  }
  const canonical = formatIpv4(ip);

  if (CLOUD_METADATA_IPV4.has(ip)) {
    return {
      family: "ipv4",
      canonical,
      denied: true,
      reason: "cloud_metadata",
      terminal_address_class: "denied",
    };
  }
  if (ip === 0xffffffff) {
    return {
      family: "ipv4",
      canonical,
      denied: true,
      reason: "broadcast",
      terminal_address_class: "denied",
    };
  }
  for (const rule of IPV4_DENY) {
    const base = parseCanonicalIpv4(rule.base)!;
    if (ipv4InCidr(ip, base, rule.prefix)) {
      return {
        family: "ipv4",
        canonical,
        denied: true,
        reason: rule.reason,
        terminal_address_class: "denied",
      };
    }
  }
  return {
    family: "ipv4",
    canonical,
    denied: false,
    reason: undefined,
    terminal_address_class: "public_ipv4",
  };
};

/**
 * Expand an IPv6 literal to 8 hextets. Supports dotted-decimal tails used by
 * mapped / compatible / NAT64 textual forms.
 */
export const expandIpv6 = (raw: string): string[] | undefined => {
  const lower = raw.toLowerCase();

  let head: string;
  let tail: string;
  if (lower.includes("::")) {
    const parts = lower.split("::");
    if (parts.length !== 2) return undefined;
    head = parts[0]!;
    tail = parts[1]!;
  } else {
    head = lower;
    tail = "";
  }

  const headParts = head === "" ? [] : head.split(":");
  const tailParts = tail === "" ? [] : tail.split(":");

  if (tailParts.length > 0) {
    const last = tailParts[tailParts.length - 1]!;
    if (last.includes(".")) {
      const v4 = parseCanonicalIpv4(last);
      if (v4 === undefined) return undefined;
      tailParts[tailParts.length - 1] = ((v4 >>> 16) & 0xffff).toString(16);
      tailParts.push((v4 & 0xffff).toString(16));
    }
  }

  // Also allow dotted decimal in the sole hextet position without :: (rare).
  if (headParts.length > 0 && tailParts.length === 0) {
    const last = headParts[headParts.length - 1]!;
    if (last.includes(".")) {
      const v4 = parseCanonicalIpv4(last);
      if (v4 === undefined) return undefined;
      headParts[headParts.length - 1] = ((v4 >>> 16) & 0xffff).toString(16);
      headParts.push((v4 & 0xffff).toString(16));
    }
  }

  const missing = 8 - (headParts.length + tailParts.length);
  if (missing < 0) return undefined;
  if (!lower.includes("::") && missing !== 0) return undefined;

  const full = [
    ...headParts,
    ...Array.from({ length: missing }, () => "0"),
    ...tailParts,
  ];
  if (full.length !== 8) return undefined;

  const hextets: string[] = [];
  for (const part of full) {
    if (part === "") return undefined;
    if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
    hextets.push(part.padStart(4, "0"));
  }
  return hextets;
};

const hextetsToBigInt = (hextets: string[]): bigint => {
  let value = 0n;
  for (const h of hextets) {
    value = (value << 16n) + BigInt(parseInt(h, 16));
  }
  return value;
};

const ipv6InCidr = (ip: bigint, base: bigint, prefix: number): boolean => {
  if (prefix === 0) return true;
  const shift = BigInt(128 - prefix);
  return ip >> shift === base >> shift;
};

const parseIpv6Base = (raw: string): bigint => {
  const hextets = expandIpv6(raw);
  if (hextets === undefined) {
    throw new Error(`internal: invalid IPv6 base ${raw}`);
  }
  return hextetsToBigInt(hextets);
};

/** Low 32 bits of an IPv6 address as an IPv4 integer. */
const embeddedIpv4FromLow32 = (value: bigint): number =>
  Number(value & 0xffffffffn);

/** 6to4 embeds IPv4 in bits 16..47 (hextets 1..2 after 2002). */
const embeddedIpv4From6to4 = (value: bigint): number =>
  Number((value >> 80n) & 0xffffffffn);

/**
 * IANA special-purpose / transition ranges that are never valid egress peers.
 * Embedding spaces are listed so we always deny the prefix even when the
 * embedded IPv4 would otherwise look "public".
 */
const IPV6_SPECIAL: ReadonlyArray<{
  base: string;
  prefix: number;
  reason: AddressDenialReason;
}> = [
  { base: "::", prefix: 128, reason: "unspecified" },
  { base: "::1", prefix: 128, reason: "loopback" },
  // Deprecated IPv4-compatible ::/96 (excluding :: and ::1 handled above).
  { base: "::", prefix: 96, reason: "transition" },
  { base: "::ffff:0:0", prefix: 96, reason: "ipv4_mapped_ipv6" },
  { base: "64:ff9b::", prefix: 96, reason: "transition" },
  { base: "64:ff9b:1::", prefix: 48, reason: "transition" },
  { base: "100::", prefix: 64, reason: "discard" },
  { base: "2001::", prefix: 23, reason: "reserved" },
  { base: "2001:db8::", prefix: 32, reason: "documentation" },
  { base: "2002::", prefix: 16, reason: "transition" },
  { base: "3fff::", prefix: 20, reason: "documentation" },
  { base: "5f00::", prefix: 16, reason: "segment_routing" },
  { base: "fc00::", prefix: 7, reason: "private" },
  { base: "fe80::", prefix: 10, reason: "link_local" },
  { base: "ff00::", prefix: 8, reason: "multicast" },
];

const GLOBAL_UNICAST_BASE = parseIpv6Base("2000::");
const GLOBAL_UNICAST_PREFIX = 3;

const denied = (
  family: AddressFamily,
  canonical: string,
  reason: AddressDenialReason,
): AddressClassification => ({
  family,
  canonical,
  denied: true,
  reason,
  terminal_address_class: "denied",
});

/**
 * Prefer a concrete IPv4 denial (private/loopback/…) when the embedding
 * carries a hostile v4; otherwise keep the transition/mapped reason so
 * sparse forms like `64:ff9b:1::1` are not mislabeled as `unspecified`.
 */
const embeddingReason = (
  v4: AddressClassification,
  fallback: AddressDenialReason,
): AddressDenialReason => {
  if (!v4.denied || v4.reason === undefined) return fallback;
  if (
    v4.reason === "unspecified" ||
    v4.reason === "invalid" ||
    v4.reason === "broadcast"
  ) {
    return fallback;
  }
  return v4.reason;
};

/**
 * Decode embedding / transition forms and apply IPv4 deny policy to the
 * embedded address. The embedding prefix itself is always denied.
 */
const classifyIpv6Embedding = (
  value: bigint,
  canonical: string,
): AddressClassification | undefined => {
  // IPv4-mapped ::ffff:0:0/96
  if (ipv6InCidr(value, parseIpv6Base("::ffff:0:0"), 96)) {
    const v4 = classifyIpv4(formatIpv4(embeddedIpv4FromLow32(value)));
    return denied(
      "ipv6",
      canonical,
      embeddingReason(v4, "ipv4_mapped_ipv6"),
    );
  }

  // Deprecated IPv4-compatible ::/96 (not :: or ::1 — those match earlier).
  if (
    ipv6InCidr(value, parseIpv6Base("::"), 96) &&
    value !== 0n &&
    value !== 1n
  ) {
    const v4 = classifyIpv4(formatIpv4(embeddedIpv4FromLow32(value)));
    return denied("ipv6", canonical, embeddingReason(v4, "transition"));
  }

  // NAT64 well-known prefix 64:ff9b::/96
  if (ipv6InCidr(value, parseIpv6Base("64:ff9b::"), 96)) {
    const v4 = classifyIpv4(formatIpv4(embeddedIpv4FromLow32(value)));
    return denied("ipv6", canonical, embeddingReason(v4, "transition"));
  }

  // Local-use NAT64 64:ff9b:1::/48 — deny prefix; apply IPv4 policy when a
  // concrete dotted/embedded v4 is present in the low 32 bits.
  if (ipv6InCidr(value, parseIpv6Base("64:ff9b:1::"), 48)) {
    const v4 = classifyIpv4(formatIpv4(embeddedIpv4FromLow32(value)));
    return denied("ipv6", canonical, embeddingReason(v4, "transition"));
  }

  // 6to4 2002::/16
  if (ipv6InCidr(value, parseIpv6Base("2002::"), 16)) {
    const v4 = classifyIpv4(formatIpv4(embeddedIpv4From6to4(value)));
    return denied("ipv6", canonical, embeddingReason(v4, "transition"));
  }

  return undefined;
};

export const classifyIpv6 = (raw: string): AddressClassification => {
  const hextets = expandIpv6(raw);
  if (hextets === undefined) {
    return denied("ipv6", raw, "invalid");
  }
  const canonical = hextets.join(":");
  const value = hextetsToBigInt(hextets);

  // Cloud IMDS over IPv6 before broader ULA matching.
  if (value === parseIpv6Base("fd00:ec2::254")) {
    return denied("ipv6", canonical, "cloud_metadata");
  }

  const embedded = classifyIpv6Embedding(value, canonical);
  if (embedded !== undefined) {
    return embedded;
  }

  for (const rule of IPV6_SPECIAL) {
    const base = parseIpv6Base(rule.base);
    if (ipv6InCidr(value, base, rule.prefix)) {
      return denied("ipv6", canonical, rule.reason);
    }
  }

  // Public-only: require global unicast 2000::/3 after specials are excluded.
  if (!ipv6InCidr(value, GLOBAL_UNICAST_BASE, GLOBAL_UNICAST_PREFIX)) {
    return denied("ipv6", canonical, "non_global");
  }

  return {
    family: "ipv6",
    canonical,
    denied: false,
    reason: undefined,
    terminal_address_class: "public_ipv6",
  };
};

export const classifyIpAddress = (raw: string): AddressClassification => {
  let trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    trimmed = trimmed.slice(1, -1);
  }
  if (trimmed.includes(":")) {
    // Strip zone id (fe80::1%eth0)
    const withoutZone = trimmed.split("%")[0]!;
    return classifyIpv6(withoutZone);
  }
  return classifyIpv4(trimmed);
};

export const terminalAddressClassOf = (
  classification: AddressClassification,
): TerminalAddressClass => classification.terminal_address_class;

/**
 * Hostnames that resolve to cloud instance metadata regardless of A/AAAA.
 * Prefer multi-label FQDNs only — a bare `metadata` label would false-deny
 * unrelated public single-label hosts.
 */
export const CLOUD_METADATA_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

export const isCloudMetadataHostname = (hostname: string): boolean =>
  CLOUD_METADATA_HOSTNAMES.has(hostname.toLowerCase());

/**
 * Format host for URI / HTTP Host authority. Bracket IPv6; append non-default
 * port. SNI must use the bare hostname without brackets.
 */
export const formatHostAuthority = (input: {
  readonly hostname: string;
  readonly port: number;
  readonly scheme: "http" | "https";
}): string => {
  const isIpv6 = input.hostname.includes(":");
  const host = isIpv6 ? `[${input.hostname}]` : input.hostname;
  const defaultPort = input.scheme === "https" ? 443 : 80;
  if (input.port === defaultPort) return host;
  return `${host}:${input.port}`;
};
