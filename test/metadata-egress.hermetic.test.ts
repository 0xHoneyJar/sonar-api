/**
 * CR-004 — hermetic metadata egress threat-model suite (post security FAIL).
 *
 * DNS and transport ports are injected; no real network calls.
 */

import { describe, expect, it } from "vitest";
import {
  CGNAT_V4,
  FIXTURE_AVIF_FRAMING_ONLY,
  FIXTURE_GIF,
  FIXTURE_JPEG,
  FIXTURE_PNG,
  FIXTURE_WEBP_FRAMING_ONLY,
  LINK_LOCAL_V4,
  LOOPBACK_V4,
  MAPPED_LOOPBACK,
  PRIVATE_V4,
  PUBLIC_V4,
  PUBLIC_V4_B,
  PUBLIC_V6,
  PUBLIC_V6_LITERAL,
  RELAY_ANYCAST_V4,
  RELAY_ANYCAST_V4_6A44,
  assertNoInjectedSecrets,
  classifyIpAddress,
  classifyUntrustedImageRef,
  createHermeticPorts,
  createMetadataEgressClient,
  createReportMetadataWorkerPort,
  createResolverMetadataPort,
  detectImageKind,
  enrichCandidateFromRemoteMetadata,
  evaluateContentType,
  evaluateRetrievedContent,
  formatHostAuthority,
  gzipBomb,
  buildEgressRequestHeaders,
  isPublicSafePathSegment,
  isSafeTerminalFilename,
  parseMetadataUrl,
  peekImageMagic,
  redactUri,
  retrieveMetadata,
  sanitizeCallerHeaders,
  sha256Hex,
  sniffEmbeddedHostileInImageBody,
  sniffHostilePayload,
  TRUSTED_IMAGE_KINDS,
  validateImagePayload,
  validateImageStructure,
  validatePngStructure,
  type TransportRequest,
} from "../src/metadata-egress/index.js";
import { DEFAULT_METADATA_EGRESS_LIMITS } from "../src/metadata-egress/limits.js";
import { isUrlPolicyError } from "../src/metadata-egress/url-policy.js";
import { deflateSync } from "node:zlib";

const fixedNow = () => new Date("2026-07-16T12:00:00.000Z");

const deflateBytes = (data: Uint8Array | string): Uint8Array => {
  const input =
    typeof data === "string"
      ? new Uint8Array(Buffer.from(data, "utf8"))
      : data;
  return new Uint8Array(deflateSync(input as never));
};

/** IEEE CRC-32 for adversarial PNG chunk construction in tests. */
const pngCrc32 = (data: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < data.byteLength; i += 1) {
    c ^= data[i]!;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.byteLength);
  view.setUint32(8 + data.byteLength, pngCrc32(crcInput));
  return out;
};

const pngSig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Build a minimal CRC-valid PNG from IHDR fields + optional chunks + IDAT. */
const buildPng = (parts: {
  readonly ihdr: Uint8Array;
  readonly beforeIdat?: ReadonlyArray<Uint8Array>;
  readonly idat: Uint8Array;
  readonly afterIdat?: ReadonlyArray<Uint8Array>;
}): Uint8Array => {
  const chunks: Uint8Array[] = [
    pngSig,
    pngChunk("IHDR", parts.ihdr),
    ...(parts.beforeIdat ?? []),
    pngChunk("IDAT", parts.idat),
    ...(parts.afterIdat ?? []),
    pngChunk("IEND", new Uint8Array()),
  ];
  let len = 0;
  for (const c of chunks) len += c.byteLength;
  const out = new Uint8Array(len);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
};

const utf16le = (text: string): Uint8Array => {
  const buf = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    buf.writeUInt16LE(text.charCodeAt(i), i * 2);
  }
  return new Uint8Array(buf);
};

const utf16be = (text: string): Uint8Array => {
  const buf = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    buf.writeUInt16BE(text.charCodeAt(i), i * 2);
  }
  return new Uint8Array(buf);
};

describe("CR-004 IPv4/IPv6 address policy (IANA special-purpose)", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.9.1", "private"],
    ["192.168.0.1", "private"],
    ["169.254.169.254", "cloud_metadata"],
    ["100.64.1.1", "carrier_grade_nat"],
    ["224.0.0.1", "multicast"],
    ["0.0.0.0", "unspecified"],
    ["203.0.113.10", "documentation"],
    ["192.0.2.1", "documentation"],
    ["198.51.100.1", "documentation"],
    ["198.18.0.1", "reserved"],
    ["192.0.0.1", "reserved"],
    ["240.0.0.1", "reserved"],
    // Deprecated 6to4 relay anycast / 6a44-relay (IANA non-global).
    ["192.88.99.0", "transition"],
    ["192.88.99.1", "transition"],
    ["192.88.99.2", "transition"],
    ["192.88.99.255", "transition"],
    ["::1", "loopback"],
    ["fc00::1", "private"],
    ["fe80::1", "link_local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:1.1.1.1", "ipv4_mapped_ipv6"],
    ["::ffff:192.88.99.2", "transition"],
    ["fd00:ec2::254", "cloud_metadata"],
    // Reviewer probes — embedding / transition / special-purpose.
    ["64:ff9b::10.0.0.1", "private"],
    ["64:ff9b::1.1.1.1", "transition"],
    ["64:ff9b:1::1", "transition"],
    ["::127.0.0.1", "loopback"],
    ["::1.1.1.1", "transition"],
    ["2002:0a00:0001::1", "private"],
    ["2002:0101:0101::1", "transition"],
    ["2002:c058:6301::1", "transition"], // 6to4 of 192.88.99.1
    ["100::1", "discard"],
    ["100::", "discard"],
    ["3fff::1", "documentation"],
    ["3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff", "documentation"],
    ["5f00::1", "segment_routing"],
    ["5f00:ffff::", "segment_routing"],
    ["2001::1", "reserved"],
  ])("denies %s (%s)", (address, reason) => {
    const classified = classifyIpAddress(address);
    expect(classified.denied).toBe(true);
    expect(classified.reason).toBe(reason);
    expect(classified.terminal_address_class).toBe("denied");
  });

  it("allows genuinely public IPv4 and IPv6", () => {
    expect(classifyIpAddress(PUBLIC_V4).denied).toBe(false);
    expect(classifyIpAddress(PUBLIC_V4).terminal_address_class).toBe("public_ipv4");
    expect(classifyIpAddress(PUBLIC_V4_B).denied).toBe(false);
    expect(classifyIpAddress("8.8.8.8").denied).toBe(false);
    expect(classifyIpAddress(PUBLIC_V6_LITERAL).denied).toBe(false);
    expect(classifyIpAddress(PUBLIC_V6_LITERAL).terminal_address_class).toBe(
      "public_ipv6",
    );
    expect(classifyIpAddress(PUBLIC_V6).canonical).toBe(PUBLIC_V6);
  });

  it("formats Host authority with IPv6 brackets and non-default ports", () => {
    expect(
      formatHostAuthority({
        hostname: PUBLIC_V6_LITERAL,
        port: 443,
        scheme: "https",
      }),
    ).toBe(`[${PUBLIC_V6_LITERAL}]`);
    expect(
      formatHostAuthority({
        hostname: PUBLIC_V6,
        port: 8443,
        scheme: "https",
      }),
    ).toBe(`[${PUBLIC_V6}]:8443`);
    expect(
      formatHostAuthority({ hostname: "cdn.example.test", port: 8080, scheme: "http" }),
    ).toBe("cdn.example.test:8080");
  });
});

describe("CR-004 URL / port policy", () => {
  it("parses and allows bracketed public IPv6 literals", () => {
    const parsed = parseMetadataUrl(`https://[${PUBLIC_V6_LITERAL}]/meta.json`);
    expect(isUrlPolicyError(parsed)).toBe(false);
    if (!isUrlPolicyError(parsed)) {
      expect(parsed.host_is_ip_literal).toBe(true);
      expect(parsed.hostname).toBe(PUBLIC_V6);
      expect(parsed.host_authority).toBe(`[${PUBLIC_V6}]`);
      expect(parsed.url.hostname.replace(/^\[|\]$/g, "")).toBe(PUBLIC_V6_LITERAL);
      expect(parsed.host_authority.startsWith("[")).toBe(true);
      expect(parsed.host_authority.endsWith("]")).toBe(true);
    }
  });

  it("denies non-allowlisted ports by default", () => {
    const parsed = parseMetadataUrl("https://cdn.example.test:8080/meta.json");
    expect(isUrlPolicyError(parsed)).toBe(true);
    if (isUrlPolicyError(parsed)) {
      expect(parsed.reason).toBe("denied_port");
    }
  });

  it("permits controlled port override for approved gateways/tests", () => {
    const parsed = parseMetadataUrl("https://cdn.example.test:8080/meta.json", {
      allowed_ports: [80, 443, 8080],
    });
    expect(isUrlPolicyError(parsed)).toBe(false);
    if (!isUrlPolicyError(parsed)) {
      expect(parsed.port).toBe(8080);
      expect(parsed.host_authority).toBe("cdn.example.test:8080");
    }
  });
});

describe("CR-004 retrieveMetadata hostile fixtures", () => {
  it("refuses unsupported URI schemes", async () => {
    const ports = createHermeticPorts({ dns: {}, transport: {} });
    const result = await retrieveMetadata(
      { uri: "file:///etc/passwd", purpose: "collection_metadata", now: fixedNow },
      { ports },
    );
    expect(result.outcome).toBe("partial");
    if (result.outcome === "partial") {
      expect(result.reason).toBe("unsupported_scheme");
    }
  });

  it("refuses credentials embedded in the URI without leaking secrets", async () => {
    const secret = "super-secret-password";
    const ports = createHermeticPorts({ dns: {}, transport: {} });
    const result = await retrieveMetadata(
      {
        uri: `https://user:${secret}@cdn.example.test/meta.json`,
        purpose: "collection_metadata",
        now: fixedNow,
      },
      { ports },
    );
    expect(result.outcome).toBe("partial");
    if (result.outcome === "partial") {
      expect(result.reason).toBe("ambiguous_host");
      expect(result.safe_message).not.toContain(secret);
      expect(result.provenance.requested_uri).not.toContain(secret);
      expect(result.provenance.requested_uri).not.toContain("user:");
      assertNoInjectedSecrets(result, [secret]);
    }
  });

  it("redacts query tokens and fragments from provenance digests", async () => {
    const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";
    const ports = createHermeticPorts({
      dns: {
        "cdn.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        [`https://cdn.example.test/meta.json?access_token=${token}`]: {
          kind: "response",
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Ok" }),
        },
      },
    });
    const result = await retrieveMetadata(
      {
        uri: `https://cdn.example.test/meta.json?access_token=${token}#frag-secret`,
        purpose: "collection_metadata",
        now: fixedNow,
      },
      { ports },
    );
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") {
      expect(result.provenance.requested_uri).toBe(
        "https://cdn.example.test/meta.json",
      );
      expect(result.provenance.requested_uri).not.toContain(token);
      expect(result.provenance.requested_uri).not.toContain("frag-secret");
      expect(result.provenance.final_url).not.toContain(token);
      expect(result.provenance.content_sha256).toBe(sha256Hex(result.body));
      expect(result.provenance.terminal_address_class).toBe("public_ipv4");
      assertNoInjectedSecrets(result, [token, "frag-secret"]);
    }
  });

  it("denies direct SSRF to private / loopback / metadata IPs", async () => {
    for (const uri of [
      `http://${PRIVATE_V4}/latest/meta-data`,
      `http://${LOOPBACK_V4}/`,
      `http://${LINK_LOCAL_V4}/latest/meta-data`,
      `http://${CGNAT_V4}/`,
      `http://${RELAY_ANYCAST_V4}/`,
      `http://${RELAY_ANYCAST_V4_6A44}/`,
      "http://192.88.99.2/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://[64:ff9b::10.0.0.1]/",
      "http://[100::1]/",
      "http://[5f00::1]/",
      "http://[3fff::1]/",
    ]) {
      const ports = createHermeticPorts({ dns: {}, transport: {} });
      const result = await retrieveMetadata(
        { uri, purpose: "collection_metadata", now: fixedNow },
        { ports },
      );
      expect(result.outcome).toBe("partial");
      if (result.outcome === "partial") {
        expect(["denied_address", "ambiguous_host"]).toContain(result.reason);
      }
    }
  });

  it("never calls transport for 6to4 relay anycast resolutions", async () => {
    let transportCalls = 0;
    const ports = createHermeticPorts({
      dns: {
        "relay.example.test": [{ address: RELAY_ANYCAST_V4_6A44, family: "ipv4" }],
      },
      transport: {
        "https://relay.example.test/meta.json": {
          kind: "response",
          status: 200,
          headers: { "content-type": "application/json" },
          body: "{}",
          capture: () => {
            transportCalls += 1;
          },
        },
      },
    });
    const result = await retrieveMetadata(
      {
        uri: "https://relay.example.test/meta.json",
        purpose: "collection_metadata",
        now: fixedNow,
      },
      { ports },
    );
    expect(result.outcome).toBe("partial");
    if (result.outcome === "partial") {
      expect(result.reason).toBe("denied_address");
    }
    expect(transportCalls).toBe(0);
  });

  it("allows public bracketed IPv6 literal with Host brackets and SNI hostname", async () => {
    let captured: TransportRequest | undefined;
    const ports = createHermeticPorts({
      dns: {},
      transport: {
        [`https://[${PUBLIC_V6}]/meta.json`]: {
          kind: "response",
          status: 200,
          headers: { "content-type": "application/json" },
          body: "{}",
          capture: (request) => {
            captured = request;
          },
        },
        [`https://${PUBLIC_V6}/meta.json`]: {
          kind: "response",
          status: 200,
          headers: { "content-type": "application/json" },
          body: "{}",
          capture: (request) => {
            captured = request;
          },
        },
      },
    });
    const result = await retrieveMetadata(
      {
        uri: `https://[${PUBLIC_V6_LITERAL}]/meta.json`,
        purpose: "collection_metadata",
        now: fixedNow,
      },
      { ports },
    );
    expect(result.outcome).toBe("ok");
    expect(captured).toBeDefined();
    expect(captured!.headers.host).toBe(`[${PUBLIC_V6}]`);
    expect(captured!.target.hostname).toBe(PUBLIC_V6);
    expect(captured!.target.pinned_address).toBe(PUBLIC_V6);
    expect(captured!.target.terminal_address_class).toBe("public_ipv6");
  });

  it("denies mixed public/private DNS answers (fail closed)", async () => {
    const ports = createHermeticPorts({
      dns: {
        "mixed.example.test": [
          { address: PUBLIC_V4, family: "ipv4" },
          { address: PRIVATE_V4, family: "ipv4" },
        ],
      },
      transport: {},
    });
    const result = await retrieveMetadata(
      {
        uri: "https://mixed.example.test/meta.json",
        purpose: "collection_metadata",
        now: fixedNow,
      },
      { ports },
    );
    expect(result.outcome).toBe("partial");
    if (result.outcome === "partial") {
      expect(result.reason).toBe("denied_address");
    }
  });

  it("denies DNS rebinding across redirect hops", async () => {
    const ports = createHermeticPorts({
      dns: {
        "rebind.example.test": {
          sequence: [
            [{ address: PUBLIC_V4, family: "ipv4" }],
            [{ address: PRIVATE_V4, family: "ipv4" }],
          ],
        },
      },
      transport: {
        "https://rebind.example.test/start": {
          kind: "response",
          status: 302,
          headers: { location: "https://rebind.example.test/next" },
        },
      },
    });
    const result = await retrieveMetadata(
      {
        uri: "https://rebind.example.test/start",
        purpose: "collection_metadata",
        now: fixedNow,
      },
      { ports },
    );
    expect(result.outcome).toBe("partial");
    if (result.outcome === "partial") {
      expect(result.reason).toBe("denied_address");
      expect(result.provenance.redirect_count).toBeGreaterThanOrEqual(1);
    }
  });

  it("denies redirect to a private host", async () => {
    const ports = createHermeticPorts({
      dns: {
        "cdn.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://cdn.example.test/meta.json": {
          kind: "response",
          status: 302,
          headers: { location: `http://${LINK_LOCAL_V4}/latest/meta-data` },
        },
      },
    });
    const result = await retrieveMetadata(
      {
        uri: "https://cdn.example.test/meta.json",
        purpose: "collection_metadata",
        now: fixedNow,
      },
      { ports },
    );
    expect(result.outcome).toBe("partial");
    if (result.outcome === "partial") {
      expect(result.reason).toBe("denied_address");
    }
  });

  it("returns typed partial for malformed redirect Location (never throws)", async () => {
    const ports = createHermeticPorts({
      dns: {
        "cdn.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://cdn.example.test/meta.json": {
          kind: "response",
          status: 302,
          headers: { location: "https://[not-a-valid-ipv6" },
        },
      },
    });
    await expect(
      retrieveMetadata(
        {
          uri: "https://cdn.example.test/meta.json",
          purpose: "collection_metadata",
          now: fixedNow,
        },
        { ports },
      ),
    ).resolves.toMatchObject({
      outcome: "partial",
      reason: "invalid_redirect",
    });
  });

  it("revalidates allowed-port policy on every redirect", async () => {
    const ports = createHermeticPorts({
      dns: {
        "cdn.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://cdn.example.test/meta.json": {
          kind: "response",
          status: 302,
          headers: { location: "https://cdn.example.test:8443/next" },
        },
      },
    });
    const result = await retrieveMetadata(
      {
        uri: "https://cdn.example.test/meta.json",
        purpose: "collection_metadata",
        now: fixedNow,
      },
      { ports },
    );
    expect(result.outcome).toBe("partial");
    if (result.outcome === "partial") {
      expect(result.reason).toBe("denied_port");
    }
  });

  it("denies IPv4-mapped IPv6 bypass answers", async () => {
    const ports = createHermeticPorts({
      dns: {
        "mapped.example.test": [{ address: MAPPED_LOOPBACK, family: "ipv6" }],
      },
      transport: {},
    });
    const result = await retrieveMetadata(
      {
        uri: "https://mapped.example.test/meta.json",
        purpose: "collection_metadata",
        now: fixedNow,
      },
      { ports },
    );
    expect(result.outcome).toBe("partial");
    if (result.outcome === "partial") {
      expect(result.reason).toBe("denied_address");
    }
  });

  it("rejects ambiguous non-canonical IPv4 host forms", async () => {
    const ports = createHermeticPorts({ dns: {}, transport: {} });
    for (const uri of [
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      // These canonicalize to public 1.1.1.1, so a later address-policy deny
      // cannot accidentally make the raw-spelling test pass.
      "http://001.001.001.001/",
      "http://16843009/",
      "http://0x01010101/",
    ]) {
      const parsed = parseMetadataUrl(uri);
      expect(isUrlPolicyError(parsed)).toBe(true);
      if (isUrlPolicyError(parsed)) {
        expect(parsed.reason).toBe("ambiguous_host");
      }
      const result = await retrieveMetadata(
        { uri, purpose: "collection_metadata", now: fixedNow },
        { ports },
      );
      expect(result.outcome).toBe("partial");
      if (result.outcome === "partial") {
        expect(result.reason).toBe("ambiguous_host");
      }
    }

    const canonical = parseMetadataUrl("http://1.1.1.1/");
    expect(isUrlPolicyError(canonical)).toBe(false);
    if (!isUrlPolicyError(canonical)) {
      expect(canonical.hostname).toBe("1.1.1.1");
      expect(canonical.host_is_ip_literal).toBe(true);
    }
  });

  it("bounds redirect loops", async () => {
    const ports = createHermeticPorts({
      dns: {
        "loop.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://loop.example.test/a": {
          kind: "response",
          status: 302,
          headers: { location: "https://loop.example.test/b" },
        },
        "https://loop.example.test/b": {
          kind: "response",
          status: 302,
          headers: { location: "https://loop.example.test/a" },
        },
      },
    });
    const result = await retrieveMetadata(
      { uri: "https://loop.example.test/a", purpose: "collection_metadata", now: fixedNow },
      { ports },
    );
    expect(result.outcome).toBe("partial");
    if (result.outcome === "partial") {
      expect(result.reason).toBe("redirect_loop");
    }
  });

  it("bounds redirect count", async () => {
    const ports = createHermeticPorts({
      dns: {
        "chain.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://chain.example.test/0": {
          kind: "response",
          status: 302,
          headers: { location: "https://chain.example.test/1" },
        },
        "https://chain.example.test/1": {
          kind: "response",
          status: 302,
          headers: { location: "https://chain.example.test/2" },
        },
        "https://chain.example.test/2": {
          kind: "response",
          status: 302,
          headers: { location: "https://chain.example.test/3" },
        },
        "https://chain.example.test/3": {
          kind: "response",
          status: 302,
          headers: { location: "https://chain.example.test/4" },
        },
      },
    });
    const result = await retrieveMetadata(
      { uri: "https://chain.example.test/0", purpose: "collection_metadata", now: fixedNow },
      {
        ports,
        limits: { ...DEFAULT_METADATA_EGRESS_LIMITS, max_redirects: 3 },
      },
    );
    expect(result.outcome).toBe("partial");
    if (result.outcome === "partial") {
      expect(result.reason).toBe("redirect_limit");
    }
  });

  it("rejects decompression expansion bombs", async () => {
    const bomb = gzipBomb(2_000_000);
    const ports = createHermeticPorts({
      dns: {
        "bomb.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://bomb.example.test/meta.json": {
          kind: "response",
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
          },
          body: bomb,
        },
      },
    });
    const result = await retrieveMetadata(
      {
        uri: "https://bomb.example.test/meta.json",
        purpose: "collection_metadata",
        now: fixedNow,
      },
      {
        ports,
        limits: {
          ...DEFAULT_METADATA_EGRESS_LIMITS,
          max_compressed_bytes: 256 * 1024,
          max_decompressed_bytes: 1024,
        },
      },
    );
    expect(result.outcome).toBe("partial");
    if (result.outcome === "partial") {
      expect(result.reason).toBe("decompressed_size_exceeded");
    }
  });

  it("maps slow connect stages to typed timeouts", async () => {
    const ports = createHermeticPorts({
      dns: {
        "slow.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://slow.example.test/meta.json": {
          kind: "error",
          message: "connect timeout",
        },
      },
    });
    const result = await retrieveMetadata(
      {
        uri: "https://slow.example.test/meta.json",
        purpose: "collection_metadata",
        now: fixedNow,
      },
      { ports },
    );
    expect(result.outcome).toBe("partial");
    if (result.outcome === "partial") {
      expect(result.reason).toBe("connect_timeout");
    }
  });

  it("never forwards ambient cookies, auth, or cloud credential headers", async () => {
    let captured: TransportRequest | undefined;
    const ports = createHermeticPorts({
      dns: {
        "safe.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://safe.example.test/meta.json": {
          kind: "response",
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Ok", image: "https://img.example.test/img.png" }),
          capture: (request) => {
            captured = request;
          },
        },
      },
    });

    const ambient = {
      Authorization: "Bearer leaked-token",
      Cookie: "session=evil",
      "Proxy-Authorization": "Basic YTpi",
      "X-Aws-Ec2-Metadata-Token": "imds-token",
      "Metadata-Flavor": "Google",
    };
    expect(Object.keys(sanitizeCallerHeaders(ambient))).toEqual([]);

    const result = await retrieveMetadata(
      {
        uri: "https://safe.example.test/meta.json",
        purpose: "collection_metadata",
        now: fixedNow,
      },
      { ports, ambient_headers: ambient },
    );
    expect(result.outcome).toBe("ok");
    expect(captured).toBeDefined();
    const headerNames = Object.keys(captured!.headers).map((h) => h.toLowerCase());
    expect(headerNames).not.toContain("authorization");
    expect(headerNames).not.toContain("cookie");
    expect(headerNames).not.toContain("proxy-authorization");
    expect(headerNames).not.toContain("x-aws-ec2-metadata-token");
    expect(headerNames).not.toContain("metadata-flavor");
    expect(captured!.headers.host).toBe("safe.example.test");
    expect(JSON.stringify(captured!.headers)).not.toContain("leaked-token");
    expect(JSON.stringify(captured!.headers)).not.toContain("imds-token");
  });

  it("rejects HTML/SVG including BOM, comments, and polyglot forms", async () => {
    const bomHtml = Uint8Array.from([
      0xef, 0xbb, 0xbf,
      ...Buffer.from("<html><script>alert(1)</script></html>", "utf8"),
    ]);
    const commented = Uint8Array.from(
      Buffer.from(
        "<!-- decoy -->\n<!DOCTYPE html><html><body>x</body></html>",
        "utf8",
      ),
    );
    const utf16 = Buffer.from("<html>utf16</html>", "utf16le");
    const utf16Bom = Uint8Array.from([0xff, 0xfe, ...utf16]);
    const utf16BeHtml = utf16be("<html>utf16-be</html>");
    const utf16BeSvg = utf16be("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    const polyglot = Uint8Array.from(
      Buffer.from('{"ok":true}\n<html><script>x</script></html>', "utf8"),
    );

    expect(sniffHostilePayload(bomHtml).hostile).toBe(true);
    expect(sniffHostilePayload(commented).hostile).toBe(true);
    expect(sniffHostilePayload(utf16Bom).hostile).toBe(true);
    expect(sniffHostilePayload(utf16BeHtml).hostile).toBe(true);
    expect(sniffHostilePayload(utf16BeSvg).hostile).toBe(true);
    expect(sniffHostilePayload(polyglot).hostile).toBe(true);

    const ports = createHermeticPorts({
      dns: {
        "hostile.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://hostile.example.test/page.html": {
          kind: "response",
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<html><script>alert(1)</script></html>",
        },
        "https://hostile.example.test/icon.svg": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/svg+xml" },
          body: "<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>",
        },
        "https://hostile.example.test/smuggle.png": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/png" },
          body: "<svg xmlns='http://www.w3.org/2000/svg'><desc>nope</desc></svg>",
        },
        "https://hostile.example.test/bom.json": {
          kind: "response",
          status: 200,
          headers: { "content-type": "application/json" },
          body: bomHtml,
        },
        "https://hostile.example.test/poly.json": {
          kind: "response",
          status: 200,
          headers: { "content-type": "application/json" },
          body: polyglot,
        },
        "https://hostile.example.test/utf16be.json": {
          kind: "response",
          status: 200,
          headers: { "content-type": "application/json" },
          body: utf16BeHtml,
        },
        "https://hostile.example.test/utf16be.txt": {
          kind: "response",
          status: 200,
          headers: { "content-type": "text/plain" },
          body: utf16BeSvg,
        },
      },
    });

    for (const [uri, reason] of [
      ["https://hostile.example.test/page.html", "hostile_content"],
      ["https://hostile.example.test/icon.svg", "hostile_content"],
      ["https://hostile.example.test/smuggle.png", "hostile_content"],
      ["https://hostile.example.test/bom.json", "hostile_content"],
      ["https://hostile.example.test/poly.json", "hostile_content"],
      ["https://hostile.example.test/utf16be.json", "hostile_content"],
      ["https://hostile.example.test/utf16be.txt", "hostile_content"],
    ] as const) {
      const result = await retrieveMetadata(
        {
          uri,
          purpose: uri.includes("smuggle") || uri.includes("icon")
            ? "collection_image"
            : "collection_metadata",
          now: fixedNow,
        },
        { ports },
      );
      expect(result.outcome).toBe("partial");
      if (result.outcome === "partial") expect(result.reason).toBe(reason);
    }
  });

  it("trusts PNG-only after structure proof; all other image types fail closed", async () => {
    expect([...TRUSTED_IMAGE_KINDS]).toEqual(["png"]);
    expect(detectImageKind(FIXTURE_PNG)).toBe("png");
    expect(detectImageKind(FIXTURE_JPEG)).toBeUndefined();
    expect(detectImageKind(FIXTURE_GIF)).toBeUndefined();
    expect(detectImageKind(FIXTURE_WEBP_FRAMING_ONLY)).toBeUndefined();
    expect(detectImageKind(FIXTURE_AVIF_FRAMING_ONLY)).toBeUndefined();

    expect(validateImageStructure("png", FIXTURE_PNG).ok).toBe(true);
    expect(validatePngStructure(FIXTURE_PNG).ok).toBe(true);
    // Peek may diagnose denied formats; structure never promotes them.
    expect(peekImageMagic(FIXTURE_JPEG)).toBe("jpeg");
    {
      const jpegDenied = validateImageStructure("jpeg", FIXTURE_JPEG);
      expect(jpegDenied.ok).toBe(false);
      if (!jpegDenied.ok) expect(jpegDenied.failure).toBe("unsupported");
    }
    expect(peekImageMagic(FIXTURE_GIF)).toBe("gif");
    {
      const gifDenied = validateImageStructure("gif", FIXTURE_GIF);
      expect(gifDenied.ok).toBe(false);
      if (!gifDenied.ok) expect(gifDenied.failure).toBe("unsupported");
    }
    expect(validateImageStructure("webp", FIXTURE_WEBP_FRAMING_ONLY).ok).toBe(false);
    expect(validateImageStructure("avif", FIXTURE_AVIF_FRAMING_ONLY).ok).toBe(false);

    expect(
      evaluateContentType({ purpose: "collection_image", content_type: "image/png" }).ok,
    ).toBe(true);
    for (const denied of [
      "image/jpeg",
      "image/jpg",
      "image/gif",
      "image/webp",
      "image/avif",
      "image/svg+xml",
    ]) {
      const evaled = evaluateContentType({
        purpose: "collection_image",
        content_type: denied,
      });
      expect(evaled.ok).toBe(false);
      if (!evaled.ok) {
        expect(["content_type_denied", "hostile_content"]).toContain(evaled.reason);
      }
    }

    // Accept headers: explicit allowlist only — no wildcard, no denied image MIME.
    const deniedImageMime = /\*\/\*|jpeg|jpg|gif|webp|avif|svg/i;
    for (const purpose of [
      "collection_metadata",
      "collection_image",
      "report_enrichment",
    ] as const) {
      const accept = buildEgressRequestHeaders({
        purpose,
        host_authority: "cdn.example.test",
      }).accept;
      expect(accept).not.toMatch(deniedImageMime);
    }
    expect(buildEgressRequestHeaders({
      purpose: "collection_metadata",
      host_authority: "meta.example.test",
    }).accept).toBe("application/json, application/ld+json, text/plain;q=0.5");
    expect(buildEgressRequestHeaders({
      purpose: "collection_image",
      host_authority: "img.example.test",
    }).accept).toBe("image/png");
    expect(buildEgressRequestHeaders({
      purpose: "report_enrichment",
      host_authority: "cdn.example.test",
    }).accept).toBe(
      "application/json, application/ld+json, text/plain;q=0.5, image/png",
    );

    // Framing-only PNG without IDAT.
    const pngNoIdat = Uint8Array.from([
      ...pngSig,
      ...pngChunk(
        "IHDR",
        new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
      ),
      ...pngChunk("IEND", new Uint8Array()),
    ]);
    expect(validateImageStructure("png", pngNoIdat).ok).toBe(false);

    // Indexed color (type 3) fails closed — no palette/index proof in this boundary.
    const indexedNoPlte = buildPng({
      ihdr: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 3, 0, 0, 0]),
      idat: deflateBytes(new Uint8Array([0, 0])),
    });
    {
      const indexedDenied = validatePngStructure(indexedNoPlte);
      expect(indexedDenied.ok).toBe(false);
      if (!indexedDenied.ok) expect(indexedDenied.failure).toBe("unsupported");
    }
    const indexedWithPlte = buildPng({
      ihdr: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 3, 0, 0, 0]),
      beforeIdat: [pngChunk("PLTE", new Uint8Array([0, 0, 0, 255, 255, 255]))],
      idat: deflateBytes(new Uint8Array([0, 0])),
    });
    {
      const indexedPlteDenied = validatePngStructure(indexedWithPlte);
      expect(indexedPlteDenied.ok).toBe(false);
      if (!indexedPlteDenied.ok) expect(indexedPlteDenied.failure).toBe("unsupported");
    }

    // Truecolor optional PLTE before IDAT with valid entry count accepts.
    const truecolorWithPlte = buildPng({
      ihdr: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
      beforeIdat: [pngChunk("PLTE", new Uint8Array([0, 0, 0, 255, 255, 255]))],
      idat: deflateBytes(new Uint8Array([0, 0, 0, 0])),
    });
    expect(validatePngStructure(truecolorWithPlte).ok).toBe(true);

    // Grayscale + PLTE prohibited.
    const grayWithPlte = buildPng({
      ihdr: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]),
      beforeIdat: [pngChunk("PLTE", new Uint8Array([0, 0, 0]))],
      idat: deflateBytes(new Uint8Array([0, 0])),
    });
    expect(validatePngStructure(grayWithPlte).ok).toBe(false);

    // CRC-valid unknown critical chunk rejected (uppercase first byte).
    const unknownCritical = buildPng({
      ihdr: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
      beforeIdat: [pngChunk("CUST", new Uint8Array([1, 2, 3]))],
      idat: deflateBytes(new Uint8Array([0, 0, 0, 0])),
    });
    {
      const unknownCrit = validatePngStructure(unknownCritical);
      expect(unknownCrit.ok).toBe(false);
      if (!unknownCrit.ok) expect(unknownCrit.failure).toBe("unsupported");
    }

    // CRC-valid chunk with reserved bit set (3rd byte lowercase) rejected.
    const reservedBitSet = buildPng({
      ihdr: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
      beforeIdat: [pngChunk("tEmP", new Uint8Array([0]))],
      idat: deflateBytes(new Uint8Array([0, 0, 0, 0])),
    });
    {
      const reservedDenied = validatePngStructure(reservedBitSet);
      expect(reservedDenied.ok).toBe(false);
      if (!reservedDenied.ok) {
        expect(reservedDenied.failure).toBe("bad_framing");
        expect(reservedDenied.safe_message).toMatch(/reserved bit/i);
      }
    }

    // Interlaced PNG rejected (Adam7 proof deliberately out of scope).
    const interlaced = buildPng({
      ihdr: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 1]),
      idat: deflateBytes(new Uint8Array([0, 0, 0, 0])),
    });
    expect(validatePngStructure(interlaced).ok).toBe(false);
    {
      const interlacedDenied = validatePngStructure(interlaced);
      if (!interlacedDenied.ok) expect(interlacedDenied.failure).toBe("unsupported");
    }

    // valid-zlib + TRAIL inside IDAT must reject (exact stream consume).
    const idatExact = FIXTURE_PNG.subarray(41, 53);
    const idatWithTrail = Uint8Array.from([...idatExact, ...Buffer.from("TRAIL", "ascii")]);
    const pngZlibTrail = Uint8Array.from([
      ...pngSig,
      ...FIXTURE_PNG.subarray(8, 33), // IHDR chunk
      ...pngChunk("IDAT", idatWithTrail),
      ...pngChunk("IEND", new Uint8Array()),
    ]);
    const trailResult = validatePngStructure(pngZlibTrail);
    expect(trailResult.ok).toBe(false);
    if (!trailResult.ok) {
      expect(trailResult.safe_message).toMatch(/zlib stream did not consume|zlib\/deflate/i);
    }

    const ports = createHermeticPorts({
      dns: {
        "img.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://img.example.test/fake.png": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/png" },
          body: JSON.stringify({ not: "an image" }),
        },
        "https://img.example.test/ok.png": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/png" },
          body: FIXTURE_PNG,
        },
        "https://img.example.test/ok.jpg": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/jpeg" },
          body: FIXTURE_JPEG,
        },
        "https://img.example.test/ok.gif": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/gif" },
          body: FIXTURE_GIF,
        },
        "https://img.example.test/ok.webp": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/webp" },
          body: FIXTURE_WEBP_FRAMING_ONLY,
        },
        "https://img.example.test/ok.avif": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/avif" },
          body: FIXTURE_AVIF_FRAMING_ONLY,
        },
      },
    });

    const fake = await retrieveMetadata(
      {
        uri: "https://img.example.test/fake.png",
        purpose: "collection_image",
        now: fixedNow,
      },
      { ports },
    );
    expect(fake.outcome).toBe("partial");
    if (fake.outcome === "partial") expect(fake.reason).toBe("hostile_content");

    const okPng = await retrieveMetadata(
      {
        uri: "https://img.example.test/ok.png",
        purpose: "collection_image",
        now: fixedNow,
      },
      { ports },
    );
    expect(okPng.outcome).toBe("ok");
    if (okPng.outcome === "ok") {
      expect(okPng.provenance.content_sha256).toBe(sha256Hex(FIXTURE_PNG));
    }

    for (const path of ["ok.jpg", "ok.gif", "ok.webp", "ok.avif"] as const) {
      const denied = await retrieveMetadata(
        {
          uri: `https://img.example.test/${path}`,
          purpose: "collection_image",
          now: fixedNow,
        },
        { ports },
      );
      expect(denied.outcome).toBe("partial");
      if (denied.outcome === "partial") {
        expect(denied.reason).toBe("content_type_denied");
      }
    }
  });

  it("rejects signature-only / truncated / framing-only / embedded-markup image payloads", async () => {
    const pngPlusHtml = Uint8Array.from([
      ...FIXTURE_PNG,
      ...Buffer.from("<html>polyglot</html>", "utf8"),
    ]);
    const pngPlusSvg = Uint8Array.from([
      ...FIXTURE_PNG,
      ...Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>", "utf8"),
    ]);
    const jpegSoiOnly = new Uint8Array([0xff, 0xd8, 0xff]);
    const riffZeroWebp = Uint8Array.from(Buffer.from("RIFF\0\0\0\0WEBP", "binary"));
    const gifHeaderOnly = Uint8Array.from(Buffer.from("GIF89a", "ascii"));

    // PNG textual metadata chunks are rejected entirely (no text-decompress surface).
    // Failure must hold whether markup is detectable or not.
    const assertTextChunkRejected = (body: Uint8Array) => {
      const structure = validatePngStructure(body);
      expect(structure.ok).toBe(false);
      if (!structure.ok) {
        expect(structure.failure).toBe("unsupported");
        expect(structure.safe_message).toMatch(/tEXt|zTXt|iTXt|textual/i);
      }
      expect(
        evaluateRetrievedContent({
          purpose: "collection_image",
          content_type: "image/png",
          body,
        }).ok,
      ).toBe(false);
    };

    // CRC-valid tEXt with hostile ASCII markup.
    const textPayload = Uint8Array.from(
      Buffer.from("Comment\0<html><script>x</script></html>", "utf8"),
    );
    const pngWithHtmlText = Uint8Array.from([
      ...pngSig,
      ...FIXTURE_PNG.subarray(8, 33), // IHDR chunk
      ...pngChunk("tEXt", textPayload),
      ...FIXTURE_PNG.subarray(33), // IDAT + IEND
    ]);
    assertTextChunkRejected(pngWithHtmlText);

    // CRC-valid benign tEXt (no markup) still rejected.
    const benignText = Uint8Array.from(Buffer.from("Comment\0hello", "utf8"));
    assertTextChunkRejected(
      Uint8Array.from([
        ...pngSig,
        ...FIXTURE_PNG.subarray(8, 33),
        ...pngChunk("tEXt", benignText),
        ...FIXTURE_PNG.subarray(33),
      ]),
    );

    // CRC-valid tEXt carrying UTF-16LE hostile markup.
    const textUtf16Le = Uint8Array.from([
      ...Buffer.from("Comment\0", "ascii"),
      ...utf16le("<html><body>x</body></html>"),
    ]);
    const pngTextUtf16Le = Uint8Array.from([
      ...pngSig,
      ...FIXTURE_PNG.subarray(8, 33),
      ...pngChunk("tEXt", textUtf16Le),
      ...FIXTURE_PNG.subarray(33),
    ]);
    assertTextChunkRejected(pngTextUtf16Le);

    // CRC-valid tEXt carrying UTF-16BE hostile markup (with BOM).
    const textUtf16Be = Uint8Array.from([
      ...Buffer.from("Comment\0", "ascii"),
      0xfe, 0xff,
      ...utf16be("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
    ]);
    assertTextChunkRejected(
      Uint8Array.from([
        ...pngSig,
        ...FIXTURE_PNG.subarray(8, 33),
        ...pngChunk("tEXt", textUtf16Be),
        ...FIXTURE_PNG.subarray(33),
      ]),
    );

    // CRC-valid zTXt with zlib-compressed hostile HTML.
    const ztxtPayload = Uint8Array.from([
      ...Buffer.from("Comment\0", "ascii"),
      0x00, // compression method
      ...deflateBytes("<html><script>alert(1)</script></html>"),
    ]);
    const pngZtxt = Uint8Array.from([
      ...pngSig,
      ...FIXTURE_PNG.subarray(8, 33),
      ...pngChunk("zTXt", ztxtPayload),
      ...FIXTURE_PNG.subarray(33),
    ]);
    assertTextChunkRejected(pngZtxt);

    // CRC-valid benign zTXt (compressed, no markup) still rejected.
    const ztxtBenign = Uint8Array.from([
      ...Buffer.from("Comment\0", "ascii"),
      0x00,
      ...deflateBytes(" innocuous"),
    ]);
    assertTextChunkRejected(
      Uint8Array.from([
        ...pngSig,
        ...FIXTURE_PNG.subarray(8, 33),
        ...pngChunk("zTXt", ztxtBenign),
        ...FIXTURE_PNG.subarray(33),
      ]),
    );

    // CRC-valid iTXt with uncompressed UTF-8 hostile SVG.
    const itxtPayload = Uint8Array.from([
      ...Buffer.from("Comment\0", "ascii"),
      0x00, 0x00, // compression flag + method
      0x00, // empty language
      0x00, // empty translated keyword
      ...Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>", "utf8"),
    ]);
    const pngItxt = Uint8Array.from([
      ...pngSig,
      ...FIXTURE_PNG.subarray(8, 33),
      ...pngChunk("iTXt", itxtPayload),
      ...FIXTURE_PNG.subarray(33),
    ]);
    assertTextChunkRejected(pngItxt);

    // Compressed iTXt with UTF-16LE payload bytes — rejected without decompressing.
    const itxtCompressedUtf16Le = Uint8Array.from([
      ...Buffer.from("Comment\0", "ascii"),
      0x01, 0x00, // compressed, method 0
      0x00, // empty language
      0x00, // empty translated keyword
      ...deflateBytes(utf16le("<html><body>x</body></html>")),
    ]);
    assertTextChunkRejected(
      Uint8Array.from([
        ...pngSig,
        ...FIXTURE_PNG.subarray(8, 33),
        ...pngChunk("iTXt", itxtCompressedUtf16Le),
        ...FIXTURE_PNG.subarray(33),
      ]),
    );

    // Compressed iTXt with UTF-16BE payload bytes — rejected without decompressing.
    const itxtCompressedUtf16Be = Uint8Array.from([
      ...Buffer.from("Comment\0", "ascii"),
      0x01, 0x00,
      0x00,
      0x00,
      ...deflateBytes(
        Uint8Array.from([0xfe, 0xff, ...utf16be("<svg xmlns='x'></svg>")]),
      ),
    ]);
    assertTextChunkRejected(
      Uint8Array.from([
        ...pngSig,
        ...FIXTURE_PNG.subarray(8, 33),
        ...pngChunk("iTXt", itxtCompressedUtf16Be),
        ...FIXTURE_PNG.subarray(33),
      ]),
    );

    // UTF-16LE body with BOM (not PNG) — still flagged by embedded sniff.
    const utf16LeBomHostile = Uint8Array.from([
      0xff, 0xfe,
      ...utf16le("<html><head></head></html>"),
    ]);
    expect(sniffEmbeddedHostileInImageBody(utf16LeBomHostile).hostile).toBe(true);
    expect(sniffHostilePayload(utf16LeBomHostile).hostile).toBe(true);

    // Denied-format bodies with embedded markup still fail closed (typed partial).
    const appPayload = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>", "utf8");
    const jpegWithSvgApp = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe1,
      (appPayload.byteLength + 2) >> 8,
      (appPayload.byteLength + 2) & 0xff,
      ...appPayload,
      ...FIXTURE_JPEG.subarray(2),
    ]);
    expect(sniffEmbeddedHostileInImageBody(jpegWithSvgApp).hostile).toBe(true);

    const gifWithComment = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
      0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
      0x21, 0xfe, // comment extension
      0x0c, ...Buffer.from("<html>bad!!", "utf8"),
      0x00,
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0x02, 0x02, 0x4c, 0x01, 0x00,
      0x3b,
    ]);
    expect(sniffEmbeddedHostileInImageBody(gifWithComment).hostile).toBe(true);

    // WebP/AVIF framing-only + unaligned brand spoof never trusted.
    expect(peekImageMagic(FIXTURE_WEBP_FRAMING_ONLY)).toBe("webp");
    expect(validateImageStructure("webp", FIXTURE_WEBP_FRAMING_ONLY).ok).toBe(false);
    const avifBrandSpoof = Uint8Array.from(
      Buffer.from("xxxxftypxxxxavifxxxx", "ascii"),
    );
    expect(peekImageMagic(avifBrandSpoof)).toBeUndefined();
    expect(validateImageStructure("avif", FIXTURE_AVIF_FRAMING_ONLY).ok).toBe(false);

    // Magic may peek, but structural validation must fail — never trusted.
    expect(peekImageMagic(pngPlusHtml)).toBe("png");
    expect(detectImageKind(pngPlusHtml)).toBeUndefined();
    expect(validateImageStructure("png", pngPlusHtml).ok).toBe(false);
    expect(detectImageKind(pngPlusSvg)).toBeUndefined();
    expect(detectImageKind(jpegSoiOnly)).toBeUndefined();
    expect(validateImageStructure("jpeg", jpegSoiOnly).ok).toBe(false);
    expect(detectImageKind(riffZeroWebp)).toBeUndefined();
    expect(validateImageStructure("webp", riffZeroWebp).ok).toBe(false);
    expect(detectImageKind(gifHeaderOnly)).toBeUndefined();
    expect(validateImageStructure("gif", gifHeaderOnly).ok).toBe(false);

    // Malformed lengths / missing terminators.
    const pngBadLength = Uint8Array.from([
      ...pngSig,
      0xff, 0xff, 0xff, 0xff, // absurd length
      0x49, 0x48, 0x44, 0x52,
    ]);
    expect(validateImageStructure("png", pngBadLength).ok).toBe(false);

    const webpTrailing = Uint8Array.from([
      ...FIXTURE_WEBP_FRAMING_ONLY,
      ...Buffer.from("<html>x</html>", "utf8"),
    ]);
    expect(validateImageStructure("webp", webpTrailing).ok).toBe(false);

    const avifFtypOnly = FIXTURE_AVIF_FRAMING_ONLY.subarray(0, 28);
    expect(validateImageStructure("avif", avifFtypOnly).ok).toBe(false);
    const avifTrailing = Uint8Array.from([
      ...FIXTURE_AVIF_FRAMING_ONLY,
      ...Buffer.from("TRAIL", "ascii"),
    ]);
    expect(validateImageStructure("avif", avifTrailing).ok).toBe(false);

    const ports = createHermeticPorts({
      dns: {
        "badimg.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://badimg.example.test/poly.png": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/png" },
          body: pngPlusHtml,
        },
        "https://badimg.example.test/poly2.png": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/png" },
          body: pngPlusSvg,
        },
        "https://badimg.example.test/text.png": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/png" },
          body: pngWithHtmlText,
        },
        "https://badimg.example.test/ztxt.png": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/png" },
          body: pngZtxt,
        },
        "https://badimg.example.test/itxt.png": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/png" },
          body: pngItxt,
        },
        "https://badimg.example.test/u16.png": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/png" },
          body: pngTextUtf16Le,
        },
        "https://badimg.example.test/short.jpg": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/jpeg" },
          body: jpegSoiOnly,
        },
        "https://badimg.example.test/app.jpg": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/jpeg" },
          body: jpegWithSvgApp,
        },
        "https://badimg.example.test/zero.webp": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/webp" },
          body: riffZeroWebp,
        },
        "https://badimg.example.test/short.gif": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/gif" },
          body: gifHeaderOnly,
        },
        "https://badimg.example.test/comment.gif": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/gif" },
          body: gifWithComment,
        },
      },
    });

    for (const uri of [
      "https://badimg.example.test/poly.png",
      "https://badimg.example.test/poly2.png",
      "https://badimg.example.test/text.png",
      "https://badimg.example.test/ztxt.png",
      "https://badimg.example.test/itxt.png",
      "https://badimg.example.test/u16.png",
      "https://badimg.example.test/short.jpg",
      "https://badimg.example.test/app.jpg",
      "https://badimg.example.test/zero.webp",
      "https://badimg.example.test/short.gif",
      "https://badimg.example.test/comment.gif",
    ]) {
      const result = await retrieveMetadata(
        { uri, purpose: "collection_image", now: fixedNow },
        { ports },
      );
      expect(result.outcome).toBe("partial");
      if (result.outcome === "partial") {
        expect(["hostile_content", "content_type_denied"]).toContain(result.reason);
      }
    }

    expect(
      validateImagePayload({ content_type: "image/png", body: pngPlusHtml }).ok,
    ).toBe(false);
  });

  it("returns a successful public metadata fixture with redacted provenance", async () => {
    const body = JSON.stringify({
      name: "Public Collection",
      symbol: "PUB",
      image: "https://img.example.test/collection.png",
    });
    const ports = createHermeticPorts({
      dns: {
        "cdn.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
        "img.example.test": [{ address: PUBLIC_V4_B, family: "ipv4" }],
      },
      transport: {
        "https://cdn.example.test/collection.json": {
          kind: "response",
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
          body,
        },
      },
    });

    const result = await retrieveMetadata(
      {
        uri: "https://cdn.example.test/collection.json",
        purpose: "collection_metadata",
        now: fixedNow,
      },
      { ports },
    );
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") {
      expect(result.content_type).toBe("application/json");
      expect(result.provenance.final_url).toBe("https://cdn.example.test/collection.json");
      expect(result.provenance.pinned_address).toBe(PUBLIC_V4);
      expect(result.provenance.terminal_address_class).toBe("public_ipv4");
      expect(result.provenance.retrieved_at).toBe("2026-07-16T12:00:00.000Z");
      expect(result.provenance.byte_size).toBe(result.body.byteLength);
      expect(result.provenance.content_sha256).toBe(sha256Hex(result.body));
      expect(result.provenance.redirect_count).toBe(0);
      expect(result.provenance.failure_reason).toBeUndefined();
      expect(Buffer.from(result.body).toString("utf8")).toBe(body);
    }
  });

  it("pins the validated public address on the transport exchange", async () => {
    let pinned: string | undefined;
    const ports = createHermeticPorts({
      dns: {
        "pin.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://pin.example.test/meta.json": {
          kind: "response",
          status: 200,
          headers: { "content-type": "application/json" },
          body: "{}",
          capture: (request) => {
            pinned = request.target.pinned_address;
            expect(request.target.hostname).toBe("pin.example.test");
          },
        },
      },
    });
    const result = await retrieveMetadata(
      {
        uri: "https://pin.example.test/meta.json",
        purpose: "collection_metadata",
        now: fixedNow,
      },
      { ports },
    );
    expect(result.outcome).toBe("ok");
    expect(pinned).toBe(PUBLIC_V4);
  });

  it("includes non-default port in Host authority when override allows it", async () => {
    let captured: TransportRequest | undefined;
    const ports = createHermeticPorts({
      dns: {
        "gw.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://gw.example.test:8443/meta.json": {
          kind: "response",
          status: 200,
          headers: { "content-type": "application/json" },
          body: "{}",
          capture: (request) => {
            captured = request;
          },
        },
      },
    });
    const result = await retrieveMetadata(
      {
        uri: "https://gw.example.test:8443/meta.json",
        purpose: "collection_metadata",
        now: fixedNow,
      },
      {
        ports,
        limits: {
          ...DEFAULT_METADATA_EGRESS_LIMITS,
          allowed_ports: [80, 443, 8443],
        },
      },
    );
    expect(result.outcome).toBe("ok");
    expect(captured!.headers.host).toBe("gw.example.test:8443");
    expect(captured!.target.port).toBe(8443);
    expect(captured!.target.hostname).toBe("gw.example.test");
  });
});

describe("CR-004 enrichCandidateFromRemoteMetadata", () => {
  it("maps missing metadata to partial/unavailable diagnostics, not an exception", async () => {
    const ports = createHermeticPorts({
      dns: {
        "missing.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://missing.example.test/gone.json": {
          kind: "response",
          status: 404,
          headers: { "content-type": "application/json" },
          body: "",
        },
      },
    });

    const enrichment = await enrichCandidateFromRemoteMetadata({
      uri: "https://missing.example.test/gone.json",
      deps: { ports },
      now: fixedNow,
    });
    expect(enrichment.metadata_quality).toBe("unavailable");
    expect(enrichment.diagnostics.reason).toBe("missing");
    expect(enrichment.image).toBeUndefined();
  });

  it("maps hostile content to partial candidate diagnostics", async () => {
    const ports = createHermeticPorts({
      dns: {
        "bad.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://bad.example.test/x.json": {
          kind: "response",
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<html>nope</html>",
        },
      },
    });
    const enrichment = await enrichCandidateFromRemoteMetadata({
      uri: "https://bad.example.test/x.json",
      deps: { ports },
      now: fixedNow,
    });
    expect(enrichment.metadata_quality).toBe("partial");
    expect(enrichment.diagnostics.reason).toBe("hostile_content");
  });

  it("never returns nested metadata image URI as trusted/renderable", async () => {
    const token = "nested-secret-token-value";
    const ports = createHermeticPorts({
      dns: {
        "cdn.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://cdn.example.test/collection.json": {
          kind: "response",
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Nested",
            image: `https://img.example.test/img.png?token=${token}`,
          }),
        },
      },
    });
    const enrichment = await enrichCandidateFromRemoteMetadata({
      uri: "https://cdn.example.test/collection.json",
      deps: { ports },
      now: fixedNow,
    });
    expect(enrichment.image).toBeUndefined();
    expect(enrichment.untrusted_image_ref).toBeDefined();
    expect(enrichment.untrusted_image_ref!.kind).toBe("untrusted_metadata_image_ref");
    expect(enrichment.untrusted_image_ref!.requires_egress_fetch).toBe(true);
    expect(enrichment.untrusted_image_ref!.safe_uri).toBe(
      "https://img.example.test/img.png",
    );
    expect(enrichment.untrusted_image_ref!.safe_uri).not.toContain(token);
    assertNoInjectedSecrets(enrichment, [token]);
  });

  it("does not escape private/link-local nested image pointers as safe fields", () => {
    const privateRef = classifyUntrustedImageRef(`http://${LINK_LOCAL_V4}/latest/meta-data`);
    expect(privateRef).toBeDefined();
    expect(privateRef!.denied_inline).toBe(true);
    expect(privateRef!.safe_uri).toBeUndefined();
    expect(JSON.stringify(privateRef)).not.toContain(LINK_LOCAL_V4);

    const v6Ref = classifyUntrustedImageRef("http://[fe80::1]/img.png");
    expect(v6Ref!.denied_inline).toBe(true);
    expect(v6Ref!.safe_uri).toBeUndefined();
    expect(JSON.stringify(v6Ref)).not.toContain("fe80");
  });

  it("accepts a successful public image through the image purpose without trusted URL", async () => {
    const ports = createHermeticPorts({
      dns: {
        "img.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://img.example.test/img.png": {
          kind: "response",
          status: 200,
          headers: { "content-type": "image/png" },
          body: FIXTURE_PNG,
        },
      },
    });
    const enrichment = await enrichCandidateFromRemoteMetadata({
      uri: "https://img.example.test/img.png",
      purpose: "collection_image",
      deps: { ports },
      now: fixedNow,
    });
    expect(enrichment.metadata_quality).toBe("external_pointer");
    expect(enrichment.image).toBeUndefined();
    expect(enrichment.untrusted_image_ref?.safe_uri).toBe("https://img.example.test/img.png");
    expect(enrichment.diagnostics.pinned_address).toBe(PUBLIC_V4);
    expect(enrichment.retrieval.outcome).toBe("ok");
  });
});

describe("CR-004 provenance redaction helpers", () => {
  it("strips userinfo, query, and fragment from safe URIs", () => {
    const redacted = redactUri(
      "https://user:pass@cdn.example.test:443/images/img.png?sig=abc#x",
    );
    expect(redacted.safe_uri).toBe("https://cdn.example.test/images/img.png");
    expect(redacted.safe_uri).not.toContain("user");
    expect(redacted.safe_uri).not.toContain("pass");
    expect(redacted.safe_uri).not.toContain("sig=");
    expect(redacted.uri_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("redacts opaque and secret-bearing path components while keeping origin", () => {
    const cases: Array<{ raw: string; secret: string; keep?: string }> = [
      {
        raw: "https://cdn.example.test/download/ABCDEFGHIJKLMNOPQRSTUVWX/metadata.json",
        secret: "ABCDEFGHIJKLMNOPQRSTUVWX",
        keep: "/download/",
      },
      {
        raw: "https://cdn.example.test/bearer/this-is-a-secret-path-token/metadata.json",
        secret: "this-is-a-secret-path-token",
      },
      {
        raw: "https://cdn.example.test/bearer/this-is-a-secret-path-token/metadata.json",
        secret: "bearer",
      },
      {
        raw: "https://api.example.test/v1/Xk9mP2qR7sT4uV6wY8zA1bC/meta.json",
        secret: "Xk9mP2qR7sT4uV6wY8zA1bC",
        keep: "/v1/",
      },
      {
        raw: "https://cdn.example.test/api/key/sk-live-ABCDEFGHIJKLMNOPQRST/metadata.json",
        secret: "sk-live-ABCDEFGHIJKLMNOPQRST",
      },
      {
        raw: "https://cdn.example.test/files/%53%65%63%72%65%74%54%6f%6b%65%6e%56%61%6c%75%65%31%32%33/metadata.json",
        secret: "SecretTokenValue123",
      },
      {
        raw: "https://cdn.example.test/files/%53%65%63%72%65%74%54%6f%6b%65%6e%56%61%6c%75%65%31%32%33/metadata.json",
        secret: "%53%65%63%72%65%74",
      },
    ];

    for (const { raw, secret, keep } of cases) {
      const redacted = redactUri(raw);
      expect(redacted.safe_uri.startsWith("https://")).toBe(true);
      expect(redacted.safe_uri).toContain(".example.test");
      expect(redacted.safe_uri).not.toContain(secret);
      expect(redacted.safe_uri).toMatch(/\[redacted:[0-9a-f]{12}\]/);
      expect(redacted.uri_sha256).toMatch(/^[0-9a-f]{64}$/);
      if (keep !== undefined) {
        expect(redacted.safe_uri).toContain(keep);
      }
      expect(isPublicSafePathSegment(secret)).toBe(false);
    }

    // Explicit structural allowlist + safe terminal filenames remain.
    expect(isPublicSafePathSegment("download")).toBe(true);
    expect(isPublicSafePathSegment("metadata.json")).toBe(false);
    expect(isPublicSafePathSegment("metadata.json", { isTerminal: true })).toBe(true);
    expect(isSafeTerminalFilename("img.png")).toBe(true);
    expect(isPublicSafePathSegment("img.png")).toBe(false);
    expect(isPublicSafePathSegment("img.png", { isTerminal: true })).toBe(true);
    expect(redactUri("https://cdn.example.test/collections/meta.json").safe_uri).toBe(
      "https://cdn.example.test/collections/meta.json",
    );

    // Filename shape in a nonterminal position must be hashed/redacted.
    const nonterminalFilename = redactUri(
      "https://cdn.example.test/img.png/collections/meta.json",
    );
    expect(nonterminalFilename.safe_uri).not.toContain("/img.png/");
    expect(nonterminalFilename.safe_uri).toContain("/collections/meta.json");
    expect(nonterminalFilename.safe_uri).toMatch(/\[redacted:[0-9a-f]{12}\]/);
  });

  it("redacts lowercase opaque, dictionary, short/long, percent-encoded, and mixed paths", () => {
    const opaqueLower = "qwertyuiopasdfghjklz";
    const dictLower = "abcdefghijklmnopqrstuvwx";
    const shortWord = "secretish";
    const longLower = "supercalifragilisticexpialidociouspathseg";
    const mixed = "AbCdEfGhIjKlMnOpQrSt";
    const percentOpaque = "%71%77%65%72%74%79%75%69%6f%70%61%73%64%66%67%68%6a%6b%6c%7a";

    for (const segment of [
      opaqueLower,
      dictLower,
      shortWord,
      longLower,
      mixed,
      percentOpaque,
      "path",
      "collections-backup",
      "img.png.exe",
      "random.json",
    ]) {
      expect(isPublicSafePathSegment(segment)).toBe(false);
    }

    const redacted = redactUri(
      `https://cdn.example.test/${opaqueLower}/${dictLower}/images/${shortWord}/${percentOpaque}/img.png`,
    );
    expect(redacted.safe_uri).toContain("/images/");
    expect(redacted.safe_uri).toContain("/img.png");
    expect(redacted.safe_uri).not.toContain(opaqueLower);
    expect(redacted.safe_uri).not.toContain(dictLower);
    expect(redacted.safe_uri).not.toContain(shortWord);
    expect(redacted.safe_uri).not.toContain("%71%77%65%72");
    expect(redacted.safe_uri).toMatch(/\[redacted:[0-9a-f]{12}\]/);

    // Arbitrary path words are not preserved even when short/lowercase.
    const pathWord = redactUri("https://cdn.example.test/path/img.png");
    expect(pathWord.safe_uri).not.toContain("/path/");
    expect(pathWord.safe_uri).toContain("/img.png");
    expect(pathWord.safe_uri).toMatch(/\[redacted:[0-9a-f]{12}\]/);
  });

  it("does not leak path secrets in success, partial, redirect, or enrichment output", async () => {
    const downloadSecret = "ABCDEFGHIJKLMNOPQRSTUVWX";
    const bearerSecret = "this-is-a-secret-path-token";
    const lowerOpaque = "qwertyuiopasdfghjklz";
    const secrets = [downloadSecret, bearerSecret, "bearer", lowerOpaque];

    const ports = createHermeticPorts({
      dns: {
        "cdn.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        [`https://cdn.example.test/download/${downloadSecret}/metadata.json`]: {
          kind: "response",
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "SecretPath",
            image: `https://cdn.example.test/bearer/${bearerSecret}/metadata.json`,
          }),
        },
        [`https://cdn.example.test/bearer/${bearerSecret}/metadata.json`]: [
          {
            kind: "response",
            status: 302,
            headers: {
              location: `https://cdn.example.test/download/${downloadSecret}/metadata.json`,
            },
          },
        ],
        [`https://cdn.example.test/${lowerOpaque}/meta.json`]: {
          kind: "response",
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "LowerOpaque" }),
        },
        "https://cdn.example.test/gone.json": {
          kind: "response",
          status: 404,
          headers: { "content-type": "application/json" },
          body: "",
        },
      },
    });

    const ok = await retrieveMetadata(
      {
        uri: `https://cdn.example.test/download/${downloadSecret}/metadata.json`,
        purpose: "collection_metadata",
        now: fixedNow,
      },
      { ports },
    );
    expect(ok.outcome).toBe("ok");
    assertNoInjectedSecrets(ok, secrets);
    if (ok.outcome === "ok") {
      expect(ok.provenance.requested_uri).not.toContain(downloadSecret);
      expect(ok.provenance.final_url).not.toContain(downloadSecret);
      expect(ok.provenance.requested_uri).toContain("[redacted:");
    }

    const lower = await retrieveMetadata(
      {
        uri: `https://cdn.example.test/${lowerOpaque}/meta.json`,
        purpose: "collection_metadata",
        now: fixedNow,
      },
      { ports },
    );
    expect(lower.outcome).toBe("ok");
    assertNoInjectedSecrets(lower, secrets);
    if (lower.outcome === "ok") {
      expect(lower.provenance.requested_uri).not.toContain(lowerOpaque);
      expect(lower.provenance.final_url).not.toContain(lowerOpaque);
    }

    const partial = await retrieveMetadata(
      {
        uri: `https://cdn.example.test/bearer/${bearerSecret}/missing.json`,
        purpose: "collection_metadata",
        now: fixedNow,
      },
      { ports },
    );
    expect(partial.outcome).toBe("partial");
    assertNoInjectedSecrets(partial, secrets);

    const redirect = await retrieveMetadata(
      {
        uri: `https://cdn.example.test/bearer/${bearerSecret}/metadata.json`,
        purpose: "collection_metadata",
        now: fixedNow,
      },
      { ports },
    );
    // Redirect target is the download URL which succeeds.
    expect(redirect.outcome).toBe("ok");
    assertNoInjectedSecrets(redirect, secrets);
    if (redirect.outcome === "ok") {
      expect(redirect.provenance.requested_uri).not.toContain(bearerSecret);
      expect(redirect.provenance.final_url).not.toContain(downloadSecret);
    }

    const enrichment = await enrichCandidateFromRemoteMetadata({
      uri: `https://cdn.example.test/download/${downloadSecret}/metadata.json`,
      deps: { ports },
      now: fixedNow,
    });
    assertNoInjectedSecrets(enrichment, secrets);
    expect(enrichment.untrusted_image_ref?.safe_uri).toBeDefined();
    expect(enrichment.untrusted_image_ref!.safe_uri).not.toContain(bearerSecret);
    expect(enrichment.diagnostics.requested_uri).not.toContain(downloadSecret);
  });
});

describe("CR-004 resolver and report worker ports", () => {
  it("exposes one shared egress client for resolver and report workers", async () => {
    const ports = createHermeticPorts({
      dns: {
        "shared.example.test": [{ address: PUBLIC_V4, family: "ipv4" }],
      },
      transport: {
        "https://shared.example.test/meta.json": {
          kind: "response",
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Shared" }),
        },
      },
    });
    const deps = { ports };
    const resolver = createResolverMetadataPort(deps);
    const report = createReportMetadataWorkerPort(deps);
    const client = createMetadataEgressClient(deps);

    const a = await resolver.retrieve({
      uri: "https://shared.example.test/meta.json",
      purpose: "collection_metadata",
      now: fixedNow,
    });
    const b = await report.retrieve({
      uri: "https://shared.example.test/meta.json",
      purpose: "report_enrichment",
      now: fixedNow,
    });
    const c = await client.enrich({
      uri: "https://shared.example.test/meta.json",
      now: fixedNow,
    });

    expect(a.outcome).toBe("ok");
    expect(b.outcome).toBe("ok");
    expect(c.metadata_quality).toBe("external_pointer");
    expect(c.name).toBe("Shared");
    expect(c.image).toBeUndefined();
    if (a.outcome === "ok") {
      expect(a.provenance.content_sha256).toBeDefined();
      expect(a.provenance.terminal_address_class).toBe("public_ipv4");
    }
  });
});
