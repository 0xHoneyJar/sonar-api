import type { Readable, Writable } from "node:stream";
import { Mcp, z } from "incur";

import {
  SonarTruthEnvelopeSchema,
  forbiddenCredentialKeys,
  makeBoundaryEnvelope,
  scrubProcessEnvironmentForTruthAgent,
  type SonarTruthCommand,
  type SonarTruthEnvelopeV1,
} from "./contract.js";
import {
  makeSonarTruthCommandDefinitions,
  type TruthInvocationGuard,
} from "./commands.js";
import type {
  SonarTruthExecutionOptions,
  SonarTruthRuntime,
} from "./runtime.js";

export interface SonarTruthMcpBudgetOptions {
  readonly maximumCallsPerWindow?: number;
  readonly maximumConcurrentCallsPerTool?: number;
  readonly windowMilliseconds?: number;
}

export class SonarTruthMcpBudget implements TruthInvocationGuard {
  readonly #maximumCalls: number;
  readonly #maximumConcurrent: number;
  readonly #windowMilliseconds: number;
  readonly #windows = new Map<
    SonarTruthCommand,
    { startedAt: number; calls: number }
  >();
  readonly #active = new Map<SonarTruthCommand, number>();

  constructor(options: SonarTruthMcpBudgetOptions = {}) {
    this.#maximumCalls = options.maximumCallsPerWindow ?? 60;
    this.#maximumConcurrent =
      options.maximumConcurrentCallsPerTool ?? 2;
    this.#windowMilliseconds = options.windowMilliseconds ?? 60_000;
  }

  acquire(command: SonarTruthCommand): (() => void) | null {
    const now = Date.now();
    const current = this.#windows.get(command);
    const window =
      current === undefined ||
      now - current.startedAt >= this.#windowMilliseconds
        ? { startedAt: now, calls: 0 }
        : current;
    const active = this.#active.get(command) ?? 0;
    if (
      window.calls >= this.#maximumCalls ||
      active >= this.#maximumConcurrent
    ) {
      this.#windows.set(command, window);
      return null;
    }
    window.calls += 1;
    this.#windows.set(command, window);
    this.#active.set(command, active + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active.set(
        command,
        Math.max(0, (this.#active.get(command) ?? 1) - 1),
      );
    };
  }
}

export class CredentialEnvironmentRefused extends Error {
  readonly _tag = "CredentialEnvironmentRefused";

  constructor() {
    super("credential-bearing environment is refused");
  }
}

export const assertCredentialFreeEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  if (forbiddenCredentialKeys(environment).length > 0) {
    throw new CredentialEnvironmentRefused();
  }
};

const prepareMcpEnvironment = (
  environment: Readonly<Record<string, string | undefined>> | undefined,
): void => {
  if (environment === undefined || environment === process.env) {
    scrubProcessEnvironmentForTruthAgent();
    assertCredentialFreeEnvironment(process.env);
    return;
  }
  // Explicit overrides exist for hermetic tests and embedded callers only.
  assertCredentialFreeEnvironment(environment);
};

export interface SonarTruthMcpOptions {
  readonly budget?: SonarTruthMcpBudget;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly execution?: SonarTruthExecutionOptions;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly now?: () => import("../schemas/common.js").TruthIsoTimestamp;
}

const defaultBudgets = new WeakMap<object, SonarTruthMcpBudget>();

const defaultBudgetFor = (
  runtime: SonarTruthRuntime,
): SonarTruthMcpBudget => {
  const existing = defaultBudgets.get(runtime);
  if (existing !== undefined) return existing;
  const created = new SonarTruthMcpBudget();
  defaultBudgets.set(runtime, created);
  return created;
};

const makeMcpDefinitions = (
  runtime: SonarTruthRuntime,
  options: SonarTruthMcpOptions,
) =>
  makeSonarTruthCommandDefinitions(runtime, {
    execution: options.execution,
    guard: options.budget ?? defaultBudgetFor(runtime),
    now: options.now,
  });

export const collectSonarTruthMcpTools = (
  runtime: SonarTruthRuntime,
  options: SonarTruthMcpOptions = {},
) => {
  prepareMcpEnvironment(options.environment);
  return Mcp.collectTools(new Map(makeMcpDefinitions(runtime, options)), []);
};

export const callSonarTruthMcpTool = async (
  runtime: SonarTruthRuntime,
  command: SonarTruthCommand,
  params: Record<string, unknown>,
  options: SonarTruthMcpOptions = {},
): Promise<SonarTruthEnvelopeV1> => {
  const tools = collectSonarTruthMcpTools(runtime, options);
  const tool = tools.find((candidate) => candidate.name === command);
  if (tool === undefined) {
    return makeBoundaryEnvelope(
      command,
      3,
      "UNSUPPORTED",
      "UNSUPPORTED_CAPABILITY",
    );
  }
  const result = await Mcp.callTool(tool, params, {
    name: "sonar-truth",
    version: "1.0.0",
  });
  const structured = result.structuredContent;
  if (structured === undefined) {
    return makeBoundaryEnvelope(
      command,
      1,
      "USAGE",
      "INVALID_INVOCATION",
    );
  }
  return SonarTruthEnvelopeSchema.parse(
    structured,
  ) as SonarTruthEnvelopeV1;
};

export const serveSonarTruthMcp = async (
  runtime: SonarTruthRuntime,
  options: SonarTruthMcpOptions = {},
): Promise<void> => {
  prepareMcpEnvironment(options.environment);
  await Mcp.serve(
    "sonar-truth",
    "1.0.0",
    new Map(makeMcpDefinitions(runtime, options)),
    {
      env: z.object({}),
      input: options.input,
      output: options.output,
      version: "1.0.0",
    },
  );
};
