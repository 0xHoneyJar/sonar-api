/**
 * Hermetic DNS + transport fixtures for CR-004 security suite.
 * No real network I/O.
 */

import { gzipSync } from "node:zlib";
import type { DnsAnswer, DnsPort, MetadataEgressPorts, PinnedTransportPort } from "./ports.js";
import type { TransportRequest, TransportResponse } from "./types.js";

export type ScriptedHop =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: Uint8Array | string;
      readonly delay_ms?: number;
      /** Capture the outbound request for credential-forwarding assertions. */
      readonly capture?: (request: TransportRequest) => void;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly delay_ms?: number;
    };

export type ScriptedTransport = Record<string, ScriptedHop | ScriptedHop[]>;

/** Single answer-set, or a sequence of answer-sets (DNS rebinding across hops). */
export type ScriptedDnsEntry =
  | ReadonlyArray<DnsAnswer>
  | { readonly sequence: ReadonlyArray<ReadonlyArray<DnsAnswer>> };

export type ScriptedDns = Record<string, ScriptedDnsEntry>;

const bodyBytes = (body: Uint8Array | string | undefined): Uint8Array => {
  if (body === undefined) return new Uint8Array();
  if (typeof body === "string") return new Uint8Array(Buffer.from(body, "utf8"));
  return body;
};

const hopKey = (request: TransportRequest): string =>
  `${request.target.scheme}://${request.target.hostname}:${request.target.port}${request.target.url.pathname}${request.target.url.search}@@${request.target.pinned_address}`;

const hostKey = (request: TransportRequest): string =>
  `${request.target.scheme}://${request.target.hostname}${request.target.url.pathname}${request.target.url.search}`;

const hostPortKey = (request: TransportRequest): string =>
  `${request.target.scheme}://${request.target.host_authority}${request.target.url.pathname}${request.target.url.search}`;

export const createScriptedDnsPort = (table: ScriptedDns): DnsPort => {
  const cursors = new Map<string, number>();
  return {
    lookup: async (hostname: string) => {
      const key = hostname.toLowerCase();
      const entry = table[key];
      if (entry === undefined) {
        throw new Error(`hermetic DNS miss for ${hostname}`);
      }
      if ("sequence" in entry) {
        const index = cursors.get(key) ?? 0;
        const answers = entry.sequence[Math.min(index, entry.sequence.length - 1)]!;
        cursors.set(key, index + 1);
        return answers;
      }
      return entry;
    },
  };
};

export const createScriptedTransportPort = (
  table: ScriptedTransport,
): PinnedTransportPort => {
  const cursors = new Map<string, number>();

  return {
    exchange: async (request: TransportRequest): Promise<TransportResponse> => {
      const keys = [
        hopKey(request),
        hostPortKey(request),
        hostKey(request),
        request.target.hostname,
      ];
      let script: ScriptedHop | ScriptedHop[] | undefined;
      let matchedKey: string | undefined;
      for (const key of keys) {
        if (table[key] !== undefined) {
          script = table[key];
          matchedKey = key;
          break;
        }
      }
      if (script === undefined || matchedKey === undefined) {
        throw new Error(
          `hermetic transport miss for ${hopKey(request)} (pinned ${request.target.pinned_address})`,
        );
      }

      const sequence = Array.isArray(script) ? script : [script];
      const index = cursors.get(matchedKey) ?? 0;
      const hop = sequence[Math.min(index, sequence.length - 1)]!;
      cursors.set(matchedKey, index + 1);

      if (hop.delay_ms !== undefined && hop.delay_ms > 0) {
        await new Promise((resolve) => setTimeout(resolve, hop.delay_ms));
      }

      if (hop.kind === "error") {
        throw new Error(hop.message);
      }

      hop.capture?.(request);
      return {
        status: hop.status,
        headers: { ...(hop.headers ?? {}) },
        body: bodyBytes(hop.body),
      };
    },
  };
};

export const createHermeticPorts = (input: {
  readonly dns: ScriptedDns;
  readonly transport: ScriptedTransport;
}): MetadataEgressPorts => ({
  dns: createScriptedDnsPort(input.dns),
  transport: createScriptedTransportPort(input.transport),
});

/**
 * Tiny valid 1x1 RGB PNG (signature + IHDR + IDAT zlib + IEND, CRC-checked).
 * Color type 2 (truecolor), non-interlaced, 8-bit — within the trusted subset
 * (types 0/2/4/6). IDAT inflates to one filter+RGB scanline — image-bearing,
 * not framing-only. This is the only trusted image fixture for CR-004.
 */
export const FIXTURE_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
  0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00,
  0x01, 0xf6, 0x17, 0x38, 0x55, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

/**
 * Denial-only JPEG bytes — NOT trusted. Retained so typed partial / peek
 * regressions can assert fail-closed behavior without advertising support.
 */
export const FIXTURE_JPEG_DENIED = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01,
  0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xda,
  0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00, 0xff, 0xd9,
]);

/** @deprecated Alias — denied format fixture only. */
export const FIXTURE_JPEG = FIXTURE_JPEG_DENIED;

/**
 * Denial-only GIF bytes — NOT trusted.
 */
export const FIXTURE_GIF_DENIED = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00,
  0x01, 0x00, 0x00, 0x02, 0x02, 0x4c, 0x01, 0x00, 0x3b,
]);

/** @deprecated Alias — denied format fixture only. */
export const FIXTURE_GIF = FIXTURE_GIF_DENIED;

/**
 * Framing-only RIFF/WEBP — NOT trusted. Retained for adversarial denial tests.
 */
export const FIXTURE_WEBP_FRAMING_ONLY = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56,
  0x50, 0x38, 0x20, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);

/** @deprecated Alias — framing-only; never accepted as trusted image content. */
export const FIXTURE_WEBP = FIXTURE_WEBP_FRAMING_ONLY;

/**
 * Framing-only AVIF ftyp+empty meta — NOT trusted. Retained for denial /
 * brand-spoof tests only.
 */
export const FIXTURE_AVIF_FRAMING_ONLY = new Uint8Array([
  // ftyp (28 bytes): size=28, major=avif, compat=avif,mif1,miaf
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0x00,
  0x00, 0x00, 0x00, 0x61, 0x76, 0x69, 0x66, 0x6d, 0x69, 0x66, 0x31, 0x6d, 0x69,
  0x61, 0x66,
  // meta (12 bytes): size=12, version/flags + empty
  0x00, 0x00, 0x00, 0x0c, 0x6d, 0x65, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
]);

/** @deprecated Alias — framing-only; never accepted as trusted image content. */
export const FIXTURE_AVIF = FIXTURE_AVIF_FRAMING_ONLY;
/** Deprecated 6to4 / 6a44 relay anycast space (IANA non-global). */
export const RELAY_ANYCAST_V4 = "192.88.99.1";
export const RELAY_ANYCAST_V4_6A44 = "192.88.99.2";

export const gzipBomb = (decompressedBytes: number): Uint8Array => {
  const zeros = new Uint8Array(decompressedBytes);
  return new Uint8Array(gzipSync(zeros));
};

/** Genuinely public fixture addresses (outside IANA special-purpose ranges). */
export const PUBLIC_V4 = "1.1.1.1";
export const PUBLIC_V4_B = "1.0.0.1";
export const PUBLIC_V6 = "2001:4860:4860:0000:0000:0000:0000:8888";
export const PUBLIC_V6_LITERAL = "2001:4860:4860::8888";
export const PRIVATE_V4 = "10.0.0.5";
export const LOOPBACK_V4 = "127.0.0.1";
export const LINK_LOCAL_V4 = "169.254.169.254";
export const CGNAT_V4 = "100.64.1.1";
export const MAPPED_LOOPBACK = "::ffff:127.0.0.1";
