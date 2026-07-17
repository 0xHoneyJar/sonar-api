/**
 * Server-only boundary markers for CR-004 metadata egress.
 *
 * This module must never be imported from browser bundles. The companion
 * hermetic test proves there is no client/browser package in this repo that
 * fetches arbitrary metadata origins.
 */

export const METADATA_EGRESS_RUNTIME = "node" as const;

/** Guard used by workers before opening the egress boundary. */
export const assertServerOnlyMetadataEgress = (): void => {
  const g = globalThis as { window?: unknown; document?: unknown };
  if (typeof g.window !== "undefined" || typeof g.document !== "undefined") {
    throw new Error(
      "metadata egress is server-only; browser code must not fetch arbitrary metadata origins",
    );
  }
};
