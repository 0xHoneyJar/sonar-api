/**
 * Observe the token standard of an EVM deployment before Kitchen admits it.
 *
 * The legacy ingest route used to assert `erc721`, so a 1155 (sonar-api#185 /
 * #186 / #200) or a codeless address (#204) was admitted and silently
 * mis-indexed. Detection is ERC-165 over the same injected EvmRpcPort the
 * CR-103 resolve-probe uses, and it FAILS CLOSED: an unreachable RPC, a
 * reverting `supportsInterface` (#201, CryptoPunks), or an ambiguous answer is
 * a refusal — never a fallback to erc721.
 */
import { Effect } from "effect";

import { networkIdentityKey } from "../collection-resolver/capability-registry/keys.js";
import type {
  EvmFinalityPolicy,
  NetworkCapability,
} from "../collection-resolver/capability-registry/schemas.js";
import { defaultLiveRecognizeNetworkCapabilities } from "../collection-resolver/capability-registry/fixtures.js";
import type { MonotonicClock } from "../collection-resolver/bounded-core/clock.js";
import { createProcessMonotonicClock } from "../collection-resolver/bounded-core/index.js";
import {
  decodeAbiBool,
  ERC1155_SUPPORTS_CALLDATA,
  ERC165_SUPPORTS_CALLDATA,
  ERC721_SUPPORTS_CALLDATA,
  INVALID_INTERFACE_SUPPORTS_CALLDATA,
  isEmptyBytecode,
} from "../collection-resolver/adapters/evm/abi.js";
import { classifyStandard } from "../collection-resolver/adapters/evm/evidence.js";
import { isValidBytecodeHex } from "../collection-resolver/adapters/evm/digests.js";
import type {
  EthCallResult,
  EvmObservationBlock,
  EvmRpcPort,
} from "../collection-resolver/adapters/evm/ports.js";
import type { NetworkRef } from "../collection-resolver/protocol.js";
import { createHttpEvmRpcPort } from "./http-evm-rpc.js";
import { liveEvmRpcUrlsByNetwork } from "./resolve-probe-runtime.js";
import type { TokenStandard } from "./types.js";

/** Refusal classes. Each maps to an honest 4xx, never to an admitted job. */
export type StandardDetectionRefusalCode =
  | "no_contract_code"
  | "standard_inconclusive"
  | "detection_unavailable";

export type StandardDetection =
  | { readonly ok: true; readonly tokenStandard: TokenStandard }
  | {
      readonly ok: false;
      readonly code: StandardDetectionRefusalCode;
      readonly reason: string;
    };

/** Injected at the route boundary so tests never touch the network. */
export interface TokenStandardDetector {
  readonly detect: (input: {
    readonly network: NetworkRef;
    readonly address: `0x${string}`;
  }) => Promise<StandardDetection>;
}

/** Whole-detection budget. One block pin + five bounded reads. */
const DETECTION_BUDGET_MS = 8_000;

const callBool = (result: EthCallResult): boolean | undefined =>
  result.kind === "revert" ? undefined : decodeAbiBool(result.data);

export interface EvmRpcStandardDetectorDeps {
  readonly rpc: EvmRpcPort;
  /** networkIdentityKey → finality policy for the pinned observation block. */
  readonly finalityByNetwork: Readonly<Record<string, EvmFinalityPolicy>>;
  readonly clock: MonotonicClock;
  readonly budgetMs?: number;
}

export function createEvmRpcTokenStandardDetector(
  deps: EvmRpcStandardDetectorDeps,
): TokenStandardDetector {
  const budgetMs = deps.budgetMs ?? DETECTION_BUDGET_MS;

  return {
    detect: async ({ network, address }) => {
      if (network.network_namespace !== "eip155") {
        return {
          ok: false,
          code: "detection_unavailable",
          reason: `token standard detection is EVM-only; ${network.network_namespace} is unsupported`,
        };
      }

      const networkKey = networkIdentityKey(network);
      const finality = deps.finalityByNetwork[networkKey];
      if (finality === undefined) {
        return {
          ok: false,
          code: "detection_unavailable",
          reason: `no token standard detection policy configured for ${networkKey}`,
        };
      }

      const abort = new AbortController();
      const deadline_at_ms = deps.clock.nowMs() + budgetMs;
      const unavailable = (detail: string): StandardDetection => ({
        ok: false,
        code: "detection_unavailable",
        reason: `token standard could not be observed for ${networkKey} (${detail}); admission refused rather than assuming erc721`,
      });

      const blockExit = await Effect.runPromise(
        deps.rpc
          .resolveObservationBlock({
            network,
            finality_policy: finality,
            abort: abort.signal,
            deadline_at_ms,
          })
          .pipe(Effect.either),
      );
      if (blockExit._tag === "Left") return unavailable(blockExit.left.safe_code);
      const block: EvmObservationBlock = blockExit.right;

      const codeExit = await Effect.runPromise(
        deps.rpc
          .getCode({ network, address, block, abort: abort.signal, deadline_at_ms })
          .pipe(Effect.either),
      );
      if (codeExit._tag === "Left") return unavailable(codeExit.left.safe_code);
      if (!isValidBytecodeHex(codeExit.right)) return unavailable("rpc_invalid_response");
      if (isEmptyBytecode(codeExit.right)) {
        return {
          ok: false,
          code: "no_contract_code",
          reason: `${address} has no contract code on ${networkKey}; nothing to index`,
        };
      }

      const read = (data: `0x${string}`) =>
        Effect.runPromise(
          deps.rpc
            .ethCall({ network, to: address, data, block, abort: abort.signal, deadline_at_ms })
            .pipe(Effect.either),
        );

      // Establish ERC-165 itself before trusting any claimed NFT interface.
      const erc165Exit = await read(ERC165_SUPPORTS_CALLDATA);
      if (erc165Exit._tag === "Left") return unavailable(erc165Exit.left.safe_code);
      const invalidExit = await read(INVALID_INTERFACE_SUPPORTS_CALLDATA);
      if (invalidExit._tag === "Left") return unavailable(invalidExit.left.safe_code);
      const erc165Valid =
        callBool(erc165Exit.right) === true && callBool(invalidExit.right) === false;

      const erc721Exit = await read(ERC721_SUPPORTS_CALLDATA);
      if (erc721Exit._tag === "Left") return unavailable(erc721Exit.left.safe_code);
      const erc1155Exit = await read(ERC1155_SUPPORTS_CALLDATA);
      if (erc1155Exit._tag === "Left") return unavailable(erc1155Exit.left.safe_code);

      // A healthy revert is absent evidence (CryptoPunks predates ERC-165),
      // which classifies as unknown — a refusal, not an erc721 guess.
      const { standard } = classifyStandard({
        erc721: erc165Valid ? callBool(erc721Exit.right) : undefined,
        erc1155: erc165Valid ? callBool(erc1155Exit.right) : undefined,
      });

      if (standard === "unknown") {
        return {
          ok: false,
          code: "standard_inconclusive",
          reason: `${address} on ${networkKey} does not report a single ERC-165 NFT interface; admission refused rather than assuming erc721`,
        };
      }
      return { ok: true, tokenStandard: standard };
    },
  };
}

const evmFinalityByNetwork = (
  capabilities: readonly NetworkCapability[],
): Record<string, EvmFinalityPolicy> => {
  const out: Record<string, EvmFinalityPolicy> = {};
  for (const capability of capabilities) {
    if (capability.finality_policy.family !== "evm") continue;
    out[networkIdentityKey(capability.network)] = capability.finality_policy;
  }
  return out;
};

/**
 * Production detector — operator RPC env with the same public HTTPS fallbacks
 * the live resolve-probe uses, so admission detection needs no new wiring.
 */
export function tokenStandardDetectorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TokenStandardDetector {
  const clock = createProcessMonotonicClock();
  return createEvmRpcTokenStandardDetector({
    rpc: createHttpEvmRpcPort({ clock, urlsByNetwork: liveEvmRpcUrlsByNetwork(env) }),
    finalityByNetwork: evmFinalityByNetwork(defaultLiveRecognizeNetworkCapabilities()),
    clock,
  });
}
