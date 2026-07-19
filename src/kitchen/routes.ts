import { Effect } from "effect";
import { Hono } from "hono";

import {
  COLLECTION_PROTOCOL_SCHEMA_VERSION,
  makeCollectionDeploymentRef,
  type CollectionDeploymentRef,
} from "../collection-resolver/protocol.js";
import { requireServiceToken } from "./auth.js";
import { resolvePreparationCapability } from "./capability.js";
import { collectionKeyFromParams, deploymentFromCollectionKey } from "./normalize.js";
import { mapPool } from "./async-pool.js";
import {
  buildIndexingStatus,
  type ChainProgressRow,
} from "./indexing-status.js";
import {
  BATCH_ADMIT_CONCURRENCY,
  decodeAckPreparationRequest,
  decodeBatchPreparationRequest,
  decodeCanonicalPreparationRequest,
  decodeLegacyIngestRequest,
} from "./protocol.js";
import {
  preparationDrainStrategyFromEnv,
  UNAVAILABLE_PREPARATION_RUNTIME,
} from "./preparation-runtime.js";
import {
  resolveProbeRuntimeFromEnv,
  type ResolveProbeRuntime,
} from "./resolve-probe-runtime.js";
import { isIndexedSnapshotReady, resolveCollectionStatus, toStatusResponse, type CollectionStatusReader } from "./status.js";
import type { IngestJobStorePort } from "./ingest-store.js";
import type {
  AdmissionFailure,
  AdmissionResult,
  IngestJobRecord,
  PreparationRuntimeState,
} from "./types.js";

export type ChainProgressReader = () => Promise<ChainProgressRow[]>;

export type PreparationCapabilityResolver = typeof resolvePreparationCapability;

function admissionHttpStatus(failure: AdmissionFailure): 409 | 422 | 503 {
  if (failure.code === "migration_divergence" || failure.code === "capability_degraded") return 503;
  if (failure.code === "capability_disabled" || failure.code === "capability_version_mismatch") return 409;
  return 422;
}

function admissionError(failure: AdmissionFailure) {
  return {
    schema_version: 1 as const,
    error: {
      code: failure.code,
      reason_class: failure.reasonClass,
      message: failure.reason,
    },
  };
}

function canonicalJobResponse(job: IngestJobRecord) {
  return {
    schema_version: 1 as const,
    physical_job_id: job.physicalJobId,
    deployment: job.deployment,
    capability: {
      capability_id: job.capabilityId,
      capability_version: job.capabilityVersion,
      token_standard: job.tokenStandard,
      prepare_adapter_id: job.prepareAdapterId,
      prepare_adapter_version: job.prepareAdapterVersion,
      source_sequence: job.sourceSequence,
      finality_policy_version: job.finalityPolicyVersion,
    },
    status: job.status,
    attempt: job.attempt,
    ...(job.errorCode ? { error: { code: job.errorCode, message: job.errorMessage ?? "" } } : {}),
    created_at: new Date(job.createdAtMs).toISOString(),
    updated_at: new Date(job.updatedAtMs).toISOString(),
  };
}

async function admitCanonical(args: {
  store: IngestJobStorePort;
  capabilityResolver: PreparationCapabilityResolver;
  preparationRuntime: PreparationRuntimeState;
  deployment: CollectionDeploymentRef;
  tokenStandard: Parameters<typeof resolvePreparationCapability>[0]["tokenStandard"];
  correlation?: { source: string; correlationId: string };
}): Promise<AdmissionResult> {
  const capability = await args.capabilityResolver({
    network: args.deployment.network,
    tokenStandard: args.tokenStandard,
  });
  if (capability.enabled && capability.health === "available" && !args.preparationRuntime.available) {
    return {
      ok: false,
      code: "capability_degraded",
      reasonClass: "availability_degradation",
      reason: args.preparationRuntime.reason,
    };
  }
  return args.store.admit({
    deployment: args.deployment,
    tokenStandard: args.tokenStandard,
    capability,
    correlation: args.correlation,
  });
}

export function createCollectionRoutes(deps: {
  reader: CollectionStatusReader;
  store: IngestJobStorePort;
  capabilityResolver?: PreparationCapabilityResolver;
  preparationRuntime?: PreparationRuntimeState;
  resolveProbeRuntime?: ResolveProbeRuntime;
}): Hono {
  const { reader, store } = deps;
  const capabilityResolver = deps.capabilityResolver ?? resolvePreparationCapability;
  const preparationRuntime = deps.preparationRuntime ?? UNAVAILABLE_PREPARATION_RUNTIME;
  const resolveProbeRuntime = deps.resolveProbeRuntime ?? resolveProbeRuntimeFromEnv();
  const routes = new Hono();
  routes.use("*", requireServiceToken);

  // Static path BEFORE /:chain_id/... so it is not captured as a chain id.
  routes.post("/resolve-probe", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        { schema_version: 1, error: { code: "invalid_request", message: "request body must be JSON" } },
        400,
      );
    }
    if (!raw || typeof raw !== "object") {
      return c.json(
        { schema_version: 1, error: { code: "invalid_request", message: "request body must be an object" } },
        400,
      );
    }
    const body = raw as Record<string, unknown>;
    if (body.schema_version !== 1) {
      return c.json(
        { schema_version: 1, error: { code: "invalid_request", message: "schema_version must be 1" } },
        400,
      );
    }
    if (typeof body.identifier !== "string" || body.identifier.trim() === "") {
      return c.json(
        { schema_version: 1, error: { code: "invalid_request", message: "identifier is required" } },
        400,
      );
    }
    if (body.environment !== "mainnet") {
      return c.json(
        { schema_version: 1, error: { code: "invalid_request", message: "environment must be mainnet" } },
        400,
      );
    }
    const settled = await resolveProbeRuntime.resolve(body.identifier.trim());
    if (!settled.ok) return c.json(settled.body, settled.status);
    return c.json(settled.body, 200);
  });

  routes.get("/:chain_id/:contract_address/status", async (c) => {
    const key = collectionKeyFromParams(c.req.param("chain_id"), c.req.param("contract_address"));
    if (!key) return c.json({ error: "invalid chain_id or contract_address" }, 400);

    const indexed = await reader.readIndexedSnapshot(key);
    const job = await store.get(key);
    const status = resolveCollectionStatus({ indexed, job });
    if (status === "missing") return c.json({ error: "collection not found" }, 404);
    return c.json(toStatusResponse(status, indexed), 200);
  });

  routes.post("/:chain_id/:contract_address/ingest", async (c) => {
    const key = collectionKeyFromParams(c.req.param("chain_id"), c.req.param("contract_address"));
    if (!key) return c.json({ error: "invalid chain_id or contract_address" }, 400);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "request body must be JSON" }, 400);
    }

    let body;
    try {
      body = await decodeLegacyIngestRequest(raw);
    } catch {
      return c.json({ error: "invalid ingest payload" }, 400);
    }

    const indexed = await reader.readIndexedSnapshot(key);
    if (isIndexedSnapshotReady(indexed)) {
      return c.json(toStatusResponse("indexed", indexed), 200);
    }

    const deployment = await deploymentFromCollectionKey(key);
    const result = await admitCanonical({
      store,
      capabilityResolver,
      preparationRuntime,
      deployment,
      tokenStandard: "erc721",
      correlation: { source: body.source, correlationId: body.order_id },
    });
    if (!result.ok) {
      return c.json({ error: result.reason }, admissionHttpStatus(result));
    }
    return c.json({ job_id: result.job.jobId, status: "queued" as const }, 202);
  });

  return routes;
}

export function createCanonicalPreparationRoutes(deps: {
  store: IngestJobStorePort;
  capabilityResolver?: PreparationCapabilityResolver;
  preparationRuntime?: PreparationRuntimeState;
}): Hono {
  const routes = new Hono();
  const capabilityResolver = deps.capabilityResolver ?? resolvePreparationCapability;
  const preparationRuntime = deps.preparationRuntime ?? UNAVAILABLE_PREPARATION_RUNTIME;
  routes.use("*", requireServiceToken);

  routes.post("/", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ schema_version: 1, error: { code: "invalid_request", message: "request body must be JSON" } }, 400);
    }

    let body;
    try {
      body = await decodeCanonicalPreparationRequest(raw);
    } catch {
      return c.json({ schema_version: 1, error: { code: "invalid_request", message: "request does not match schema version 1" } }, 400);
    }

    let deployment: CollectionDeploymentRef;
    try {
      deployment = await Effect.runPromise(
        makeCollectionDeploymentRef({
          schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
          network: body.network,
          address: body.address,
        }),
      );
    } catch {
      return c.json({ schema_version: 1, error: { code: "invalid_deployment", message: "network and address do not form a valid deployment" } }, 400);
    }

    let result: AdmissionResult;
    try {
      result = await admitCanonical({
        store: deps.store,
        capabilityResolver,
        preparationRuntime,
        deployment,
        tokenStandard: body.token_standard,
        ...(body.correlation
          ? {
              correlation: {
                source: body.correlation.source,
                correlationId: body.correlation.correlation_id,
              },
            }
          : {}),
      });
    } catch {
      return c.json({ schema_version: 1, error: { code: "admission_failed", message: "collection preparation admission failed" } }, 500);
    }

    if (!result.ok) return c.json(admissionError(result), admissionHttpStatus(result));
    return c.json(canonicalJobResponse(result.job), result.created ? 202 : 200);
  });

  /**
   * Batch admit — one HTTP round-trip for many deployments.
   * Physical identity remains one job per deployment; the drain worker
   * materializes the whole claim set as a single Belt config batch.
   */
  routes.post("/batch", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ schema_version: 1, error: { code: "invalid_request", message: "request body must be JSON" } }, 400);
    }

    let body;
    try {
      body = await decodeBatchPreparationRequest(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          schema_version: 1,
          error: {
            code: "invalid_request",
            message: `batch request does not match schema version 1 (1–50 items): ${detail}`,
          },
        },
        400,
      );
    }

    const results = await mapPool(body.items, BATCH_ADMIT_CONCURRENCY, async (item, index) => {
      const correlation = item.correlation ?? body.correlation;
      let deployment: CollectionDeploymentRef;
      try {
        deployment = await Effect.runPromise(
          makeCollectionDeploymentRef({
            schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
            network: item.network,
            address: item.address,
          }),
        );
      } catch (err) {
        console.error("[kitchen] batch item %d invalid_deployment", index, err);
        return {
          index,
          ok: false as const,
          error: {
            code: "invalid_deployment",
            reason_class: "invalid_input",
            message: "network and address do not form a valid deployment",
          },
        };
      }

      let result: AdmissionResult;
      try {
        result = await admitCanonical({
          store: deps.store,
          capabilityResolver,
          preparationRuntime,
          deployment,
          tokenStandard: item.token_standard,
          ...(correlation
            ? {
                correlation: {
                  source: correlation.source,
                  correlationId: correlation.correlation_id,
                },
              }
            : {}),
        });
      } catch (err) {
        console.error("[kitchen] batch item %d admission error", index, err);
        return {
          index,
          ok: false as const,
          error: {
            code: "admission_failed",
            reason_class: "internal",
            message: "collection preparation admission failed",
          },
        };
      }

      if (!result.ok) {
        return { index, ok: false as const, ...admissionError(result) };
      }
      return {
        index,
        ok: true as const,
        created: result.created,
        job: canonicalJobResponse(result.job),
      };
    });

    // Counters derived after concurrent admit — avoid racy += across awaits.
    let created = 0;
    let joined = 0;
    let rejected = 0;
    for (const row of results) {
      if (!row || row.ok !== true) {
        rejected += 1;
        continue;
      }
      if (row.created === true) created += 1;
      else joined += 1;
    }

    // 202 = all created (zero rejected); 200 = all joined; 207 = mixed; 422 = all rejected.
    // Callers should still inspect results[] for per-item status.
    const status =
      rejected > 0 && (created > 0 || joined > 0)
        ? 207
        : created > 0
          ? 202
          : rejected === body.items.length
            ? 422
            : 200;
    return c.json(
      {
        schema_version: 1 as const,
        batch: {
          requested: body.items.length,
          created,
          joined,
          rejected,
        },
        results,
      },
      status,
    );
  });

  /**
   * Operator ack after out-of-band SCALE config apply (external_scale drain).
   * Promotes queued physical jobs to indexing so the readiness watchdog can
   * complete or timeout them.
   */
  routes.post("/ack", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ schema_version: 1, error: { code: "invalid_request", message: "request body must be JSON" } }, 400);
    }

    let body;
    try {
      body = await decodeAckPreparationRequest(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          schema_version: 1,
          error: {
            code: "invalid_request",
            message: `ack request does not match schema version 1: ${detail}`,
          },
        },
        400,
      );
    }

    // Ack is only meaningful when Kitchen is running the external_scale drain.
    if (preparationDrainStrategyFromEnv() !== "external_scale") {
      return c.json(
        {
          schema_version: 1,
          error: {
            code: "drain_mode_mismatch",
            message: "ack requires KITCHEN_PREPARATION_DRAIN=external_scale on this Kitchen process",
          },
        },
        409,
      );
    }

    const ids = body.physical_job_ids;
    const nowMs = Date.now();
    const results = await mapPool(ids, BATCH_ADMIT_CONCURRENCY, async (physicalJobId) => {
      const job = await deps.store.getByPhysicalJobId(physicalJobId);
      if (!job) {
        return { physical_job_id: physicalJobId, ok: false as const, error: { code: "job_not_found" } };
      }
      if (job.status === "indexing" || job.status === "completed") {
        return {
          physical_job_id: physicalJobId,
          ok: true as const,
          status: job.status,
          advanced: false,
        };
      }
      if (job.status !== "queued") {
        return {
          physical_job_id: physicalJobId,
          ok: false as const,
          error: { code: "unexpected_status", message: `job status is ${job.status}` },
        };
      }
      if (job.leaseOwner) {
        return {
          physical_job_id: physicalJobId,
          ok: false as const,
          error: {
            code: "status_conflict",
            message: "job has an active worker lease; wait for external_scale release before ack",
          },
        };
      }
      // expectedAbsentLease on updateStatus is the concurrency guard.
      const updated = await deps.store.updateStatus(physicalJobId, "indexing", {
        expectedStatus: "queued",
        expectedAbsentLease: true,
        nowMs,
      });
      if (!updated) {
        return {
          physical_job_id: physicalJobId,
          ok: false as const,
          error: { code: "status_conflict", message: "could not advance queued job to indexing" },
        };
      }
      return {
        physical_job_id: physicalJobId,
        ok: true as const,
        status: "indexing" as const,
        advanced: true,
      };
    });

    let advanced = 0;
    let missing = 0;
    let already_terminal = 0;
    let conflicts = 0;
    for (const row of results) {
      if (row.ok === true && row.advanced === true) advanced += 1;
      else if (row.ok === true) already_terminal += 1;
      else if (row.error?.code === "job_not_found") missing += 1;
      else conflicts += 1;
    }
    const skipped = already_terminal + conflicts;

    const anyFailed = results.some((row) => row.ok === false);
    const httpStatus =
      missing === ids.length ? 404 : anyFailed || (advanced > 0 && skipped > 0) ? 207 : 200;
    return c.json(
      {
        schema_version: 1 as const,
        ack: {
          requested: ids.length,
          advanced,
          skipped,
          already_terminal,
          conflicts,
          missing,
        },
        results,
      },
      httpStatus,
    );
  });

  routes.get("/:physical_job_id", async (c) => {
    const job = await deps.store.getByPhysicalJobId(c.req.param("physical_job_id"));
    if (!job) {
      return c.json({ schema_version: 1, error: { code: "job_not_found", message: "physical job not found" } }, 404);
    }
    return c.json(canonicalJobResponse(job), 200);
  });

  return routes;
}

export function createKitchenApp(deps: {
  reader: CollectionStatusReader;
  store: IngestJobStorePort;
  capabilityResolver?: PreparationCapabilityResolver;
  preparationRuntime?: PreparationRuntimeState;
  resolveProbeRuntime?: ResolveProbeRuntime;
  /** Optional Belt chain_metadata reader (GraphQL or SQL). Defaults to []. */
  readChainProgress?: ChainProgressReader;
}): Hono {
  const app = new Hono();
  app.get("/health", (c) => c.json({
    ok: true,
    service: "kitchen-api",
    resolve_probe: (deps.resolveProbeRuntime ?? resolveProbeRuntimeFromEnv()).mode,
  }, 200));
  app.get("/ready", async (c) => {
    const preparationRuntime = deps.preparationRuntime ?? UNAVAILABLE_PREPARATION_RUNTIME;
    let migration: Awaited<ReturnType<IngestJobStorePort["getMigrationAuthority"]>>;
    try {
      migration = await deps.store.getMigrationAuthority();
    } catch {
      return c.json({
        ok: false,
        service: "kitchen-api",
        preparation_admission: "disabled",
        preparation_runtime: preparationRuntime.mode,
        reason: "migration authority unavailable",
        migration_phase: "unknown",
      }, 503);
    }
    const available = !migration.divergence && preparationRuntime.available;
    return c.json({
      ok: available,
      service: "kitchen-api",
      preparation_admission: available ? "enabled" : "disabled",
      preparation_runtime: preparationRuntime.mode,
      ...(!preparationRuntime.available ? { reason: preparationRuntime.reason } : {}),
      migration_phase: migration.phase,
    }, available ? 200 : 503);
  });
  app.route("/v1/collections", createCollectionRoutes(deps));
  app.route("/v2/collection-preparations", createCanonicalPreparationRoutes(deps));

  const indexing = new Hono();
  indexing.use("*", requireServiceToken);
  indexing.get("/", async (c) => {
    const body = await buildIndexingStatus({
      countByStatus: () => deps.store.countByStatus(),
      listByStatus: (status, limit) => deps.store.listByStatus(status, limit),
      readChains: deps.readChainProgress ?? (async () => []),
    });
    return c.json(body, 200);
  });
  app.route("/v2/indexing-status", indexing);
  return app;
}
