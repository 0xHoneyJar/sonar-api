/*
 * tracked-nft-contracts.ts — contract identity derived from the ACTIVE belt config
 * rather than hand-maintained TypeScript maps. Two things come out of one parse:
 *
 *   1. WHICH contracts are eligible for sale attribution (every bound address)
 *   2. WHAT each ERC-721 collection is CALLED (`primaryCollection`, from its comment)
 *
 * Why: Kitchen patches config.yaml when a community is onboarded
 * (src/kitchen/config-patcher.ts) but never touched the TypeScript lists, so an
 * onboarded collection got holder tracking and nothing else. Three lists encoded that
 * defect; bug-20260725-224d57 removed two (TRANSFER_TRACKED_COLLECTIONS,
 * seaport.ts TRACKED_COLLECTIONS) and sprint-bug-191 removes the third
 * (TRACKED_ERC721_COLLECTION_KEYS). config.yaml is the single source of truth.
 *
 * Every bound address is eligible for sale attribution, with no per-handler name list
 * to maintain. The trade-off: a name allowlist silently drops a collection the moment a
 * new handler class is added, which is the failure mode this module exists to kill.
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
import { isScalar, isSeq, parseDocument, type Document } from "yaml";

/** chainId → set of lowercased contract addresses bound on that chain. */
export type BoundContracts = ReadonlyMap<number, ReadonlySet<string>>;

/** chainId → lowercased address → collection key (`primaryCollection`). */
export type CollectionKeys = ReadonlyMap<number, ReadonlyMap<string, string>>;

/**
 * Contract definitions whose addresses are ERC-721 collections routed to
 * `handleTrackedErc721Transfer`. These are the two names that handler registers for
 * (`src/handlers/tracked-erc721.ts` — `indexer.onEvent({contract: …})`), NOT a
 * collection list: adding a collection under either name needs no edit here.
 *
 * Scoping matters because collection keys must be globally unique, and the other
 * contract definitions are not collections — Seaport alone is bound four times per
 * chain with `# Seaport v1.1`-style comments that would all derive to "seaport".
 */
const COLLECTION_CONTRACT_NAMES: ReadonlySet<string> = new Set([
  "TrackedErc721",
  "EthTrackedErc721",
]);

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/**
 * A collection key must be a bare slug — the shape every existing key already has
 * (`based_punks`, `mireveal_4_20`, `veecon_2024_tickets`). Anything else is prose that
 * happened to land first in the comment, and naming a collection after it would be
 * worse than leaving it unnamed.
 */
const COLLECTION_KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** One address as bound in the config, with the trailing `#` comment that names it. */
type Binding = {
  chainId: number;
  contractName: string;
  /** Lowercased `0x…`. */
  address: string;
  /** Trailing `#` comment, trimmed. Empty string when there is none. */
  comment: string;
};

/**
 * Walk `chains[].contracts[].address[]`, preserving each address's trailing comment.
 *
 * `schema: "failsafe"` keeps every scalar a string. Most addresses in config.yaml are
 * unquoted, and an unquoted 0x… scalar is a valid YAML 1.1 hex integer — the default
 * schema parses it as a number and the address is destroyed. This is the same hazard
 * Envio guards against when it writes configs (its quote_known_addresses helper);
 * reading has to defend against it too.
 *
 * `parseDocument` rather than `parse` because comments only survive on the document
 * AST, and the comment is where the collection's name lives.
 */
function walkBindings(configText: string): Binding[] {
  const doc: Document = parseDocument(configText, { schema: "failsafe" });
  if (doc.errors.length > 0) throw new Error(doc.errors[0].message);

  const out: Binding[] = [];
  // Envio's per-chain bindings live under the top-level `chains:` key; the top-level
  // `contracts:` key holds ABI/event definitions with no addresses.
  const chains = doc.get("chains", true);
  if (!isSeq(chains)) return out;

  for (const chain of chains.items) {
    if (typeof (chain as { get?: unknown })?.get !== "function") continue;
    const chainNode = chain as { get(k: string, keep?: boolean): unknown };
    const chainId = Number(chainNode.get("id"));
    if (!Number.isFinite(chainId)) continue;

    const contracts = chainNode.get("contracts", true);
    if (!isSeq(contracts)) continue;

    for (const contract of contracts.items) {
      if (typeof (contract as { get?: unknown })?.get !== "function") continue;
      const contractNode = contract as { get(k: string, keep?: boolean): unknown };
      const contractName = String(contractNode.get("name") ?? "");

      // `address` is either a scalar or a list, and may be quoted or bare.
      const raw = contractNode.get("address", true);
      const items = isSeq(raw) ? raw.items : raw == null ? [] : [raw];
      for (const item of items) {
        if (!isScalar(item)) continue;
        const address = String(item.value).trim().toLowerCase();
        // Lowercased on ingest: every lookup compares lowercased, and a checksummed
        // key silently matches nothing (the prior R-12 defect).
        if (!ADDRESS_RE.test(address)) continue;
        out.push({
          chainId,
          contractName,
          address,
          comment: (item.comment ?? "").trim(),
        });
      }
    }
  }
  return out;
}

/**
 * Parse a belt config into chainId → bound addresses. Pure; the caller supplies the
 * text so this is testable without touching the filesystem.
 */
export function extractBoundContracts(configText: string): BoundContracts {
  const out = new Map<number, Set<string>>();
  for (const b of walkBindings(configText)) {
    const addresses = out.get(b.chainId) ?? new Set<string>();
    addresses.add(b.address);
    out.set(b.chainId, addresses);
  }
  return out;
}

/**
 * The collection key carried by an address's trailing comment: its first
 * whitespace-delimited token.
 *
 *     - 0xcb28749c… # based_punks (deploy 12774442)   →  "based_punks"
 *
 * Returns null when there is no comment, or when the first token is not a bare slug.
 * The caller falls back to the raw address — an unnamed collection is still indexed,
 * just unnamed.
 */
export function collectionKeyFromComment(comment: string): string | null {
  const token = comment.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return COLLECTION_KEY_RE.test(token) ? token : null;
}

/** What `deriveCollectionKeys` found, so the caller can report it rather than guess. */
export type CollectionKeyDerivation = {
  keys: CollectionKeys;
  /** Bound addresses with no usable key, as `chainId:address`. */
  unnamed: string[];
  /** key → the `chainId:address` bindings that claimed it (only entries with ≥2). */
  duplicates: Map<string, string[]>;
};

/**
 * Derive `address → collectionKey` for every ERC-721 collection bound in the config.
 * Pure, so the parity test can assert over config text without a filesystem or console.
 *
 * Duplicate keys are DROPPED, not resolved. Two collections sharing a key would merge
 * silently in every downstream join — strictly worse than both staying raw addresses,
 * which at least keeps them distinct. Picking a winner would corrupt one collection's
 * history in a way no consumer could detect.
 */
export function deriveCollectionKeys(configText: string): CollectionKeyDerivation {
  const claims = new Map<string, string[]>();
  const unnamed: string[] = [];
  const candidates: Array<{ chainId: number; address: string; key: string }> = [];

  for (const b of walkBindings(configText)) {
    if (!COLLECTION_CONTRACT_NAMES.has(b.contractName)) continue;
    const key = collectionKeyFromComment(b.comment);
    if (key === null) {
      unnamed.push(`${b.chainId}:${b.address}`);
      continue;
    }
    candidates.push({ chainId: b.chainId, address: b.address, key });
    claims.set(key, [...(claims.get(key) ?? []), `${b.chainId}:${b.address}`]);
  }

  const duplicates = new Map(
    [...claims].filter(([, bindings]) => bindings.length > 1),
  );

  const keys = new Map<number, Map<string, string>>();
  for (const c of candidates) {
    if (duplicates.has(c.key)) continue;
    const perChain = keys.get(c.chainId) ?? new Map<string, string>();
    perChain.set(c.address, c.key);
    keys.set(c.chainId, perChain);
  }

  return { keys, unnamed, duplicates };
}

/** The config the running belt was started with. */
export function activeConfigPath(): string {
  return process.env.BELT_CONFIG ?? "config.yaml";
}

type Parsed = { bound: BoundContracts; collections: CollectionKeys };

const EMPTY: Parsed = { bound: new Map(), collections: new Map() };

/**
 * How long a failed read is allowed to suppress retries. Bounds the cost of the failure
 * path without making it permanent — see `parsedConfig`.
 */
const READ_RETRY_INTERVAL_MS = 5_000;

let cached: Parsed | null = null;
let readFailureLogged = false;
let readFailedUntil = 0;

/**
 * Parse the active belt config once per process.
 *
 * Failure is soft: if the config cannot be read, no contract is eligible, no collection
 * is named, and sales are skipped rather than mis-attributed. A crash here would take
 * down indexing for every handler, not just sale attribution.
 *
 * Soft MUST NOT mean silent (audit MEDIUM-2). An unreadable config disables sale
 * attribution process-wide while indexing still looks healthy, and "no sales recorded"
 * is indistinguishable from "this chain had no sales" — the exact shape of the bug this
 * module exists to fix. Every failure mode below is logged once.
 *
 * Soft also MUST NOT mean unbounded (review MEDIUM-1). A failed read is not cached
 * permanently (BB SEA-004: one transient FS error must not disable sale attribution for
 * the process lifetime) — but since sprint-bug-191 the caller is every ERC-721 Transfer,
 * not just Seaport fills, so retrying per event would mean millions of failing
 * `readFileSync` calls during a cold backfill. The one-shot log would hide it: the
 * operator sees a single error line and then a belt that is inexplicably slow. Retries
 * are therefore rate-limited rather than removed, which keeps the self-healing.
 */
function parsedConfig(): Parsed {
  if (cached) return cached;
  if (Date.now() < readFailedUntil) return EMPTY;
  try {
    const text = readFileSync(activeConfigPath(), "utf8");
    const bound = extractBoundContracts(text);
    const { keys, unnamed, duplicates } = deriveCollectionKeys(text);

    if (bound.size === 0) {
      console.error(
        `[tracked-nft-contracts] ${activeConfigPath()} parsed to zero bound contracts — ` +
          `sale attribution is DISABLED for every chain. Check the config's chains[].contracts[].address entries.`,
      );
    }
    for (const [key, bindings] of duplicates) {
      console.error(
        `[tracked-nft-contracts] collection key "${key}" is claimed by ${bindings.length} ` +
          `bindings (${bindings.join(", ")}) — ALL of them fall back to their raw address ` +
          `rather than silently merging into one collection. Fix the comments in ${activeConfigPath()}.`,
      );
    }
    if (unnamed.length > 0) {
      console.warn(
        `[tracked-nft-contracts] ${unnamed.length} bound ERC-721 contract(s) have no usable ` +
          `collection key and will report a raw address as primaryCollection: ${unnamed.join(", ")}. ` +
          `Add a "# <key>" comment to each in ${activeConfigPath()}.`,
      );
    }

    cached = { bound, collections: keys };
  } catch (err) {
    // Deliberately NOT cached permanently (BB SEA-004): a single transient filesystem
    // error at startup must not disable sale attribution for the whole process lifetime.
    // `cached` stays null so a later read still wins — only the retry RATE is bounded.
    // Note the read resolves relative to the process CWD — a belt launched from a
    // different directory degrades to this path.
    readFailedUntil = Date.now() + READ_RETRY_INTERVAL_MS;
    if (!readFailureLogged) {
      readFailureLogged = true;
      console.error(
        `[tracked-nft-contracts] could not read ${activeConfigPath()} (cwd=${process.cwd()}) — ` +
          `sale attribution is DISABLED and every collection will report a raw address ` +
          `until this read succeeds. Retrying at most every ${READ_RETRY_INTERVAL_MS}ms; ` +
          `indexing continues. Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return EMPTY;
  }
  return cached;
}

/** Bound contracts for the active belt config, read once per process. */
export function boundContracts(): BoundContracts {
  return parsedConfig().bound;
}

/** True when `address` is bound on `chainId` in the active config. */
export function isTrackedNftContract(chainId: number, address: string): boolean {
  return boundContracts().get(chainId)?.has(address.toLowerCase()) ?? false;
}

/**
 * The collection key for a tracked ERC-721 contract, or null when the config does not
 * name it. Callers fall back to the lowercased address.
 */
export function collectionKeyFor(chainId: number, address: string): string | null {
  return (
    parsedConfig().collections.get(chainId)?.get(address.toLowerCase()) ?? null
  );
}

/** Test seam: replace the cached parse. Pass null to restore filesystem loading. */
export function __setParsedConfigForTest(v: Parsed | null): void {
  cached = v;
}
