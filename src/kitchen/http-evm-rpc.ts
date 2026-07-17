/**
 * Operator-configured HTTP JSON-RPC EvmRpcPort for Kitchen resolve-probe live mode.
 *
 * Never accepts user-supplied RPC URLs — only env/operator wiring. Failures map
 * to typed EvmRpcFailure codes; responses never include provider URLs or bodies.
 */
import { Effect } from "effect";

import type { MonotonicClock } from "../collection-resolver/bounded-core/clock.js";
import { networkIdentityKey } from "../collection-resolver/capability-registry/keys.js";
import type { EvmFinalityPolicy } from "../collection-resolver/capability-registry/schemas.js";
import {
  SAFE_MESSAGES,
  type EvmRpcSafeErrorCode,
} from "../collection-resolver/adapters/evm/constants.js";
import {
  evmRpcFailure,
  type EthCallResult,
  type EvmObservationBlock,
  type EvmRpcFailure,
  type EvmRpcPort,
} from "../collection-resolver/adapters/evm/ports.js";

export interface HttpEvmRpcPortOptions {
  /** networkIdentityKey → ordered HTTPS RPC URLs (operator-set only). */
  readonly urlsByNetwork: Readonly<Record<string, readonly string[]>>;
  readonly clock: MonotonicClock;
}

type JsonRpcOk = { readonly result: unknown };
type JsonRpcErr = { readonly error: { readonly message?: string } };

const fail = (code: EvmRpcSafeErrorCode): EvmRpcFailure =>
  evmRpcFailure(code, SAFE_MESSAGES[code]);

const isHexData = (value: unknown): value is `0x${string}` =>
  typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);

const blockTagFromPolicy = (policy: EvmFinalityPolicy): string => {
  const confirmation = policy.confirmation;
  if (confirmation.kind === "finalized_tag") {
    return confirmation.finalized_tag;
  }
  return "latest";
};

export const createHttpEvmRpcPort = (options: HttpEvmRpcPortOptions): EvmRpcPort => {
  const clock = options.clock;
  let nextId = 1;

  const rpcCall = (input: {
    readonly networkKey: string;
    readonly method: string;
    readonly params: readonly unknown[];
    readonly abort: AbortSignal;
    readonly deadline_at_ms: number;
  }): Effect.Effect<unknown, EvmRpcFailure> =>
    Effect.tryPromise({
      try: async () => {
        if (input.abort.aborted || clock.nowMs() >= input.deadline_at_ms) {
          throw fail(
            input.abort.aborted ? "rpc_aborted" : "rpc_timeout",
          );
        }
        const urls = options.urlsByNetwork[input.networkKey];
        if (urls === undefined || urls.length === 0) {
          throw fail("rpc_unsupported_network");
        }

        let lastCode: EvmRpcSafeErrorCode = "rpc_transport_failed";
        for (const url of urls) {
          if (input.abort.aborted || clock.nowMs() >= input.deadline_at_ms) {
            throw fail(
              input.abort.aborted ? "rpc_aborted" : "rpc_timeout",
            );
          }
          const remaining = Math.max(1, input.deadline_at_ms - clock.nowMs());
          const controller = new AbortController();
          const onParentAbort = (): void => controller.abort();
          input.abort.addEventListener("abort", onParentAbort, { once: true });
          const timer = setTimeout(() => controller.abort(), remaining);
          try {
            const response = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: nextId++,
                method: input.method,
                params: input.params,
              }),
              signal: controller.signal,
            });
            if (!response.ok) {
              lastCode = "rpc_transport_failed";
              continue;
            }
            const body = (await response.json()) as JsonRpcOk | JsonRpcErr;
            if ("error" in body && body.error !== undefined) {
              lastCode = "rpc_invalid_response";
              continue;
            }
            if (!("result" in body)) {
              lastCode = "rpc_invalid_response";
              continue;
            }
            return body.result;
          } catch (cause) {
            if (input.abort.aborted) throw fail("rpc_aborted");
            if (clock.nowMs() >= input.deadline_at_ms) throw fail("rpc_timeout");
            if (
              cause !== null &&
              typeof cause === "object" &&
              "_tag" in cause &&
              (cause as EvmRpcFailure)._tag === "EvmRpcFailure"
            ) {
              throw cause as EvmRpcFailure;
            }
            lastCode = "rpc_transport_failed";
          } finally {
            clearTimeout(timer);
            input.abort.removeEventListener("abort", onParentAbort);
          }
        }
        throw fail(lastCode);
      },
      catch: (cause) => {
        if (
          cause !== null &&
          typeof cause === "object" &&
          "_tag" in cause &&
          (cause as EvmRpcFailure)._tag === "EvmRpcFailure"
        ) {
          return cause as EvmRpcFailure;
        }
        return fail("rpc_transport_failed");
      },
    });

  return {
    resolveObservationBlock: (input) =>
      Effect.gen(function* () {
        const networkKey = networkIdentityKey(input.network);
        const tag = blockTagFromPolicy(input.finality_policy);
        const tryTag = (blockTag: string, finality: string) =>
          rpcCall({
            networkKey,
            method: "eth_getBlockByNumber",
            params: [blockTag, false],
            abort: input.abort,
            deadline_at_ms: input.deadline_at_ms,
          }).pipe(
            Effect.flatMap((raw) => {
              if (raw === null || typeof raw !== "object") {
                return Effect.fail(fail("rpc_finality_unavailable"));
              }
              const block = raw as { number?: unknown; hash?: unknown };
              if (!isHexData(block.number) || !isHexData(block.hash)) {
                return Effect.fail(fail("rpc_invalid_response"));
              }
              if (block.hash.length !== 66) {
                return Effect.fail(fail("rpc_invalid_response"));
              }
              const observation: EvmObservationBlock = {
                block_number: BigInt(block.number),
                block_hash: block.hash.toLowerCase() as `0x${string}`,
                finality,
              };
              return Effect.succeed(observation);
            }),
          );

        const primary = yield* tryTag(tag, tag).pipe(Effect.either);
        if (primary._tag === "Right") return primary.right;
        // Public endpoints occasionally omit finalized; degrade to latest honestly.
        if (tag !== "latest") {
          return yield* tryTag("latest", "latest");
        }
        return yield* Effect.fail(primary.left);
      }),

    getCode: (input) =>
      rpcCall({
        networkKey: networkIdentityKey(input.network),
        method: "eth_getCode",
        params: [input.address, `0x${input.block.block_number.toString(16)}`],
        abort: input.abort,
        deadline_at_ms: input.deadline_at_ms,
      }).pipe(
        Effect.flatMap((raw) => {
          if (!isHexData(raw)) return Effect.fail(fail("rpc_invalid_response"));
          return Effect.succeed(raw.toLowerCase() as `0x${string}`);
        }),
      ),

    ethCall: (input) =>
      Effect.tryPromise({
        try: async (): Promise<EthCallResult> => {
          const networkKey = networkIdentityKey(input.network);
          const urls = options.urlsByNetwork[networkKey];
          if (urls === undefined || urls.length === 0) {
            throw fail("rpc_unsupported_network");
          }
          if (input.abort.aborted) throw fail("rpc_aborted");
          if (clock.nowMs() >= input.deadline_at_ms) throw fail("rpc_timeout");

          let lastTransport: EvmRpcSafeErrorCode = "rpc_transport_failed";
          for (const url of urls) {
            if (input.abort.aborted) throw fail("rpc_aborted");
            if (clock.nowMs() >= input.deadline_at_ms) throw fail("rpc_timeout");
            const remaining = Math.max(1, input.deadline_at_ms - clock.nowMs());
            const controller = new AbortController();
            const onParentAbort = (): void => controller.abort();
            input.abort.addEventListener("abort", onParentAbort, { once: true });
            const timer = setTimeout(() => controller.abort(), remaining);
            try {
              const response = await fetch(url, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  accept: "application/json",
                },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: nextId++,
                  method: "eth_call",
                  params: [
                    { to: input.to, data: input.data },
                    `0x${input.block.block_number.toString(16)}`,
                  ],
                }),
                signal: controller.signal,
              });
              if (!response.ok) {
                lastTransport = "rpc_transport_failed";
                continue;
              }
              const body = (await response.json()) as JsonRpcOk | JsonRpcErr;
              // Execution revert / missing selector → absent evidence.
              if ("error" in body && body.error !== undefined) {
                return { kind: "revert" };
              }
              if (!("result" in body) || !isHexData(body.result)) {
                return { kind: "revert" };
              }
              return {
                kind: "success",
                data: body.result.toLowerCase() as `0x${string}`,
              };
            } catch (cause) {
              if (input.abort.aborted) throw fail("rpc_aborted");
              if (clock.nowMs() >= input.deadline_at_ms) throw fail("rpc_timeout");
              if (
                cause !== null &&
                typeof cause === "object" &&
                "_tag" in cause &&
                (cause as EvmRpcFailure)._tag === "EvmRpcFailure"
              ) {
                throw cause as EvmRpcFailure;
              }
              lastTransport = "rpc_transport_failed";
            } finally {
              clearTimeout(timer);
              input.abort.removeEventListener("abort", onParentAbort);
            }
          }
          throw fail(lastTransport);
        },
        catch: (cause) => {
          if (
            cause !== null &&
            typeof cause === "object" &&
            "_tag" in cause &&
            (cause as EvmRpcFailure)._tag === "EvmRpcFailure"
          ) {
            return cause as EvmRpcFailure;
          }
          return fail("rpc_transport_failed");
        },
      }),

    getStorageAt: (input) =>
      rpcCall({
        networkKey: networkIdentityKey(input.network),
        method: "eth_getStorageAt",
        params: [
          input.address,
          input.slot,
          `0x${input.block.block_number.toString(16)}`,
        ],
        abort: input.abort,
        deadline_at_ms: input.deadline_at_ms,
      }).pipe(
        Effect.flatMap((raw) => {
          if (!isHexData(raw) || raw.length !== 66) {
            return Effect.fail(fail("rpc_invalid_response"));
          }
          return Effect.succeed(raw.toLowerCase() as `0x${string}`);
        }),
      ),
  };
};
