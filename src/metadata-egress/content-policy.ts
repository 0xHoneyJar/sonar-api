/**
 * Content-type and hostile-body policy for CR-004 metadata egress.
 *
 * Positive PNG magic + image-bearing structural validation are required for
 * trusted images. JPEG/GIF/WebP/AVIF/SVG and every other image type fail
 * closed with typed partials. HTML/SVG never enter Dashboard as trusted
 * image/metadata content — including BOM, comment, polyglot, UTF-16, and
 * markup embedded anywhere in candidate image bodies. PNG textual metadata
 * chunks (tEXt/iTXt/zTXt) are rejected entirely by structure proof — trusted
 * PNG does not need them. JSON/text is never promoted as a trusted image.
 */

import {
  peekImageMagic,
  TRUSTED_IMAGE_KINDS,
  validateImageStructure,
  type ImageKind,
} from "./image-structure.js";
import type { MetadataFailureReason, MetadataRetrievalPurpose } from "./types.js";

export type { ImageKind } from "./image-structure.js";

const METADATA_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "text/plain",
]);

/** Only PNG has a maintained image-bearing proof in this boundary. */
const IMAGE_TYPES = new Set(["image/png"]);

/**
 * Explicitly denied image containers (fail-closed; not trusted).
 * Includes formats that previously had partial custom proofs.
 */
const FAIL_CLOSED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/heic",
  "image/heif",
  "image/tiff",
]);

const HOSTILE_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "application/javascript",
  "text/javascript",
  "application/ecmascript",
]);

export const normalizeContentType = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined;
  const media = raw.split(";", 1)[0]!.trim().toLowerCase();
  return media === "" ? undefined : media;
};

export const evaluateContentType = (input: {
  readonly purpose: MetadataRetrievalPurpose;
  readonly content_type: string | undefined;
}):
  | { readonly ok: true; readonly content_type: string }
  | { readonly ok: false; readonly reason: MetadataFailureReason; readonly safe_message: string } => {
  const contentType = normalizeContentType(input.content_type);
  if (contentType === undefined) {
    return {
      ok: false,
      reason: "content_type_denied",
      safe_message: "response Content-Type is missing",
    };
  }
  if (HOSTILE_TYPES.has(contentType)) {
    return {
      ok: false,
      reason: "hostile_content",
      safe_message: `hostile content type "${contentType}" rejected`,
    };
  }
  if (FAIL_CLOSED_IMAGE_TYPES.has(contentType)) {
    return {
      ok: false,
      reason: "content_type_denied",
      safe_message: `content type "${contentType}" is fail-closed (trusted images are PNG-only)`,
    };
  }

  const allowed =
    input.purpose === "collection_image"
      ? IMAGE_TYPES
      : input.purpose === "collection_metadata"
        ? METADATA_TYPES
        : new Set([...METADATA_TYPES, ...IMAGE_TYPES]);

  if (!allowed.has(contentType)) {
    return {
      ok: false,
      reason: "content_type_denied",
      safe_message: `content type "${contentType}" is not allowlisted for ${input.purpose}`,
    };
  }

  return { ok: true, content_type: contentType };
};

/**
 * Detect image kind only when leading magic AND image-bearing structural
 * validation succeed for a trusted format. Fail-closed kinds never promote.
 */
export const detectImageKind = (body: Uint8Array): ImageKind | undefined => {
  const candidate = peekImageMagic(body);
  if (candidate === undefined) return undefined;
  if (!TRUSTED_IMAGE_KINDS.has(candidate)) return undefined;
  const structure = validateImageStructure(candidate, body);
  return structure.ok ? candidate : undefined;
};

const IMAGE_KIND_FOR_TYPE: Record<string, ImageKind> = {
  "image/png": "png",
};

/**
 * Positive validation: declared image MIME must match structural magic and
 * image-bearing proof. Arbitrary bytes and JSON/text payloads are rejected.
 */
export const validateImagePayload = (input: {
  readonly content_type: string;
  readonly body: Uint8Array;
}):
  | { readonly ok: true; readonly kind: ImageKind }
  | { readonly ok: false; readonly reason: MetadataFailureReason; readonly safe_message: string } => {
  const expected = IMAGE_KIND_FOR_TYPE[input.content_type];
  if (expected === undefined) {
    return {
      ok: false,
      reason: "content_type_denied",
      safe_message: "content type is not a validated image MIME",
    };
  }

  const candidate = peekImageMagic(input.body);
  if (candidate === undefined) {
    return {
      ok: false,
      reason: "hostile_content",
      safe_message: "image payload failed positive magic/structure validation",
    };
  }
  if (candidate !== expected) {
    return {
      ok: false,
      reason: "hostile_content",
      safe_message: `image magic (${candidate}) does not match declared type (${expected})`,
    };
  }

  const structure = validateImageStructure(expected, input.body);
  if (!structure.ok) {
    return {
      ok: false,
      reason: "hostile_content",
      safe_message: structure.safe_message,
    };
  }

  return { ok: true, kind: expected };
};

const decodeLeadingText = (body: Uint8Array): string => {
  const sample = body.subarray(0, Math.min(body.byteLength, 1024));
  if (sample.byteLength >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return Buffer.from(sample.subarray(3)).toString("utf8");
  }
  if (sample.byteLength >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
    return Buffer.from(sample.subarray(2)).toString("utf16le");
  }
  if (sample.byteLength >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
    // UTF-16 BE → swap to LE for decoding.
    const swapped = Buffer.alloc(sample.byteLength - 2);
    for (let i = 2; i + 1 < sample.byteLength; i += 2) {
      swapped[i - 2] = sample[i + 1]!;
      swapped[i - 2 + 1] = sample[i]!;
    }
    return swapped.toString("utf16le");
  }
  // UTF-16 LE without BOM: NUL in odd positions for ASCII markup.
  if (
    sample.byteLength >= 8 &&
    sample[1] === 0x00 &&
    sample[3] === 0x00 &&
    sample[5] === 0x00 &&
    sample[0] !== 0x00
  ) {
    return Buffer.from(sample).toString("utf16le");
  }
  // UTF-16 BE without BOM: NUL in even positions for ASCII markup.
  if (
    sample.byteLength >= 8 &&
    sample[0] === 0x00 &&
    sample[2] === 0x00 &&
    sample[4] === 0x00 &&
    sample[1] !== 0x00
  ) {
    const even = sample.byteLength & ~1;
    const swapped = Buffer.alloc(even);
    for (let i = 0; i + 1 < even; i += 2) {
      swapped[i] = sample[i + 1]!;
      swapped[i + 1] = sample[i]!;
    }
    return swapped.toString("utf16le");
  }
  return Buffer.from(sample).toString("utf8");
};

const stripLeadingNoise = (text: string): string => {
  let remaining = text.replace(/^\uFEFF/, "");
  // Leading whitespace + HTML comments (including nested comment runs).
  for (;;) {
    const next = remaining.replace(/^(?:\s+|<!--[\s\S]*?-->)+/, "");
    if (next === remaining) break;
    remaining = next;
  }
  return remaining;
};

const HOSTILE_MARKUP =
  /^(?:<!doctype\s+html|<html\b|<head\b|<body\b|<script\b|<iframe\b|<svg\b|<\?xml\b)/i;

/** Embedded HTML/SVG anywhere in a candidate image body (false positives OK). */
const EMBEDDED_HOSTILE_MARKUP =
  /<!doctype\s+html\b|<html\b|<head\b|<body\b|<script\b|<iframe\b|<svg\b|<\?xml\b/i;

const bodyAsLatin1 = (body: Uint8Array): string => {
  // Bounded by egress decompressed budget; latin1 preserves raw bytes 1:1.
  let out = "";
  for (let i = 0; i < body.byteLength; i += 1) {
    out += String.fromCharCode(body[i]!);
  }
  return out;
};

const decodeUtf16Le = (body: Uint8Array, start = 0): string => {
  const slice = body.subarray(start);
  // Odd trailing byte ignored — conservative scan.
  const even = slice.byteLength & ~1;
  return Buffer.from(slice.subarray(0, even)).toString("utf16le");
};

const decodeUtf16Be = (body: Uint8Array, start = 0): string => {
  const slice = body.subarray(start);
  const even = slice.byteLength & ~1;
  const swapped = Buffer.alloc(even);
  for (let i = 0; i + 1 < even; i += 2) {
    swapped[i] = slice[i + 1]!;
    swapped[i + 1] = slice[i]!;
  }
  return swapped.toString("utf16le");
};

const hostileInText = (
  text: string,
): { readonly hostile: boolean; readonly safe_message?: string } => {
  if (!EMBEDDED_HOSTILE_MARKUP.test(text)) return { hostile: false };
  if (/<svg\b/i.test(text) || (/<\?xml\b/i.test(text) && /<svg\b/i.test(text))) {
    return { hostile: true, safe_message: "embedded SVG markup sniffed in image body" };
  }
  return { hostile: true, safe_message: "embedded HTML markup sniffed in image body" };
};

/**
 * Byte-level scan for HTML/SVG markers anywhere in a candidate image body.
 * Covers ASCII/UTF-8, UTF-16LE, UTF-16BE (with or without BOM).
 * PNG textual chunks are rejected by structure proof (no decompression surface).
 * Conservative: false-positive rejection is acceptable.
 */
export const sniffEmbeddedHostileInImageBody = (
  body: Uint8Array,
): { readonly hostile: boolean; readonly safe_message?: string } => {
  // ASCII / UTF-8 raw bytes.
  const latin1Hit = hostileInText(bodyAsLatin1(body));
  if (latin1Hit.hostile) return latin1Hit;

  // UTF-16 LE with optional BOM.
  const leStart = body.byteLength >= 2 && body[0] === 0xff && body[1] === 0xfe ? 2 : 0;
  const leHit = hostileInText(decodeUtf16Le(body, leStart));
  if (leHit.hostile) return leHit;

  // UTF-16 BE with optional BOM.
  const beStart = body.byteLength >= 2 && body[0] === 0xfe && body[1] === 0xff ? 2 : 0;
  const beHit = hostileInText(decodeUtf16Be(body, beStart));
  if (beHit.hostile) return beHit;

  // Common leading noise then UTF-16 markup (skip a few comment/whitespace bytes).
  for (const skip of [1, 2, 3, 4, 8, 16]) {
    if (skip >= body.byteLength) break;
    const noiseLe = hostileInText(decodeUtf16Le(body, skip));
    if (noiseLe.hostile) return noiseLe;
    const noiseBe = hostileInText(decodeUtf16Be(body, skip));
    if (noiseBe.hostile) return noiseBe;
  }

  return { hostile: false };
};

/** Magic-byte / sniff checks for HTML and SVG smuggled under other types. */
export const sniffHostilePayload = (
  body: Uint8Array,
): { readonly hostile: boolean; readonly safe_message?: string } => {
  const decoded = stripLeadingNoise(decodeLeadingText(body));
  const head = decoded.slice(0, 512).toLowerCase();

  if (HOSTILE_MARKUP.test(head)) {
    if (head.includes("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
      return { hostile: true, safe_message: "SVG payload sniffed and rejected" };
    }
    return { hostile: true, safe_message: "HTML payload sniffed and rejected" };
  }

  // Polyglot / trailing hostile markup after a non-markup prefix (e.g. JSON
  // then a second HTML/SVG document). Avoid flagging JSON string values that
  // merely mention angle-bracket text.
  if (
    /(?:\r?\n|\x00)\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b|<svg\b|<\?xml\b)/i.test(
      decoded.slice(0, 2048),
    )
  ) {
    return {
      hostile: true,
      safe_message: "polyglot or trailing hostile markup sniffed and rejected",
    };
  }

  return { hostile: false };
};

/**
 * Full content policy after headers + decompression.
 * Images require positive magic + image-bearing structure; metadata still
 * rejects hostile sniff hits; JSON/text cannot satisfy an image purpose.
 */
export const evaluateRetrievedContent = (input: {
  readonly purpose: MetadataRetrievalPurpose;
  readonly content_type: string;
  readonly body: Uint8Array;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: MetadataFailureReason; readonly safe_message: string } => {
  const isImagePurpose = input.purpose === "collection_image";
  const isImageType = IMAGE_TYPES.has(input.content_type);

  // Leading HTML/SVG/BOM/comment/polyglot denial before any content is trusted.
  const sniff = sniffHostilePayload(input.body);
  if (sniff.hostile) {
    return {
      ok: false,
      reason: "hostile_content",
      safe_message: sniff.safe_message ?? "hostile content",
    };
  }

  // Candidate image bodies: reject embedded HTML/SVG anywhere in raw bytes.
  if (isImagePurpose || isImageType) {
    const embedded = sniffEmbeddedHostileInImageBody(input.body);
    if (embedded.hostile) {
      return {
        ok: false,
        reason: "hostile_content",
        safe_message: embedded.safe_message ?? "embedded hostile markup",
      };
    }

    const image = validateImagePayload({
      content_type: input.content_type,
      body: input.body,
    });
    if (!image.ok) return image;
  }

  if (isImagePurpose && (input.content_type === "application/json" || input.content_type === "text/plain")) {
    return {
      ok: false,
      reason: "content_type_denied",
      safe_message: "JSON/text cannot be promoted as a trusted image",
    };
  }

  return { ok: true };
};
