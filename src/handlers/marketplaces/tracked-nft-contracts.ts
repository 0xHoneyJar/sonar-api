/*
 * tracked-nft-contracts.ts — the set of NFT contracts eligible for sale attribution,
 * derived from the ACTIVE belt config rather than a hand-maintained TypeScript map.
 *
 * Why: Kitchen patches config.yaml when a community is onboarded
 * (src/kitchen/config-patcher.ts) but never touched seaport.ts's TRACKED_COLLECTIONS,
 * so onboarded collections could never produce a sale row (bug-20260725-224d57 F2).
 * config.yaml is the single source of truth for coverage; this reads it.
 *
 * Every bound address is eligible, with no per-handler name list to maintain. The
 * trade-off: a name allowlist silently drops a collection the moment a new handler
 * class is added, which is the failure mode this module exists to kill.
 *
 * Bounded caveat (BB SEA-008): including non-NFT bindings is very nearly inert, but
 * not provably so. Seaport does not validate item token types, and ERC-20's
 * `transferFrom(address,address,uint256)` shares a selector with ERC-721's, so a
 * crafted order can declare a bound ERC-20 or vault as an itemType-2 item and fill
 * successfully — emitting a sale row for a non-collection contract. Impact is bounded
 * (two-wallet wash trades against real collections are already possible), but
 * consumers should filter to known collections rather than trust every bound address.
 *
 * Addresses are keyed by chainId so the same address on two chains cannot cross-match.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";

/** chainId → set of lowercased contract addresses bound on that chain. */
export type BoundContracts = ReadonlyMap<number, ReadonlySet<string>>;

/**
 * Parse a belt config into chainId → bound addresses. Pure; the caller supplies the
 * text so this is testable without touching the filesystem.
 */
export function extractBoundContracts(configText: string): BoundContracts {
  // Envio's per-chain bindings live under the top-level `chains:` key; the
  // top-level `contracts:` key holds ABI/event definitions with no addresses.
  //
  // `schema: "failsafe"` keeps every scalar a string. Most addresses in config.yaml
  // are unquoted, and an unquoted 0x… scalar is a valid YAML 1.1 hex integer — the
  // default schema parses it as a number and the address is destroyed. This is the
  // same hazard Envio guards against when it writes configs (its quote_known_addresses
  // helper); reading has to defend against it too.
  const doc = parse(configText, { schema: "failsafe" }) as
    | { chains?: Array<{ id?: string; contracts?: Array<{ address?: unknown }> }> }
    | null;

  const out = new Map<number, Set<string>>();
  for (const chain of doc?.chains ?? []) {
    const chainId = Number(chain?.id);
    if (!Number.isFinite(chainId)) continue;

    const addresses = out.get(chainId) ?? new Set<string>();
    for (const contract of chain?.contracts ?? []) {
      // `address` is either a scalar or a list, and may be quoted or bare.
      const raw = contract?.address;
      const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
      for (const v of values) {
        const addr = String(v).trim().toLowerCase();
        // Lowercased on ingest: every lookup compares lowercased, and a
        // checksummed key silently matches nothing (the prior R-12 defect).
        if (/^0x[0-9a-f]{40}$/.test(addr)) addresses.add(addr);
      }
    }
    if (addresses.size > 0) out.set(chainId, addresses);
  }
  return out;
}

/** The config the running belt was started with. */
export function activeConfigPath(): string {
  return process.env.BELT_CONFIG ?? "config.yaml";
}

let cached: BoundContracts | null = null;
let readFailureLogged = false;

/**
 * Bound contracts for the active belt config, read once per process.
 *
 * Failure is soft: if the config cannot be read, no contract is eligible and sales
 * are skipped rather than mis-attributed. A crash here would take down indexing for
 * every handler, not just sale attribution.
 *
 * Soft MUST NOT mean silent (audit MEDIUM-2). An unreadable config disables sale
 * attribution process-wide while indexing still looks healthy, and "no sales
 * recorded" is indistinguishable from "this chain had no sales" — the exact shape of
 * the bug this module exists to fix. Both failure modes are logged once.
 */
export function boundContracts(): BoundContracts {
  if (cached) return cached;
  try {
    cached = extractBoundContracts(readFileSync(activeConfigPath(), "utf8"));
    if (cached.size === 0) {
      console.error(
        `[tracked-nft-contracts] ${activeConfigPath()} parsed to zero bound contracts — ` +
          `sale attribution is DISABLED for every chain. Check the config's chains[].contracts[].address entries.`,
      );
    }
  } catch (err) {
    // Deliberately NOT cached (BB SEA-004): caching an empty map here would let a
    // single transient filesystem error at startup disable sale attribution for the
    // whole process lifetime. Leaving `cached` null means the next event retries.
    // Note the read resolves relative to the process CWD — a belt launched from a
    // different directory degrades to this path.
    if (!readFailureLogged) {
      readFailureLogged = true;
      console.error(
        `[tracked-nft-contracts] could not read ${activeConfigPath()} (cwd=${process.cwd()}) — ` +
          `sale attribution is DISABLED until this read succeeds. Indexing continues; ` +
          `sale rows will be absent. Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return new Map();
  }
  return cached;
}

/** True when `address` is bound on `chainId` in the active config. */
export function isTrackedNftContract(chainId: number, address: string): boolean {
  return boundContracts().get(chainId)?.has(address.toLowerCase()) ?? false;
}

/** Test seam: replace the cached set. Pass null to restore filesystem loading. */
export function __setBoundContractsForTest(v: BoundContracts | null): void {
  cached = v;
}
