export type ProbeStatus = "verified" | "unknown";

export interface ProbeResult<T> {
  status: ProbeStatus;
  value?: T;
  reason?: string;
}

export function verified<T>(value: T): ProbeResult<T> {
  return { status: "verified", value };
}

export function unknown<T>(reason: string): ProbeResult<T> {
  return { status: "unknown", reason };
}

export function unwrapProbe<T>(result: ProbeResult<T> | T): T | undefined {
  if (result && typeof result === "object" && "status" in result) {
    return result.status === "verified" ? result.value : undefined;
  }
  return result as T;
}

export function isProbeResult<T>(value: ProbeResult<T> | T): value is ProbeResult<T> {
  return typeof value === "object" && value !== null && "status" in value;
}
