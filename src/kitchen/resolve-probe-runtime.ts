/**
 * Kitchen resolve-probe composition — service-auth only.
 *
 * Modes:
 * - catalog — hardcoded mainnet demo allowlist (no RPC)
 * - live — CR-103 EVM NFT probe over operator-configured HTTP RPC
 * - unavailable — explicit disable
 *
 * Set RESOLVER_MODE=live and optionally ETH_RPC_URL / BASE_RPC_URL /
 * OPTIMISM_RPC_URL / ARBITRUM_RPC_URL / BERACHAIN_RPC_URL / ROBINHOOD_RPC_URL.
 *
 * Live default recognize set (CR-RECOG-PROBE): Ethereum, Base, Optimism,
 * Arbitrum, Berachain — within SEAM ≤8 networks / concurrency ≤6.
 */
import { Effect, Exit } from "effect";

// Import bounded-core directly — kitchen Docker does not ship metadata-egress /
// the full collection-resolver barrel (index.ts re-exports CR-004 ports).
import {
  createHermeticBoundedDeps,
  createProcessMonotonicClock,
  hermeticResolveRequest,
  resolveBounded,
  type BoundedResolveResponse,
  type BoundedResolverDeps,
  type BoundedResolverConfig,
} from "../collection-resolver/bounded-core/index.js";
import {
  createConstantIndexStatusPort,
  createEvmNftProbeAdapter,
} from "../collection-resolver/adapters/evm/index.js";
import {
  defaultLiveRecognizeNetworkCapabilities,
  DEFAULT_REGISTRY_EPOCH,
} from "../collection-resolver/capability-registry/fixtures.js";
import { CAPABILITY_REGISTRY_SCHEMA_VERSION } from "../collection-resolver/capability-registry/schemas.js";
import { decodeCapabilityRegistrySnapshot } from "../collection-resolver/capability-registry/snapshot.js";
import type { ProbeOutcome } from "../collection-resolver/candidate.js";
import type { AdapterProbeRequest } from "../collection-resolver/bounded-core/ports.js";
import { createKitchenContractUriEnrichPort } from "./contract-uri-enrich.js";
import { createHttpEvmRpcPort } from "./http-evm-rpc.js";

export type ResolveProbeRuntimeMode = "catalog" | "live" | "unavailable";

export interface ResolveProbeRuntime {
  readonly mode: ResolveProbeRuntimeMode;
  readonly resolve: (
    identifier: string,
  ) => Promise<
    | { ok: true; body: ResolveProbePublicBody }
    | { ok: false; status: 400 | 503; body: { schema_version: 1; error: { code: string; message: string } } }
  >;
}

/** SDD §5.6 Sonar probe response (Ordering wraps with session fields). */
export interface ResolveProbePublicBody {
  readonly schema_version: 1;
  readonly capability_snapshot_version: BoundedResolveResponse["capability_snapshot_version"];
  readonly candidates: BoundedResolveResponse["candidates"];
  readonly diagnostics: {
    readonly schema_version: 1;
    readonly searched: BoundedResolveResponse["diagnostics"]["searched"];
    readonly timed_out: BoundedResolveResponse["diagnostics"]["timed_out"];
    readonly unavailable: BoundedResolveResponse["diagnostics"]["unavailable"];
  };
}

const CATALOG: ReadonlyArray<{
  readonly address: string;
  readonly name: string;
  readonly symbol: string;
  readonly key: string;
}> = [
  {
    address: "0xabcdef0123456789abcdef0123456789abcdef01",
    name: "Mibera",
    symbol: "MIB",
    key: "mibera",
  },
  {
    address: "0xed5af388653567af2f388e6224dc7c4b3241c544",
    name: "Azuki",
    symbol: "AZUKI",
    key: "azuki",
  },
  {
    address: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d",
    name: "Bored Ape Yacht Club",
    symbol: "BAYC",
    key: "bayc",
  },
  {
    address: "0x60e4d786628fea6478f785a6d7e704777c86a7c6",
    name: "Mutant Ape Yacht Club",
    symbol: "MAYC",
    key: "mayc",
  },
  {
    address: "0xbd3531da5cf5857e7cfaa92426877b022e612b85",
    name: "Pudgy Penguins",
    symbol: "PPG",
    key: "pudgy",
  },
  {
    address: "0x8a90cab2b38dba80c64b7734e58ee1db38b8992e",
    name: "Doodles",
    symbol: "DOODLE",
    key: "doodles",
  },
  {
    address: "0x23581767a106ae21c074b2276d25e5c3e785d2d7",
    name: "Moonbirds",
    symbol: "MOONBIRD",
    key: "moonbirds",
  },
  {
    address: "0x49cf6f5d44e70224e2e23fdcdd2c053f30ada28b",
    name: "CloneX",
    symbol: "CLONEX",
    key: "clonex",
  },
  {
    address: "0x34d85c9cdeb23fa97cb08333b511ac86e1c4e258",
    name: "Otherdeed",
    symbol: "OTHR",
    key: "otherdeed",
  },
  {
    address: "0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb",
    name: "CryptoPunks",
    symbol: "PUNK",
    key: "cryptopunks",
  },
  {
    address: "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
    name: "Milady Maker",
    symbol: "MILADY",
    key: "milady",
  },
  {
    address: "0x9c8ff314c9bc7f6e59a9d9225fb22946427edc03",
    name: "Nouns",
    symbol: "NOUN",
    key: "nouns",
  },
  {
    address: "0x1a92f7381b9f0394d0a18cddfc72ccaf3b5c3f2e",
    name: "Cool Cats",
    symbol: "COOL",
    key: "coolcats",
  },
];

const byAddress = new Map(CATALOG.map((entry) => [entry.address, entry]));

const catalogHit = (request: AdapterProbeRequest): ProbeOutcome => {
  const normalized = request.address.trim().toLowerCase();
  const meta = byAddress.get(normalized);
  if (!meta) return { kind: "miss" };
  return {
    kind: "hit",
    address: normalized,
    token_standard: "erc721",
    name: meta.name,
    symbol: meta.symbol,
    image: `https://images.example.test/${meta.key}.png`,
    recognition: "recognized",
    index_status: "indexed",
    report_readiness: "ready",
    metadata_quality: "onchain",
    observed_at: new Date().toISOString(),
    ranking_reasons: ["supported_standard", "indexed", "exact_inventory_match"],
    evidence_material: {
      adapter: "catalog_v1",
      collection_key: meta.key,
    },
    binding_evidence: {
      code_digest: "11".repeat(32),
      account_digest: "22".repeat(32),
      observed_position: {
        family: "evm",
        block_number: "19000001",
        block_hash: "33".repeat(32),
        finality: "finalized",
      },
      standard_evidence: {
        token_standard: "erc721",
        evidence_quality: "confirmed",
        interface_bits: ["erc165", "erc721"],
      },
      proxy_evidence: { is_proxy: false },
      adapter_policy_version: "resolver-adapter-policy.v1",
      adapter_version: "catalog-evm.v1",
    },
  };
};

function toPublicBody(response: BoundedResolveResponse): ResolveProbePublicBody {
  return {
    schema_version: 1,
    capability_snapshot_version: response.capability_snapshot_version,
    candidates: response.candidates,
    diagnostics: {
      schema_version: 1,
      searched: response.diagnostics.searched,
      timed_out: response.diagnostics.timed_out,
      unavailable: response.diagnostics.unavailable,
    },
  };
}

function createCatalogDeps(): {
  readonly deps: BoundedResolverDeps;
  readonly config: BoundedResolverConfig;
} {
  const clock = createProcessMonotonicClock();
  const { deps, config } = createHermeticBoundedDeps({
    processClock: clock,
    // Catalog hits are Ethereum-mainnet demo rows; other live-default chains miss.
    capabilitySnapshot: loadLiveRecognizeCapabilitySnapshot("3"),
    script: {
      "eip155:1": catalogHit,
      "eip155:8453": { kind: "miss" },
      "eip155:10": { kind: "miss" },
      "eip155:42161": { kind: "miss" },
      "eip155:80094": { kind: "miss" },
    } as never,
  });
  return { deps, config };
}

/** Live Kitchen snapshot: Eth / Base / OP / Arb / Berachain (≤8 SEAM). */
function loadLiveRecognizeCapabilitySnapshot(registrySequence = "4") {
  const exit = Effect.runSyncExit(
    decodeCapabilityRegistrySnapshot({
      schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
      version: {
        registry_epoch: DEFAULT_REGISTRY_EPOCH,
        registry_sequence: registrySequence,
      },
      networks: defaultLiveRecognizeNetworkCapabilities(),
    }),
  );
  if (exit._tag === "Failure") {
    throw new Error("live recognize capability snapshot failed to decode");
  }
  return exit.value;
}

function operatorRpcUrls(
  env: NodeJS.ProcessEnv,
  primaryEnv: string,
  fallbacks: readonly string[],
): readonly string[] {
  const primary = env[primaryEnv]?.trim();
  const urls = [primary, ...fallbacks].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return [...new Set(urls)];
}

function createLiveDeps(env: NodeJS.ProcessEnv): {
  readonly deps: BoundedResolverDeps;
  readonly config: BoundedResolverConfig;
} {
  const clock = createProcessMonotonicClock();
  const rpc = createHttpEvmRpcPort({
    clock,
    urlsByNetwork: {
      // Multi-chain live cut (CR-RECOG-PROBE). Operator env overrides preferred;
      // public HTTPS fallbacks keep local/dev probes unblocked.
      "eip155:1": operatorRpcUrls(env, "ETH_RPC_URL", [
        "https://ethereum-rpc.publicnode.com",
        "https://eth.drpc.org",
      ]),
      "eip155:8453": operatorRpcUrls(env, "BASE_RPC_URL", [
        "https://base-rpc.publicnode.com",
        "https://base.drpc.org",
      ]),
      "eip155:10": operatorRpcUrls(env, "OPTIMISM_RPC_URL", [
        "https://optimism-rpc.publicnode.com",
        "https://optimism.drpc.org",
      ]),
      "eip155:42161": operatorRpcUrls(env, "ARBITRUM_RPC_URL", [
        "https://arbitrum-one-rpc.publicnode.com",
        "https://arbitrum.drpc.org",
      ]),
      "eip155:80094": operatorRpcUrls(env, "BERACHAIN_RPC_URL", [
        "https://berachain-rpc.publicnode.com",
        "https://rpc.berachain.com",
      ]),
      "eip155:4663": operatorRpcUrls(env, "ROBINHOOD_RPC_URL", [
        "https://rpc.mainnet.chain.robinhood.com",
      ]),
    },
  });
  // Lenient indexed so recognized ERC-721/1155 can admit Generate before
  // Kitchen inventory snapshots cover arbitrary contracts.
  const indexStatus = createConstantIndexStatusPort("indexed");
  const metadata = createKitchenContractUriEnrichPort();
  const adapter = createEvmNftProbeAdapter({
    rpc,
    indexStatus,
    metadata,
    clock,
  });
  const hermetic = createHermeticBoundedDeps({
    processClock: clock,
    capabilitySnapshot: loadLiveRecognizeCapabilitySnapshot(),
  });
  return {
    deps: { ...hermetic.deps, adapter },
    config: hermetic.config,
  };
}

function bindResolve(
  deps: BoundedResolverDeps,
  config: BoundedResolverConfig,
): ResolveProbeRuntime["resolve"] {
  return async (identifier) => {
    const exit = await Effect.runPromiseExit(
      resolveBounded({
        request: hermeticResolveRequest(identifier, "ordering-service"),
        config,
        deps,
      }),
    );
    if (Exit.isSuccess(exit)) {
      return { ok: true, body: toPublicBody(exit.value) };
    }
    const label = String(exit.cause);
    const invalid =
      label.includes("StructuralPreflight") ||
      label.includes("Decode") ||
      label.includes("InvalidCollectionIdentifier");
    return {
      ok: false,
      status: invalid ? 400 : 503,
      body: {
        schema_version: 1,
        error: {
          code: invalid ? "invalid_request" : "unavailable",
          message: invalid
            ? "identifier failed structural preflight"
            : "collection resolve-probe failed",
        },
      },
    };
  };
}

export function resolveProbeRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolveProbeRuntime {
  const modeRaw = env.RESOLVER_MODE?.trim().toLowerCase();
  if (modeRaw === "unavailable") {
    return {
      mode: "unavailable",
      resolve: async () => ({
        ok: false,
        status: 503,
        body: {
          schema_version: 1,
          error: {
            code: "unavailable",
            message: "collection resolve-probe is disabled",
          },
        },
      }),
    };
  }

  if (modeRaw === "live") {
    const { deps, config } = createLiveDeps(env);
    return {
      mode: "live",
      resolve: bindResolve(deps, config),
    };
  }

  // Default catalog mode — production-safe with no RPC credentials required.
  const { deps, config } = createCatalogDeps();
  return {
    mode: "catalog",
    resolve: bindResolve(deps, config),
  };
}
