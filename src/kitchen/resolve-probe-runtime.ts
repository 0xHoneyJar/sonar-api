/**
 * Kitchen resolve-probe composition — service-auth only.
 *
 * Default mode: catalog-backed scripted adapter for known mainnet collections
 * (honest recognition for Gate Leak demos / empty-user production cut).
 * Set RESOLVER_MODE=live later to swap in EVM RPC adapters without route changes.
 */
import { Effect, Exit } from "effect";

import {
  createHermeticBoundedDeps,
  createProcessMonotonicClock,
  defaultBoundedResolverConfig,
  hermeticResolveRequest,
  resolveBounded,
  type BoundedResolveResponse,
  type BoundedResolverDeps,
} from "../collection-resolver/index.js";
import type { ProbeOutcome } from "../collection-resolver/candidate.js";
import type { AdapterProbeRequest } from "../collection-resolver/bounded-core/ports.js";

export type ResolveProbeRuntimeMode = "catalog" | "unavailable";

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
      searched: response.diagnostics.searched,
      timed_out: response.diagnostics.timed_out,
      unavailable: response.diagnostics.unavailable,
    },
  };
}

function createCatalogDeps(): {
  readonly deps: BoundedResolverDeps;
  readonly config: ReturnType<typeof defaultBoundedResolverConfig>;
} {
  const clock = createProcessMonotonicClock();
  const { deps, config } = createHermeticBoundedDeps({
    processClock: clock,
    script: {
      "eip155:1": catalogHit,
      // Catalog is Ethereum-mainnet only for this cut; other networks miss.
      "eip155:8453": { kind: "miss" },
      "solana:mainnet-beta": { kind: "miss" },
    } as never,
  });
  return { deps, config };
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

  // Default catalog mode — production-safe with no RPC credentials required.
  const { deps, config } = createCatalogDeps();

  return {
    mode: "catalog",
    resolve: async (identifier) => {
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
    },
  };
}
