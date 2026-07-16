/**
 * Bounded decompression for metadata egress responses.
 */

import { gunzipSync, inflateSync } from "node:zlib";
import type { MetadataFailureReason } from "./types.js";

export type DecompressResult =
  | { readonly ok: true; readonly body: Uint8Array }
  | {
      readonly ok: false;
      readonly reason: MetadataFailureReason;
      readonly safe_message: string;
    };

export const decompressBounded = (input: {
  readonly body: Uint8Array;
  readonly content_encoding: string | undefined;
  readonly max_decompressed_bytes: number;
}): DecompressResult => {
  const encoding = (input.content_encoding ?? "identity").toLowerCase().trim();
  if (encoding === "" || encoding === "identity") {
    if (input.body.byteLength > input.max_decompressed_bytes) {
      return {
        ok: false,
        reason: "decompressed_size_exceeded",
        safe_message: "identity body exceeds decompressed byte limit",
      };
    }
    return { ok: true, body: input.body };
  }

  if (encoding !== "gzip" && encoding !== "deflate" && encoding !== "x-gzip") {
    return {
      ok: false,
      reason: "content_type_denied",
      safe_message: `unsupported Content-Encoding "${encoding}"`,
    };
  }

  try {
    const decoded =
      encoding === "deflate"
        ? inflateSync(input.body, { maxOutputLength: input.max_decompressed_bytes })
        : gunzipSync(input.body, { maxOutputLength: input.max_decompressed_bytes });
    if (decoded.byteLength > input.max_decompressed_bytes) {
      return {
        ok: false,
        reason: "decompressed_size_exceeded",
        safe_message: "decompressed body exceeds byte limit",
      };
    }
    return { ok: true, body: new Uint8Array(decoded) };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "decompress failed";
    const code =
      cause !== null && typeof cause === "object" && "code" in cause
        ? String((cause as { code?: unknown }).code)
        : "";
    if (
      /maxOutputLength|too large|range|ERR_BUFFER_TOO_LARGE|Cannot create a Buffer larger/i.test(
        `${code} ${message}`,
      )
    ) {
      return {
        ok: false,
        reason: "decompressed_size_exceeded",
        safe_message: "decompression expansion exceeded byte limit",
      };
    }
    return {
      ok: false,
      reason: "hostile_content",
      safe_message: "compressed body could not be safely decoded",
    };
  }
};
