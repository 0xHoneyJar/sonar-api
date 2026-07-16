/**
 * Bounded DAS sample classification shared by the Solana recognition adapter
 * and `src/svm/probe-collection.ts`.
 *
 * Pure: no network. Operates on the shared `DasAsset` shape from
 * `nft-collection-source` (plus optional `interface` for coverage typing).
 */
import { parseAsset, type DasAsset } from "../../../svm/nft-collection-source.js";

/** Default interactive recognition / CLI sample size — never paginate beyond page 1. */
export const DEFAULT_DAS_RECOGNITION_SAMPLE_LIMIT = 8;
export const MAX_DAS_RECOGNITION_SAMPLE_LIMIT = 1000;

/**
 * Canonical DAS sample budget boundary shared by adapters, transports, and CLI.
 * Non-finite values are invalid; finite values are integerized and bounded.
 */
export const normalizeDasSampleLimit = (value: number): number | undefined => {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(
    1,
    Math.min(Math.floor(value), MAX_DAS_RECOGNITION_SAMPLE_LIMIT),
  );
};

export const parseDasSampleLimitArgument = (raw: string | undefined): number => {
  const normalized = normalizeDasSampleLimit(Number(raw));
  if (normalized === undefined) {
    throw new RangeError("--sample requires a finite numeric value");
  }
  return normalized;
};

const requireDasSampleLimit = (value: number): number => {
  const normalized = normalizeDasSampleLimit(value);
  if (normalized === undefined) {
    throw new RangeError("DAS sample limit must be finite");
  }
  return normalized;
};

export type DasCoverageKind =
  | "classic"
  | "programmable"
  | "compressed"
  | "mixed"
  | "unknown";

export interface DasSampleClassification {
  readonly coverage: DasCoverageKind;
  /** Wire token_standard for ProbeHitEvidence / CR-001. */
  readonly token_standard: string;
  readonly interfaces: Readonly<Record<string, number>>;
  readonly compressed_count: number;
  readonly sample_size: number;
  readonly dominant_interface: string;
  /**
   * Human-readable label retained for CLI parity with the historical probe
   * (`ProgrammableNFT`, `V1_NFT`, `compressed (cNFT)`, …).
   */
  readonly standard_label: string;
}

export interface ParsedDasSamplePage {
  readonly items: ReadonlyArray<DasAsset>;
}

/**
 * Parse outcomes for a DAS JSON-RPC sample body.
 *
 * Only an explicit successfully decoded `result.items: []` is a conclusive
 * empty page (`ok` with zero items). Missing/null `result`, missing `items`,
 * or malformed schema are typed incomplete/malformed — never coerced to [].
 */
export type DasSampleParseResult =
  | { readonly kind: "ok"; readonly page: ParsedDasSamplePage }
  | { readonly kind: "incomplete"; readonly safe_reason: string }
  | { readonly kind: "malformed"; readonly safe_reason: string }
  | { readonly kind: "rpc_error"; readonly safe_reason: string };

/**
 * Build the single-page `getAssetsByGroup` JSON-RPC body.
 * `groupValue` is the collection mint — passed through byte-for-byte (never lowercased).
 * Always `page: 1` — recognition must not unbounded-paginate.
 */
export const buildDasSampleRequestBody = (input: {
  readonly collection_mint: string;
  readonly limit: number;
  readonly id?: string;
}): {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: "getAssetsByGroup";
  readonly params: {
    readonly groupKey: "collection";
    readonly groupValue: string;
    readonly page: 1;
    readonly limit: number;
  };
} => ({
  jsonrpc: "2.0",
  id: input.id ?? "sonar-das-sample",
  method: "getAssetsByGroup",
  params: {
    groupKey: "collection",
    groupValue: input.collection_mint,
    page: 1,
    limit: requireDasSampleLimit(input.limit),
  },
});

/**
 * Build a bounded `getAsset` JSON-RPC body for collection-mint identity metadata.
 * The id is the collection mint — exact case, never folded.
 */
export const buildDasGetAssetRequestBody = (input: {
  readonly collection_mint: string;
  readonly id?: string;
}): {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: "getAsset";
  readonly params: {
    readonly id: string;
  };
} => ({
  jsonrpc: "2.0",
  id: input.id ?? "sonar-das-get-asset",
  method: "getAsset",
  params: {
    id: input.collection_mint,
  },
});

/**
 * Parse a DAS JSON-RPC sample response without retaining raw provider bodies
 * in returned diagnostics (callers map to typed unavailable).
 */
export const parseDasSampleRpcResponse = (value: unknown): DasSampleParseResult => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "malformed", safe_reason: "das_response_not_object" };
  }
  const root = value as Record<string, unknown>;
  if (root.error !== undefined && root.error !== null) {
    return { kind: "rpc_error", safe_reason: "das_rpc_error" };
  }
  const result = root.result;
  if (result === undefined || result === null) {
    return { kind: "incomplete", safe_reason: "das_result_missing" };
  }
  if (typeof result !== "object" || Array.isArray(result)) {
    return { kind: "malformed", safe_reason: "das_result_not_object" };
  }
  const items = (result as Record<string, unknown>).items;
  if (items === undefined || items === null) {
    return { kind: "incomplete", safe_reason: "das_items_missing" };
  }
  if (!Array.isArray(items)) {
    return { kind: "malformed", safe_reason: "das_items_not_array" };
  }
  const assets: DasAsset[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { kind: "malformed", safe_reason: "das_item_not_object" };
    }
    assets.push(item as DasAsset);
  }
  return { kind: "ok", page: { items: assets } };
};

/**
 * CR-001-aligned Solana public-key structural check (exact case; never folds).
 * Mirrors `@freeside/collection-protocol` `isSolanaPublicKey` without importing
 * Schema into the shared classifier used by the SVM probe CLI.
 */
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const isExactCaseSolanaPublicKey = (value: string): boolean => {
  if (value.length < 32 || value.length > 44) return false;
  let magnitude = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return false;
    magnitude = magnitude * 58n + BigInt(digit);
  }
  let magnitudeBytes = 0;
  let remaining = magnitude;
  while (remaining > 0n) {
    magnitudeBytes += 1;
    remaining >>= 8n;
  }
  let leadingZeroBytes = 0;
  for (const character of value) {
    if (character !== "1") break;
    leadingZeroBytes += 1;
  }
  return magnitudeBytes + leadingZeroBytes === 32;
};

/**
 * Parse a DAS `getAsset` JSON-RPC response into collection-level identity
 * fields only. Requires `result.id` as a non-empty exact-case Solana key —
 * missing/null/malformed id is never usable metadata. Never retains raw
 * provider bodies. Callers MUST still byte-compare `id` to the requested mint.
 */
export const parseDasGetAssetRpcResponse = (
  value: unknown,
):
  | {
      readonly kind: "ok";
      /** Observed `result.id` — never a request-stamped substitute. */
      readonly id: string;
      readonly name?: string;
      readonly symbol?: string;
      readonly image?: string;
    }
  | { readonly kind: "incomplete"; readonly safe_reason: string }
  | { readonly kind: "malformed"; readonly safe_reason: string }
  | { readonly kind: "rpc_error"; readonly safe_reason: string } => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "malformed", safe_reason: "das_get_asset_response_not_object" };
  }
  const root = value as Record<string, unknown>;
  if (root.error !== undefined && root.error !== null) {
    return { kind: "rpc_error", safe_reason: "das_get_asset_rpc_error" };
  }
  const result = root.result;
  if (result === undefined || result === null) {
    return { kind: "incomplete", safe_reason: "das_get_asset_result_missing" };
  }
  if (typeof result !== "object" || Array.isArray(result)) {
    return { kind: "malformed", safe_reason: "das_get_asset_result_not_object" };
  }
  const asset = result as Record<string, unknown>;
  const rawId = asset.id;
  if (rawId === undefined || rawId === null) {
    return { kind: "incomplete", safe_reason: "das_get_asset_id_missing" };
  }
  if (typeof rawId !== "string" || rawId === "") {
    return { kind: "malformed", safe_reason: "das_get_asset_id_malformed" };
  }
  if (!isExactCaseSolanaPublicKey(rawId)) {
    return { kind: "malformed", safe_reason: "das_get_asset_id_malformed" };
  }
  const content = asset.content as DasAsset["content"] | undefined;
  const name =
    content?.metadata?.name !== undefined && content.metadata.name !== ""
      ? content.metadata.name
      : undefined;
  const symbolRaw = (content?.metadata as { symbol?: string } | undefined)?.symbol;
  const symbol =
    typeof symbolRaw === "string" && symbolRaw !== "" ? symbolRaw : undefined;
  const image =
    content?.links?.image !== undefined && content.links.image !== ""
      ? content.links.image
      : undefined;
  return {
    kind: "ok",
    id: rawId,
    ...(name !== undefined ? { name } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
    ...(image !== undefined ? { image } : {}),
  };
};

/** Members with an id + owner — same filter the historical probe CLI used. */
export const filterVerifiedDasSampleMembers = (
  items: ReadonlyArray<DasAsset>,
): DasAsset[] =>
  items.filter((item) => {
    const member = parseAsset(item);
    return member !== null;
  });

/**
 * Classify a bounded DAS sample into classic / programmable / compressed /
 * mixed / unknown coverage. Does not invent index readiness.
 */
export const classifyDasSampleItems = (
  items: ReadonlyArray<DasAsset>,
): DasSampleClassification => {
  const interfaces: Record<string, number> = {};
  let compressed = 0;
  for (const item of items) {
    const iface = item.interface ?? "unknown";
    interfaces[iface] = (interfaces[iface] ?? 0) + 1;
    if (item.compression?.compressed) compressed += 1;
  }

  const sample_size = items.length;
  const dominant_interface =
    Object.entries(interfaces).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";

  if (sample_size === 0) {
    return {
      coverage: "unknown",
      token_standard: "unknown",
      interfaces,
      compressed_count: 0,
      sample_size: 0,
      dominant_interface: "unknown",
      standard_label: "unknown",
    };
  }

  const programmableCount = Object.entries(interfaces)
    .filter(([k]) => /programmable/i.test(k))
    .reduce((sum, [, n]) => sum + n, 0);
  const classicCount = Object.entries(interfaces)
    .filter(([k]) => /^V1_NFT$/i.test(k) || /^V1_PRINT$/i.test(k))
    .reduce((sum, [, n]) => sum + n, 0);

  if (compressed > 0 && compressed === sample_size) {
    return {
      coverage: "compressed",
      token_standard: "compressed_nft",
      interfaces,
      compressed_count: compressed,
      sample_size,
      dominant_interface,
      standard_label: "compressed (cNFT)",
    };
  }

  if (compressed > 0) {
    return {
      coverage: "mixed",
      token_standard: "unknown",
      interfaces,
      compressed_count: compressed,
      sample_size,
      dominant_interface,
      standard_label: "mixed",
    };
  }

  if (programmableCount === sample_size) {
    return {
      coverage: "programmable",
      token_standard: "programmable_nft",
      interfaces,
      compressed_count: 0,
      sample_size,
      dominant_interface,
      standard_label: dominant_interface,
    };
  }

  if (classicCount === sample_size) {
    return {
      coverage: "classic",
      token_standard: "metaplex_collection",
      interfaces,
      compressed_count: 0,
      sample_size,
      dominant_interface,
      standard_label: dominant_interface,
    };
  }

  if (programmableCount > 0 && classicCount > 0) {
    return {
      coverage: "mixed",
      token_standard: "unknown",
      interfaces,
      compressed_count: 0,
      sample_size,
      dominant_interface,
      standard_label: "mixed",
    };
  }

  if (programmableCount > 0) {
    // Dominant programmable with minor unknown interfaces — still programmable.
    if (programmableCount >= Math.ceil(sample_size / 2)) {
      return {
        coverage: "programmable",
        token_standard: "programmable_nft",
        interfaces,
        compressed_count: 0,
        sample_size,
        dominant_interface,
        standard_label: dominant_interface,
      };
    }
    return {
      coverage: "mixed",
      token_standard: "unknown",
      interfaces,
      compressed_count: 0,
      sample_size,
      dominant_interface,
      standard_label: "mixed",
    };
  }

  if (classicCount > 0 && classicCount >= Math.ceil(sample_size / 2)) {
    return {
      coverage: "classic",
      token_standard: "metaplex_collection",
      interfaces,
      compressed_count: 0,
      sample_size,
      dominant_interface,
      standard_label: dominant_interface,
    };
  }

  if (/programmable/i.test(dominant_interface)) {
    return {
      coverage: "programmable",
      token_standard: "programmable_nft",
      interfaces,
      compressed_count: 0,
      sample_size,
      dominant_interface,
      standard_label: dominant_interface,
    };
  }

  if (/^V1_NFT$/i.test(dominant_interface) || /^V1_PRINT$/i.test(dominant_interface)) {
    return {
      coverage: "classic",
      token_standard: "metaplex_collection",
      interfaces,
      compressed_count: 0,
      sample_size,
      dominant_interface,
      standard_label: dominant_interface,
    };
  }

  return {
    coverage: "unknown",
    token_standard: "unknown",
    interfaces,
    compressed_count: 0,
    sample_size,
    dominant_interface,
    standard_label: dominant_interface,
  };
};
