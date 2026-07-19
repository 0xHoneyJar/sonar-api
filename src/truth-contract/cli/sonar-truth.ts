import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Effect, Layer } from "effect";

import {
  TruthInspector,
  truthInspectorLayer,
  verifyTruthInspectionEnvelopeV1,
  type TruthInspectionTrustPinV1,
  type TruthInspectorService,
  type VerifiedTruthInspectionSourceV1,
} from "../status-reader.js";
import type { Sha256Digest } from "../schemas/common.js";
import {
  SONAR_TRUTH_MAX_INPUT_BYTES,
  SONAR_TRUTH_MAX_OUTPUT_BYTES,
  SonarTruthEnvelopeSchema,
  encodedBytes,
  forbiddenCredentialKeys,
  makeBoundaryEnvelope,
  scrubProcessEnvironmentForTruthAgent,
  type SonarTruthCommand,
  type SonarTruthEnvelopeV1,
} from "./contract.js";
import {
  isSonarTruthCommand,
  makeSonarTruthCli,
} from "./commands.js";
import { serveSonarTruthMcp } from "./mcp.js";
import {
  makeSonarTruthRuntime,
  type SonarTruthExecutionOptions,
  type SonarTruthRuntime,
} from "./runtime.js";

export interface SonarTruthCliRunOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly execution?: SonarTruthExecutionOptions;
  readonly now?: () => import("../schemas/common.js").TruthIsoTimestamp;
}

export interface SonarTruthCliRunResult {
  readonly exitCode: number;
  readonly output: string;
}

const commandFromArgv = (argv: readonly string[]): SonarTruthCommand => {
  const candidate = argv.find((argument) => !argument.startsWith("-"));
  return isSonarTruthCommand(candidate) ? candidate : "status";
};

const serialize = (envelope: SonarTruthEnvelopeV1): string =>
  `${JSON.stringify(envelope)}\n`;

const refusedFlags = new Set([
  "--filter-output",
  "--token-limit",
  "--token-offset",
  "--token-count",
  "--full-output",
]);

const isMetadataInvocation = (argv: readonly string[]): boolean =>
  argv.some((argument) =>
    ["--help", "-h", "--version", "-v", "--schema", "--llms", "--llms-full"].includes(
      argument,
    ),
  );

export const runSonarTruthCli = async (
  runtime: SonarTruthRuntime,
  argv: readonly string[],
  options: SonarTruthCliRunOptions = {},
): Promise<SonarTruthCliRunResult> => {
  const command = commandFromArgv(argv);
  if (
    options.environment !== undefined &&
    forbiddenCredentialKeys(options.environment).length > 0
  ) {
    const envelope = makeBoundaryEnvelope(
      command,
      6,
      "INVARIANT_FAILURE",
      "CREDENTIAL_ENV_REFUSED",
    );
    return { exitCode: 6, output: serialize(envelope) };
  }
  if (encodedBytes(argv) > SONAR_TRUTH_MAX_INPUT_BYTES) {
    const envelope = makeBoundaryEnvelope(
      command,
      6,
      "INVARIANT_FAILURE",
      "INPUT_RESOURCE_LIMIT",
    );
    return { exitCode: 6, output: serialize(envelope) };
  }
  if (
    argv.some((argument) => refusedFlags.has(argument)) ||
    argv.includes("mcp") ||
    argv.includes("skills") ||
    argv.includes("completions")
  ) {
    const envelope = makeBoundaryEnvelope(
      command,
      1,
      "USAGE",
      "UNSAFE_INCUR_SURFACE_REFUSED",
    );
    return { exitCode: 1, output: serialize(envelope) };
  }

  let observedEnvelope: SonarTruthEnvelopeV1 | undefined;
  const { cli } = makeSonarTruthCli(runtime, {
    execution: options.execution,
    now: options.now,
    onEnvelope: (envelope) => {
      observedEnvelope = envelope;
    },
  });
  let output = "";
  let frameworkExit = 0;
  await cli.serve([...argv], {
    env: {},
    exit: (code) => {
      frameworkExit = code;
    },
    stdout: (chunk) => {
      output += chunk;
    },
  });

  if (observedEnvelope === undefined && output.length > 0) {
    try {
      observedEnvelope = SonarTruthEnvelopeSchema.parse(
        JSON.parse(output),
      ) as SonarTruthEnvelopeV1;
    } catch {
      // Human metadata and Incur framework failures are handled below.
    }
  }
  if (observedEnvelope !== undefined) {
    if (encodedBytes(observedEnvelope) > SONAR_TRUTH_MAX_OUTPUT_BYTES) {
      const bounded = makeBoundaryEnvelope(
        command,
        6,
        "INVARIANT_FAILURE",
        "OUTPUT_RESOURCE_LIMIT",
      );
      return { exitCode: 6, output: serialize(bounded) };
    }
    return {
      exitCode: observedEnvelope.exit_code,
      output:
        output.length > 0 ? output : serialize(observedEnvelope),
    };
  }
  if (frameworkExit === 0 && isMetadataInvocation(argv)) {
    return { exitCode: 0, output };
  }
  const usage = makeBoundaryEnvelope(
    command,
    1,
    "USAGE",
    isSonarTruthCommand(argv[0])
      ? "INVALID_INVOCATION"
      : "UNSUPPORTED_COMMAND",
  );
  return { exitCode: 1, output: serialize(usage) };
};

const loadInspectionSource = async (
  path: string,
  pin: TruthInspectionTrustPinV1,
): Promise<VerifiedTruthInspectionSourceV1> => {
  let file;
  try {
    file = await open(path, "r");
  } catch {
    throw new InspectionSourceUnavailable();
  }
  let bytes: string;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new InspectionSourceUnavailable();
    if (metadata.size > SONAR_TRUTH_MAX_INPUT_BYTES) {
      throw new InspectionSourceResourceLimit();
    }
    bytes = await file.readFile("utf8");
    if (new TextEncoder().encode(bytes).byteLength > SONAR_TRUTH_MAX_INPUT_BYTES) {
      throw new InspectionSourceResourceLimit();
    }
  } catch (error) {
    if (
      error instanceof InspectionSourceUnavailable ||
      error instanceof InspectionSourceResourceLimit
    ) {
      throw error;
    }
    throw new InspectionSourceUnavailable();
  } finally {
    await file.close().catch(() => undefined);
  }
  return Effect.runPromise(
    verifyTruthInspectionEnvelopeV1(JSON.parse(bytes), pin),
  );
};

class InspectionSourceUnavailable extends Error {
  readonly _tag = "InspectionSourceUnavailable";
}

class InspectionSourceResourceLimit extends Error {
  readonly _tag = "InspectionSourceResourceLimit";
}

const writeBoundaryFailure = (
  argv: readonly string[],
  code:
    | "STATUS_SOURCE_UNAVAILABLE"
    | "SNAPSHOT_TRUST_FAILED"
    | "INPUT_RESOURCE_LIMIT",
  exitCode: 4 | 5 | 6,
): void => {
  const command = commandFromArgv(argv);
  const envelope = makeBoundaryEnvelope(
    command,
    exitCode,
    exitCode === 4
      ? "TRUST_FAILURE"
      : exitCode === 5
        ? "TRANSPORT_FAILURE"
        : "INVARIANT_FAILURE",
    code,
  );
  process.stdout.write(serialize(envelope));
  process.exitCode = exitCode;
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  if (isMetadataInvocation(argv)) {
    const unavailableInspector: TruthInspectorService = {
      evaluateTarget: () => Effect.never,
      status: () => Effect.never,
      verify: () => Effect.never,
      explain: () => Effect.never,
      dependencies: () => Effect.never,
      rebuild: () => Effect.never,
    };
    const metadataRuntime = makeSonarTruthRuntime(
      Layer.succeed(TruthInspector, unavailableInspector),
    );
    try {
      const result = await runSonarTruthCli(metadataRuntime, argv, {
        environment: {},
      });
      process.stdout.write(result.output);
      process.exitCode = result.exitCode;
    } finally {
      await metadataRuntime.dispose();
    }
    return;
  }
  const snapshotPath = process.env.SONAR_TRUTH_SNAPSHOT_PATH;
  if (snapshotPath === undefined || snapshotPath.length === 0) {
    writeBoundaryFailure(argv, "STATUS_SOURCE_UNAVAILABLE", 5);
    return;
  }
  const pinnedKeyId = process.env.SONAR_TRUTH_PINNED_KEY_ID;
  const pinnedPublicKeyHex =
    process.env.SONAR_TRUTH_PINNED_PUBLIC_KEY_HEX;
  const pinnedEnvelopeHash =
    process.env.SONAR_TRUTH_PINNED_ENVELOPE_HASH;
  const pinnedTrustRootGeneration =
    process.env.SONAR_TRUTH_PINNED_TRUST_ROOT_GENERATION;
  const pinnedRevocationSequence =
    process.env.SONAR_TRUTH_PINNED_REVOCATION_SEQUENCE;
  if (
    pinnedKeyId === undefined ||
    pinnedKeyId.length === 0 ||
    pinnedPublicKeyHex === undefined ||
    pinnedPublicKeyHex.length === 0 ||
    pinnedEnvelopeHash === undefined ||
    pinnedEnvelopeHash.length === 0 ||
    pinnedTrustRootGeneration === undefined ||
    pinnedTrustRootGeneration.length === 0 ||
    pinnedRevocationSequence === undefined ||
    pinnedRevocationSequence.length === 0
  ) {
    writeBoundaryFailure(argv, "SNAPSHOT_TRUST_FAILED", 4);
    return;
  }
  let source: VerifiedTruthInspectionSourceV1;
  try {
    source = await loadInspectionSource(snapshotPath, {
      keyId: pinnedKeyId,
      publicKeyHex: pinnedPublicKeyHex,
      envelopeHash: pinnedEnvelopeHash as Sha256Digest,
      trustRootGeneration: pinnedTrustRootGeneration,
      revocationSequence: pinnedRevocationSequence,
    });
  } catch (error) {
    if (error instanceof InspectionSourceUnavailable) {
      writeBoundaryFailure(argv, "STATUS_SOURCE_UNAVAILABLE", 5);
      return;
    }
    if (error instanceof InspectionSourceResourceLimit) {
      writeBoundaryFailure(argv, "INPUT_RESOURCE_LIMIT", 6);
      return;
    }
    writeBoundaryFailure(argv, "SNAPSHOT_TRUST_FAILED", 4);
    return;
  }
  const runtime = makeSonarTruthRuntime(truthInspectorLayer(source));
  scrubProcessEnvironmentForTruthAgent();
  let terminating = false;
  const terminate = (code: 130 | 143) => {
    if (terminating) return;
    terminating = true;
    void runtime.dispose().finally(() => process.exit(code));
  };
  process.once("SIGINT", () => terminate(130));
  process.once("SIGTERM", () => terminate(143));
  try {
    if (argv.includes("--mcp")) {
      await serveSonarTruthMcp(runtime, { environment: process.env });
      return;
    }
    const result = await runSonarTruthCli(runtime, argv);
    process.stdout.write(result.output);
    process.exitCode = result.exitCode;
  } finally {
    if (!terminating) await runtime.dispose();
  }
};

export default makeSonarTruthCli;

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
