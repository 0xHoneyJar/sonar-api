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
import {
  decodeCanonicalPreparationRequest,
  decodeLegacyIngestRequest,
} from "./protocol.js";
import { UNAVAILABLE_PREPARATION_RUNTIME } from "./preparation-runtime.js";
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
  return app;
}
