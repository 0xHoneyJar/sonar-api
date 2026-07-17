/**
 * Kitchen-scoped contractURI enrich for resolve-probe live mode.
 *
 * Fetches remote collection metadata JSON (HTTPS / ipfs gateway rewrite only).
 * Returns name/symbol/image pointers for candidate display — not CR-004 trusted
 * image bytes. Image URLs remain untrusted until inventory/proxy admission.
 */
import type { EvmMetadataEnrichPort } from "../collection-resolver/adapters/evm/ports.js";

const MAX_BYTES = 64_000;
const FETCH_TIMEOUT_MS = 2_500;

const rewriteUri = (uri: string): string | undefined => {
  const trimmed = uri.trim();
  if (trimmed.length === 0 || trimmed.length > 2_048) return undefined;
  if (trimmed.startsWith("ipfs://")) {
    const path = trimmed.slice("ipfs://".length).replace(/^ipfs\//, "");
    if (path.length === 0) return undefined;
    return `https://ipfs.io/ipfs/${path}`;
  }
  if (trimmed.startsWith("https://")) return trimmed;
  return undefined;
};

const asOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return undefined;
  return trimmed;
};

export const createKitchenContractUriEnrichPort = (): EvmMetadataEnrichPort => ({
  enrich: async (input) => {
    const url = rewriteUri(input.uri);
    if (url === undefined) {
      return {
        metadata_quality: "partial",
        name: undefined,
        symbol: undefined,
        image: undefined,
      };
    }

    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort();
    input.abort.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      if (input.abort.aborted) {
        return {
          metadata_quality: "unavailable",
          name: undefined,
          symbol: undefined,
          image: undefined,
        };
      }
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json, text/plain;q=0.5" },
        signal: controller.signal,
        redirect: "follow",
      });
      if (!response.ok) {
        return {
          metadata_quality: "partial",
          name: undefined,
          symbol: undefined,
          image: undefined,
        };
      }
      const buf = await response.arrayBuffer();
      if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
        return {
          metadata_quality: "partial",
          name: undefined,
          symbol: undefined,
          image: undefined,
        };
      }
      const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      let json: unknown;
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        return {
          metadata_quality: "partial",
          name: undefined,
          symbol: undefined,
          image: undefined,
        };
      }
      if (json === null || typeof json !== "object") {
        return {
          metadata_quality: "partial",
          name: undefined,
          symbol: undefined,
          image: undefined,
        };
      }
      const record = json as Record<string, unknown>;
      const name = asOptionalString(record.name);
      const symbol = asOptionalString(record.symbol);
      const imageRaw = asOptionalString(record.image) ?? asOptionalString(record.image_url);
      const image = imageRaw !== undefined ? rewriteUri(imageRaw) : undefined;
      const hasAny = name !== undefined || symbol !== undefined || image !== undefined;
      return {
        metadata_quality: hasAny ? "external_pointer" : "partial",
        name,
        symbol,
        image,
      };
    } catch {
      return {
        metadata_quality: "unavailable",
        name: undefined,
        symbol: undefined,
        image: undefined,
      };
    } finally {
      clearTimeout(timer);
      input.abort.removeEventListener("abort", onParentAbort);
    }
  },
});
