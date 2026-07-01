export type SelfMode = "offline" | "live" | "hybrid";

export type ExitCode = 0 | 1 | 2;

export interface SelfCheckOptions {
  check?: boolean;
  write?: boolean;
  mode?: SelfMode;
  allowUnknown?: boolean;
  proveAcvp?: boolean;
  verbose?: boolean;
  format?: "json" | "yaml";
  repoRoot?: string;
}

export interface SelfCheckResult {
  exitCode: ExitCode;
  output?: string;
  drift?: string[];
  unknownProbes?: string[];
  message?: string;
}

export function exitForCheck(params: {
  drift: boolean;
  unknownRequired: boolean;
  scrubFailed?: boolean;
  schemaInvalid?: boolean;
}): ExitCode {
  if (params.scrubFailed || params.schemaInvalid || params.drift) return 1;
  if (params.unknownRequired) return 2;
  return 0;
}
