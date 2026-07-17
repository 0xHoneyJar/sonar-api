/**
 * Injected, abort-aware DAS sample port for CR-104.
 *
 * Endpoint / credentials are sealed at port construction by the operator —
 * never accepted from AdapterProbeRequest. Failures are typed and redacted.
 */
import { Effect } from "effect";
import type { DasAsset } from "../../../svm/nft-collection-source.js";
import {
  buildDasGetAssetRequestBody,
  buildDasSampleRequestBody,
  parseDasGetAssetRpcResponse,
  parseDasSampleRpcResponse,
} from "./sample-classifier.js";

export type DasTransportFailure =
  | "http_429"
  | "http_5xx"
  | "http_auth"
  | "http_4xx"
  | "rpc_error"
  | "malformed"
  | "incomplete"
  | "timeout"
  | "aborted"
  | "network";

export type DasSampleOutcome =
  | {
      readonly kind: "sample";
      readonly collection_mint: string;
      readonly items: ReadonlyArray<DasAsset>;
      readonly page: 1;
      readonly limit: number;
    }
  | { readonly kind: "timeout" }
  | {
      readonly kind: "unavailable";
      readonly failure: DasTransportFailure;
    };

/** Collection-level identity from a bounded `getAsset(collection mint)` observation. */
export interface DasCollectionAssetObservation {
  /**
   * Observed `getAsset.result.id` — must equal the requested collection mint
   * byte-for-byte. Never a request-stamped substitute for a foreign asset.
   */
  readonly collection_mint: string;
  readonly name?: string;
  readonly symbol?: string;
  readonly image?: string;
}

export type DasCollectionAssetOutcome =
  | { readonly kind: "observed"; readonly observation: DasCollectionAssetObservation }
  | { readonly kind: "omit" }
  | { readonly kind: "timeout" }
  | { readonly kind: "unavailable"; readonly failure: DasTransportFailure };

export interface DasSampleRequest {
  readonly collection_mint: string;
  readonly limit: number;
  readonly abort: AbortSignal;
  readonly deadline_at_ms: number;
  readonly now_ms: () => number;
}

/**
 * Bounded DAS transport. Implementations MUST honor abort + deadline and
 * MUST NOT paginate beyond the requested single sample page.
 *
 * Optional `observeCollectionAsset` supplies collection-level identity via a
 * bounded `getAsset(collection mint)` — never by projecting member NFT metadata.
 */
export interface DasSamplePort {
  readonly sampleCollection: (
    request: DasSampleRequest,
  ) => Effect.Effect<DasSampleOutcome, never>;
  readonly observeCollectionAsset?: (
    request: DasSampleRequest,
  ) => Effect.Effect<DasCollectionAssetOutcome, never>;
}

export const classifyHttpStatus = (status: number): DasTransportFailure => {
  if (status === 401 || status === 403) return "http_auth";
  if (status === 429) return "http_429";
  if (status >= 500 && status <= 599) return "http_5xx";
  if (status >= 400 && status <= 499) return "http_4xx";
  return "network";
};

const remainingMs = (request: DasSampleRequest): number =>
  request.deadline_at_ms - request.now_ms();

const isAbortedOrExpired = (request: DasSampleRequest): boolean =>
  request.abort.aborted || remainingMs(request) <= 0;

/**
 * Race an async DAS settlement against abort/deadline so in-flight work
 * terminates promptly without awaiting a late handler resolve.
 */
const raceAgainstAbort = async <T>(
  request: DasSampleRequest,
  work: Promise<T>,
  onAbort: () => T,
): Promise<T> => {
  if (isAbortedOrExpired(request)) {
    return onAbort();
  }
  let settleAbort!: () => void;
  const abortPromise = new Promise<T>((resolve) => {
    settleAbort = () => resolve(onAbort());
  });
  const onAbortEvent = () => settleAbort();
  request.abort.addEventListener("abort", onAbortEvent, { once: true });
  const budget = remainingMs(request);
  const timer =
    budget < Number.POSITIVE_INFINITY
      ? setTimeout(() => settleAbort(), Math.max(1, budget))
      : undefined;
  try {
    return await Promise.race([work, abortPromise]);
  } finally {
    request.abort.removeEventListener("abort", onAbortEvent);
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Scripted DAS port for hermetic tests. Records calls for pagination /
 * case-retention assertions. Late work after abort must not mutate
 * `sharedState` when callers pass one.
 */
export interface ScriptedDasSamplePortOptions {
  readonly handler: (
    request: DasSampleRequest,
  ) => DasSampleOutcome | Promise<DasSampleOutcome>;
  /**
   * Optional collection-asset handler. When omitted, `observeCollectionAsset`
   * returns `{ kind: "omit" }` (no fabricated collection metadata).
   */
  readonly collectionAssetHandler?: (
    request: DasSampleRequest,
  ) => DasCollectionAssetOutcome | Promise<DasCollectionAssetOutcome>;
  /** Optional shared bag — tests assert it is unchanged after abort. */
  readonly sharedState?: { mutations: number };
  readonly callLog?: Array<{
    collection_mint: string;
    limit: number;
    page: 1;
  }>;
}

const finishScriptedSample = (
  request: DasSampleRequest,
  outcome: DasSampleOutcome,
  sharedState?: { mutations: number },
): DasSampleOutcome => {
  if (isAbortedOrExpired(request)) {
    // Late settlement after abort/deadline — do not treat as success and
    // do not allow handlers to count as a committed mutation.
    return { kind: "timeout" } as const;
  }
  if (outcome.kind === "sample" && sharedState !== undefined) {
    sharedState.mutations += 1;
  }
  return outcome;
};

const finishScriptedCollectionAsset = (
  request: DasSampleRequest,
  outcome: DasCollectionAssetOutcome,
  sharedState?: { mutations: number },
): DasCollectionAssetOutcome => {
  if (isAbortedOrExpired(request)) {
    return { kind: "timeout" } as const;
  }
  if (outcome.kind === "observed" && sharedState !== undefined) {
    sharedState.mutations += 1;
  }
  return outcome;
};

export const createScriptedDasSamplePort = (
  options: ScriptedDasSamplePortOptions,
): DasSamplePort & {
  readonly calls: () => ReadonlyArray<{
    collection_mint: string;
    limit: number;
    page: 1;
  }>;
} => {
  const calls = options.callLog ?? [];
  return {
    calls: () => [...calls],
    sampleCollection: (request) => {
      calls.push({
        collection_mint: request.collection_mint,
        limit: request.limit,
        page: 1,
      });
      if (isAbortedOrExpired(request)) {
        return Effect.succeed({ kind: "timeout" } as const);
      }

      const started = options.handler(request);
      if (
        started !== null &&
        typeof started === "object" &&
        typeof (started as Promise<DasSampleOutcome>).then === "function"
      ) {
        return Effect.promise(async () =>
          raceAgainstAbort(
            request,
            (started as Promise<DasSampleOutcome>).then((outcome) =>
              finishScriptedSample(request, outcome, options.sharedState),
            ),
            () => ({ kind: "timeout" } as const),
          ),
        );
      }

      return Effect.sync(() =>
        finishScriptedSample(
          request,
          started as DasSampleOutcome,
          options.sharedState,
        ),
      );
    },
    observeCollectionAsset: (request) => {
      if (options.collectionAssetHandler === undefined) {
        return Effect.succeed({ kind: "omit" } as const);
      }
      if (isAbortedOrExpired(request)) {
        return Effect.succeed({ kind: "timeout" } as const);
      }
      const started = options.collectionAssetHandler(request);
      if (
        started !== null &&
        typeof started === "object" &&
        typeof (started as Promise<DasCollectionAssetOutcome>).then === "function"
      ) {
        return Effect.promise(async () =>
          raceAgainstAbort(
            request,
            (started as Promise<DasCollectionAssetOutcome>).then((outcome) =>
              finishScriptedCollectionAsset(request, outcome, options.sharedState),
            ),
            () => ({ kind: "timeout" } as const),
          ),
        );
      }
      return Effect.sync(() =>
        finishScriptedCollectionAsset(
          request,
          started as DasCollectionAssetOutcome,
          options.sharedState,
        ),
      );
    },
  };
};

export interface FetchDasSamplePortConfig {
  /**
   * Operator-sealed DAS-capable RPC endpoint. Never taken from a probe request.
   * Must not be logged or returned in outcomes.
   */
  readonly endpoint: string;
  readonly clock: { readonly nowMs: () => number };
  readonly fetchImpl?: typeof fetch;
  /**
   * When true, also issue a bounded `getAsset(collection mint)` for
   * collection-level identity metadata (never member projection).
   */
  readonly observeCollectionAsset?: boolean;
}

/**
 * Production-shaped fetch port. Endpoint is construction-sealed.
 * Errors never include URL, query credentials, or raw provider bodies.
 */
export const createFetchDasSamplePort = (
  config: FetchDasSamplePortConfig,
): DasSamplePort => {
  const fetchImpl = config.fetchImpl ?? fetch;
  const sampleCollection = (
    request: DasSampleRequest,
  ): Effect.Effect<DasSampleOutcome, never> =>
    Effect.promise(async () => {
      if (isAbortedOrExpired(request)) {
        return { kind: "timeout" } as const;
      }
      const budget = remainingMs(request);
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort("deadline"), budget);
      const onParentAbort = () => timeoutController.abort("parent");
      request.abort.addEventListener("abort", onParentAbort, { once: true });

      try {
        const body = buildDasSampleRequestBody({
          collection_mint: request.collection_mint,
          limit: request.limit,
        });
        // Assert exact-case mint is what we send.
        if (body.params.groupValue !== request.collection_mint) {
          return { kind: "unavailable", failure: "malformed" } as const;
        }

        const response = await raceAgainstAbort(
          request,
          fetchImpl(config.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: timeoutController.signal,
          }),
          () => undefined,
        );

        if (response === undefined) {
          timeoutController.abort("deadline");
          return { kind: "timeout" } as const;
        }

        if (isAbortedOrExpired(request)) {
          return { kind: "timeout" } as const;
        }

        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return {
            kind: "unavailable",
            failure: classifyHttpStatus(response.status),
          } as const;
        }

        const jsonResult = await raceAgainstAbort(
          request,
          response
            .json()
            .then((value) => ({ ok: true as const, value }))
            .catch(() => ({ ok: false as const })),
          () => undefined,
        );
        if (jsonResult === undefined) {
          timeoutController.abort("deadline");
          await response.body?.cancel().catch(() => undefined);
          return { kind: "timeout" } as const;
        }
        if (!jsonResult.ok) {
          return { kind: "unavailable", failure: "malformed" } as const;
        }
        const json: unknown = jsonResult.value;

        if (isAbortedOrExpired(request)) {
          return { kind: "timeout" } as const;
        }

        const parsed = parseDasSampleRpcResponse(json);
        if (parsed.kind === "malformed") {
          return { kind: "unavailable", failure: "malformed" } as const;
        }
        if (parsed.kind === "incomplete") {
          return { kind: "unavailable", failure: "incomplete" } as const;
        }
        if (parsed.kind === "rpc_error") {
          return { kind: "unavailable", failure: "rpc_error" } as const;
        }

        return {
          kind: "sample",
          collection_mint: request.collection_mint,
          items: parsed.page.items,
          page: 1 as const,
          limit: request.limit,
        };
      } catch (cause) {
        if (
          isAbortedOrExpired(request) ||
          (cause instanceof Error && cause.name === "AbortError")
        ) {
          return { kind: "timeout" } as const;
        }
        return { kind: "unavailable", failure: "network" } as const;
      } finally {
        clearTimeout(timer);
        request.abort.removeEventListener("abort", onParentAbort);
      }
    });

  const observeCollectionAsset = (
    request: DasSampleRequest,
  ): Effect.Effect<DasCollectionAssetOutcome, never> =>
    Effect.promise(async () => {
      if (isAbortedOrExpired(request)) {
        return { kind: "timeout" } as const;
      }
      const budget = remainingMs(request);
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort("deadline"), budget);
      const onParentAbort = () => timeoutController.abort("parent");
      request.abort.addEventListener("abort", onParentAbort, { once: true });

      try {
        const body = buildDasGetAssetRequestBody({
          collection_mint: request.collection_mint,
        });
        if (body.params.id !== request.collection_mint) {
          return { kind: "unavailable", failure: "malformed" } as const;
        }

        const response = await raceAgainstAbort(
          request,
          fetchImpl(config.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: timeoutController.signal,
          }),
          () => undefined,
        );

        if (response === undefined) {
          timeoutController.abort("deadline");
          return { kind: "timeout" } as const;
        }

        if (isAbortedOrExpired(request)) {
          return { kind: "timeout" } as const;
        }

        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return {
            kind: "unavailable",
            failure: classifyHttpStatus(response.status),
          } as const;
        }

        const jsonResult = await raceAgainstAbort(
          request,
          response
            .json()
            .then((value) => ({ ok: true as const, value }))
            .catch(() => ({ ok: false as const })),
          () => undefined,
        );
        if (jsonResult === undefined) {
          timeoutController.abort("deadline");
          await response.body?.cancel().catch(() => undefined);
          return { kind: "timeout" } as const;
        }
        if (!jsonResult.ok) {
          return { kind: "unavailable", failure: "malformed" } as const;
        }
        const json: unknown = jsonResult.value;

        if (isAbortedOrExpired(request)) {
          return { kind: "timeout" } as const;
        }

        const parsed = parseDasGetAssetRpcResponse(json);
        if (parsed.kind === "malformed") {
          return { kind: "unavailable", failure: "malformed" } as const;
        }
        if (parsed.kind === "incomplete") {
          return { kind: "unavailable", failure: "incomplete" } as const;
        }
        if (parsed.kind === "rpc_error") {
          return { kind: "unavailable", failure: "rpc_error" } as const;
        }

        // Identity binding: returned id must match the requested mint
        // byte-for-byte. Wrong case / different asset → unavailable (omit
        // metadata); never stamp request.collection_mint onto foreign metadata.
        if (parsed.id !== request.collection_mint) {
          return { kind: "unavailable", failure: "incomplete" } as const;
        }

        return {
          kind: "observed",
          observation: {
            // Bind the observed returned id — not a request-stamped substitute.
            collection_mint: parsed.id,
            ...(parsed.name !== undefined ? { name: parsed.name } : {}),
            ...(parsed.symbol !== undefined ? { symbol: parsed.symbol } : {}),
            ...(parsed.image !== undefined ? { image: parsed.image } : {}),
          },
        } as const;
      } catch (cause) {
        if (
          isAbortedOrExpired(request) ||
          (cause instanceof Error && cause.name === "AbortError")
        ) {
          return { kind: "timeout" } as const;
        }
        return { kind: "unavailable", failure: "network" } as const;
      } finally {
        clearTimeout(timer);
        request.abort.removeEventListener("abort", onParentAbort);
      }
    });

  return {
    sampleCollection,
    ...(config.observeCollectionAsset === true
      ? { observeCollectionAsset }
      : {}),
  };
};
