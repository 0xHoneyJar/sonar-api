/**
 * Bounded PNG image-bearing validation for CR-004 payloads.
 *
 * Trusted image content is PNG-only after strict structure proof for the
 * supported subset: non-interlaced color types 0/2/4/6 with legal bit depths,
 * exact zlib/scanline proof, CRC, reserved-bit clear, no unknown critical
 * chunks, no tEXt/zTXt/iTXt. Indexed (3) and all other image types fail closed.
 * Magic peeking is diagnostic only and never promotes a denied format.
 * Container framing alone is not trust.
 */

import { inflateSync } from "node:zlib";

/** Diagnostic peek kinds — only `png` may become trusted after structure proof. */
export type ImageKind = "png" | "jpeg" | "gif" | "webp" | "avif";

/** Formats that may become trusted image content after structure proof. */
export const TRUSTED_IMAGE_KINDS = new Set<ImageKind>(["png"]);

/** Max chunk iterations within the decompressed body budget. */
const MAX_STRUCTURE_STEPS = 4_096;

/** Bound decoded raster size vs egress decompressed budget. */
const MAX_IMAGE_DIMENSION = 8_192;
const MAX_INFLATED_BYTES = 1_048_576;

export type ImageStructureFailure =
  | "truncated"
  | "trailing_bytes"
  | "bad_signature"
  | "bad_framing"
  | "missing_required"
  | "bad_crc"
  | "step_limit"
  | "unsupported";

export type ImageStructureResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failure: ImageStructureFailure;
      readonly safe_message: string;
    };

const fail = (
  failure: ImageStructureFailure,
  safe_message: string,
): Extract<ImageStructureResult, { ok: false }> => ({
  ok: false,
  failure,
  safe_message,
});

/** IEEE CRC-32 (PNG), table-driven — avoids native decoder / Node-type skew. */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (data: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < data.byteLength; i += 1) {
    c = CRC32_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

const readU32be = (body: Uint8Array, offset: number): number | undefined => {
  if (offset + 4 > body.byteLength) return undefined;
  return (
    ((body[offset]! << 24) |
      (body[offset + 1]! << 16) |
      (body[offset + 2]! << 8) |
      body[offset + 3]!) >>>
    0
  );
};

const readAscii = (body: Uint8Array, start: number, length: number): string => {
  const end = Math.min(body.byteLength, start + length);
  let out = "";
  for (let i = start; i < end; i += 1) {
    out += String.fromCharCode(body[i]!);
  }
  return out;
};

const startsWith = (body: Uint8Array, magic: ReadonlyArray<number>): boolean => {
  if (body.byteLength < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (body[i] !== magic[i]) return false;
  }
  return true;
};

/** Supported subset: non-interlaced color types 0, 2, 4, 6 only (indexed is fail-closed). */
const pngSamplesPerPixel = (colorType: number): number | undefined => {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      return undefined;
  }
};

const pngBitDepthLegal = (colorType: number, bitDepth: number): boolean => {
  switch (colorType) {
    case 0:
      return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8 || bitDepth === 16;
    case 2:
    case 4:
    case 6:
      return bitDepth === 8 || bitDepth === 16;
    default:
      return false;
  }
};

/** Only these critical chunk types are accepted (subject to order rules). */
const ACCEPTED_CRITICAL_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);

/** Textual metadata is never required for trusted PNG — reject the container. */
const REJECTED_TEXT_CHUNKS = new Set(["tEXt", "zTXt", "iTXt"]);

const isUpperAscii = (ch: string): boolean => ch >= "A" && ch <= "Z";

/**
 * PNG chunk-type property bits (ISO 15948):
 * - byte0 uppercase = critical, lowercase = ancillary
 * - byte2 MUST be uppercase (reserved bit clear); lowercase = invalid
 * Caller must already confirm `/^[A-Za-z]{4}$/`.
 */
const validatePngChunkTypeBits = (
  type: string,
): ImageStructureResult => {
  // Reserved bit: third character must be uppercase.
  if (!isUpperAscii(type[2]!)) {
    return fail("bad_framing", "PNG chunk reserved bit must be clear");
  }
  if (REJECTED_TEXT_CHUNKS.has(type)) {
    return fail(
      "unsupported",
      "PNG textual metadata chunks (tEXt/zTXt/iTXt) are not trusted",
    );
  }
  const critical = isUpperAscii(type[0]!);
  if (critical && !ACCEPTED_CRITICAL_CHUNKS.has(type)) {
    return fail("unsupported", "PNG unknown critical chunk rejected");
  }
  return { ok: true };
};

const pngRowBytes = (width: number, bitDepth: number, samples: number): number => {
  const bitsPerPixel = bitDepth * samples;
  return 1 + Math.ceil((width * bitsPerPixel) / 8);
};

const validatePngIhdrFields = (
  ihdr: Uint8Array,
):
  | {
      readonly ok: true;
      readonly width: number;
      readonly height: number;
      readonly bitDepth: number;
      readonly colorType: number;
      readonly interlace: number;
      readonly samples: number;
    }
  | {
      readonly ok: false;
      readonly failure: ImageStructureFailure;
      readonly safe_message: string;
    } => {
  if (ihdr.byteLength !== 13) {
    return fail("bad_framing", "PNG IHDR length invalid");
  }
  const width = readU32be(ihdr, 0);
  const height = readU32be(ihdr, 4);
  if (width === undefined || height === undefined) {
    return fail("truncated", "PNG IHDR truncated");
  }
  if (width === 0 || height === 0) {
    return fail("bad_framing", "PNG dimensions must be nonzero");
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    return fail("bad_framing", "PNG dimensions exceed bound");
  }
  const bitDepth = ihdr[8]!;
  const colorType = ihdr[9]!;
  const compression = ihdr[10]!;
  const filter = ihdr[11]!;
  const interlace = ihdr[12]!;
  if (compression !== 0) {
    return fail("bad_framing", "PNG compression method unsupported");
  }
  if (filter !== 0) {
    return fail("bad_framing", "PNG filter method unsupported");
  }
  // Interlaced Adam7 proof is deliberately out of scope — reject closed.
  if (interlace !== 0) {
    return fail(
      "unsupported",
      "PNG interlaced images are not trusted in this boundary",
    );
  }
  // Indexed color (type 3): fail closed — no palette/index proof in this boundary.
  if (colorType === 3) {
    return fail(
      "unsupported",
      "PNG indexed color is not trusted in this boundary",
    );
  }
  if (!pngBitDepthLegal(colorType, bitDepth)) {
    return fail("bad_framing", "PNG IHDR bit depth/color type illegal");
  }
  const samples = pngSamplesPerPixel(colorType);
  if (samples === undefined) {
    return fail("bad_framing", "PNG color type invalid");
  }
  return { ok: true, width, height, bitDepth, colorType, interlace, samples };
};

const validatePngInflatedScanlines = (
  inflated: Uint8Array,
  expectedBytes: number,
  rowBytes: number,
): ImageStructureResult => {
  if (inflated.byteLength !== expectedBytes) {
    return fail("bad_framing", "PNG zlib output size mismatch");
  }
  if (rowBytes <= 1) {
    return fail("bad_framing", "PNG scanline size invalid");
  }
  for (let offset = 0; offset < inflated.byteLength; offset += rowBytes) {
    const filterType = inflated[offset]!;
    if (filterType > 4) {
      return fail("bad_framing", "PNG filter byte invalid");
    }
  }
  return { ok: true };
};

/**
 * Inflate zlib and require the stream to consume the *entire* input.
 * Node's inflateSync otherwise silently ignores trailing bytes after the
 * zlib terminator — those must reject (`valid-zlib + TRAIL`).
 */
const inflateZlibExact = (
  input: Uint8Array,
  maxOutputLength: number,
):
  | { readonly ok: true; readonly inflated: Uint8Array }
  | { readonly ok: false; readonly failure: ImageStructureFailure; readonly safe_message: string } => {
  try {
    const result = inflateSync(input, {
      maxOutputLength,
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const inflated = new Uint8Array(result.buffer);
    if (result.engine.bytesWritten !== input.byteLength) {
      return fail(
        "bad_framing",
        "PNG zlib stream did not consume entire IDAT payload",
      );
    }
    return { ok: true, inflated };
  } catch {
    return fail("bad_framing", "PNG zlib/deflate invalid");
  }
};

/**
 * PNG trusted subset: non-interlaced color types 0/2/4/6 with legal bit depths;
 * signature; exactly one legal IHDR first; optional PLTE before IDAT for
 * truecolor (2/6) with valid entry count (grayscale PLTE prohibited);
 * contiguous nonempty IDAT with exact zlib consume + scanline filter proof;
 * CRCs; exactly one empty IEND last; no trailing bytes.
 * Rejected: interlace, indexed (3), tEXt/zTXt/iTXt, unknown critical chunks,
 * reserved-bit-set chunk types.
 */
export const validatePngStructure = (body: Uint8Array): ImageStructureResult => {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
  if (!startsWith(body, sig)) {
    return fail("bad_signature", "PNG signature missing");
  }

  let offset = 8;
  let steps = 0;
  let sawIhdr = false;
  let sawIend = false;
  let sawIdat = false;
  let idatClosed = false;
  let sawPlte = false;
  let colorType: number | undefined;
  const idatParts: Uint8Array[] = [];
  let ihdrMeta:
    | {
        readonly width: number;
        readonly height: number;
        readonly bitDepth: number;
        readonly colorType: number;
        readonly samples: number;
      }
    | undefined;

  while (offset < body.byteLength) {
    steps += 1;
    if (steps > MAX_STRUCTURE_STEPS) {
      return fail("step_limit", "PNG chunk walk exceeded step limit");
    }
    if (sawIend) {
      return fail("trailing_bytes", "PNG has bytes after IEND");
    }
    if (offset + 12 > body.byteLength) {
      return fail("truncated", "PNG chunk header truncated");
    }
    const length = readU32be(body, offset);
    if (length === undefined) return fail("truncated", "PNG chunk length truncated");
    if (length > body.byteLength) {
      return fail("bad_framing", "PNG chunk length exceeds body");
    }
    const type = readAscii(body, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      return fail("bad_framing", "PNG chunk type invalid");
    }
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    if (crcOffset + 4 > body.byteLength) {
      return fail("truncated", "PNG chunk data/CRC truncated");
    }
    const expectedCrc = readU32be(body, crcOffset);
    if (expectedCrc === undefined) {
      return fail("truncated", "PNG CRC truncated");
    }
    const crcInput = body.subarray(offset + 4, dataEnd);
    const actualCrc = crc32(crcInput) >>> 0;
    if (actualCrc !== expectedCrc) {
      return fail("bad_crc", "PNG chunk CRC mismatch");
    }
    // Property-bit + allowlist policy after CRC (CRC-valid hostile fixtures still reject).
    const typeBits = validatePngChunkTypeBits(type);
    if (!typeBits.ok) return typeBits;
    const chunkData = body.subarray(dataStart, dataEnd);

    if (steps === 1) {
      if (type !== "IHDR" || length !== 13) {
        return fail("missing_required", "PNG must start with IHDR");
      }
      const fields = validatePngIhdrFields(chunkData);
      if (!fields.ok) return fields;
      sawIhdr = true;
      colorType = fields.colorType;
      ihdrMeta = {
        width: fields.width,
        height: fields.height,
        bitDepth: fields.bitDepth,
        colorType: fields.colorType,
        samples: fields.samples,
      };
    } else if (type === "IHDR") {
      return fail("bad_framing", "PNG duplicate IHDR");
    }

    if (type === "PLTE") {
      if (!sawIhdr || colorType === undefined) {
        return fail("missing_required", "PNG PLTE before IHDR");
      }
      if (sawIdat) {
        return fail("bad_framing", "PNG PLTE after IDAT");
      }
      if (sawPlte) {
        return fail("bad_framing", "PNG duplicate PLTE");
      }
      // Grayscale / grayscale+alpha: PLTE prohibited.
      if (colorType === 0 || colorType === 4) {
        return fail("bad_framing", "PNG PLTE prohibited for grayscale color type");
      }
      // Truecolor / truecolor+alpha: optional PLTE with valid RGB entry count.
      if (colorType !== 2 && colorType !== 6) {
        return fail("bad_framing", "PNG PLTE not permitted for this color type");
      }
      if (length === 0 || length % 3 !== 0) {
        return fail("bad_framing", "PNG PLTE entry count invalid");
      }
      const entries = length / 3;
      if (entries < 1 || entries > 256) {
        return fail("bad_framing", "PNG PLTE entry count out of range");
      }
      sawPlte = true;
    }

    if (type === "IDAT") {
      if (idatClosed) {
        return fail("bad_framing", "PNG IDAT must be contiguous");
      }
      sawIdat = true;
      if (length > 0) idatParts.push(chunkData);
    } else if (sawIdat) {
      idatClosed = true;
    }

    if (type === "IEND") {
      if (length !== 0) {
        return fail("bad_framing", "PNG IEND must be empty");
      }
      if (!sawIdat) {
        return fail("missing_required", "PNG IEND without image-bearing IDAT");
      }
      sawIend = true;
    }

    offset = crcOffset + 4;
  }

  if (!sawIhdr || ihdrMeta === undefined) {
    return fail("missing_required", "PNG missing IHDR");
  }
  if (!sawIdat || idatParts.length === 0) {
    return fail("missing_required", "PNG missing image-bearing IDAT");
  }
  if (!sawIend) return fail("truncated", "PNG missing IEND terminator");

  let idatLen = 0;
  for (const part of idatParts) idatLen += part.byteLength;
  if (idatLen === 0) {
    return fail("missing_required", "PNG IDAT payload empty");
  }
  const concatenated = new Uint8Array(idatLen);
  let copyAt = 0;
  for (const part of idatParts) {
    concatenated.set(part, copyAt);
    copyAt += part.byteLength;
  }

  const expectedBytes =
    ihdrMeta.height * pngRowBytes(ihdrMeta.width, ihdrMeta.bitDepth, ihdrMeta.samples);
  if (expectedBytes <= 0 || expectedBytes > MAX_INFLATED_BYTES) {
    return fail("bad_framing", "PNG decoded raster exceeds bound");
  }

  const inflatedResult = inflateZlibExact(concatenated, expectedBytes);
  if (!inflatedResult.ok) return inflatedResult;

  const rowBytes = pngRowBytes(ihdrMeta.width, ihdrMeta.bitDepth, ihdrMeta.samples);
  return validatePngInflatedScanlines(inflatedResult.inflated, expectedBytes, rowBytes);
};

/** Denied formats never promote — diagnostic peek only. */
const unsupportedFormat = (label: string): ImageStructureResult =>
  fail(
    "unsupported",
    `${label} fail-closed: trusted image support is PNG-only in this boundary`,
  );

export const validateImageStructure = (
  kind: ImageKind,
  body: Uint8Array,
): ImageStructureResult => {
  switch (kind) {
    case "png":
      return validatePngStructure(body);
    case "jpeg":
      return unsupportedFormat("JPEG");
    case "gif":
      return unsupportedFormat("GIF");
    case "webp":
      return unsupportedFormat("WebP");
    case "avif":
      return unsupportedFormat("AVIF");
    default: {
      const _exhaustive: never = kind;
      return fail("unsupported", `unsupported image kind ${_exhaustive}`);
    }
  }
};

/** Aligned ftyp compatible-brand walk (diagnostic peek only — not trust). */
const ftypHasAvifBrandAligned = (body: Uint8Array): boolean => {
  if (body.byteLength < 16 || readAscii(body, 4, 4) !== "ftyp") return false;
  const size = readU32be(body, 0);
  if (size === undefined || size < 16 || size > body.byteLength) return false;
  const brandsEnd = size;
  if (brandsEnd < 16) return false;
  for (let off = 8; off + 4 <= brandsEnd; off += 4) {
    if (off === 12) continue; // skip minor_version
    const brand = readAscii(body, off, 4).toLowerCase();
    if (brand === "avif" || brand === "avis") return true;
  }
  return false;
};

/** Peek candidate kind from leading magic only (not a trust decision). */
export const peekImageMagic = (body: Uint8Array): ImageKind | undefined => {
  if (startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "png";
  }
  if (startsWith(body, [0xff, 0xd8, 0xff])) {
    return "jpeg";
  }
  if (
    startsWith(body, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) ||
    startsWith(body, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
  ) {
    return "gif";
  }
  if (
    body.byteLength >= 12 &&
    readAscii(body, 0, 4) === "RIFF" &&
    readAscii(body, 8, 4) === "WEBP"
  ) {
    return "webp";
  }
  if (ftypHasAvifBrandAligned(body)) {
    return "avif";
  }
  // Truncated JPEG SOI — diagnostic only, never trust.
  if (body.byteLength >= 2 && body[0] === 0xff && body[1] === 0xd8) {
    return "jpeg";
  }
  return undefined;
};
