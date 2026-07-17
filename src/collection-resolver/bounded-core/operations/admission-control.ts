/**
 * CR-107 global admission control — separate from rate limiting.
 *
 * Rate limiter = overload control. Admission = deliberate full-stop that
 * serves no cache and starts no adapters. Check after structural preflight
 * and before rate/cache/coalesce/fanout.
 */
import { Data, Effect } from "effect";

export type AdmissionState = "open" | "full_stop";

export class ResolverAdmissionFullStopError extends Data.TaggedError(
  "ResolverAdmissionFullStopError",
)<{
  /** Safe public reason — no operator/user details. */
  readonly reason: string;
}> {}

export interface AdmissionControlPort {
  readonly state: () => AdmissionState;
  /**
   * Fail with typed full-stop when closed. Success is void when open.
   */
  readonly assertOpen: () => Effect.Effect<void, ResolverAdmissionFullStopError>;
}

export interface MemoryAdmissionControl extends AdmissionControlPort {
  readonly setState: (state: AdmissionState) => void;
  readonly open: () => void;
  readonly fullStop: () => void;
}

export const createMemoryAdmissionControl = (
  initial: AdmissionState = "open",
): MemoryAdmissionControl => {
  let current: AdmissionState = initial;

  const assertOpen = Effect.fn("recognition.admission.assertOpen")(function* () {
    if (current === "full_stop") {
      return yield* Effect.fail(
        new ResolverAdmissionFullStopError({
          reason: "resolver admission is full_stop; no new recognition work",
        }),
      );
    }
  });

  return {
    state: () => current,
    assertOpen,
    setState: (state) => {
      current = state;
    },
    open: () => {
      current = "open";
    },
    fullStop: () => {
      current = "full_stop";
    },
  };
};

/** Compatibility default — always open when no live admission port is wired. */
export const alwaysOpenAdmissionControl: AdmissionControlPort = {
  state: () => "open",
  assertOpen: Effect.fn("recognition.admission.alwaysOpen")(function* () {
    return;
  }),
};
