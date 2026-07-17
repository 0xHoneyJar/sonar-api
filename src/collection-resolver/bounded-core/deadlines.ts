/**
 * Abort / deadline helpers with real cancellation propagation.
 *
 * Deadlines are cancellation boundaries: race adapters against injected
 * monotonic timers, abort the adapter signal when either per-network or global
 * deadline expires, and ignore late settlements after seal.
 *
 * Controlling tasks NEVER directly await an unbounded adapter promise. Each
 * settlement is converted to exactly one fiber/callback execution, then raced
 * against deadline promises. Late handlers only consume that same execution's
 * rejection / discard value and cannot mutate diagnostics/cache/candidates.
 *
 * Never probe with `runSyncExit` then fall back to `runPromise` on the same
 * Effect — that double-starts async adapters (network, Inventory, ports).
 *
 * Hermetic virtual-clock adapters remain `runSync`-compatible: when the single
 * execution settles synchronously, `Effect.async` resumes synchronously. Real
 * timers require `runPromise` of the outer race.
 */
import { Effect, Exit } from "effect";
import type { DeadlineTimerPort, MonotonicClock } from "./clock.js";

export interface DeadlineController {
  readonly signal: AbortSignal;
  readonly abort: (reason?: string) => void;
  readonly aborted: boolean;
  readonly reason: string | undefined;
}

export const createDeadlineController = (): DeadlineController => {
  const controller = new AbortController();
  let reason: string | undefined;
  return {
    get signal() {
      return controller.signal;
    },
    get aborted() {
      return controller.signal.aborted;
    },
    get reason() {
      return reason;
    },
    abort: (r = "aborted") => {
      if (!controller.signal.aborted) {
        reason = r;
        controller.abort(r);
      }
    },
  };
};

export const linkAbort = (
  parent: AbortSignal,
  child: DeadlineController,
): (() => void) => {
  if (parent.aborted) {
    child.abort("parent_aborted");
    return () => undefined;
  }
  const onAbort = () => child.abort("parent_aborted");
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
};

export const isPastDeadline = (now_ms: number, deadline_at_ms: number): boolean =>
  now_ms >= deadline_at_ms;

/**
 * Arm per-network + global deadline timers against an adapter abort controller.
 * Either expiry aborts the signal. Returns a disposer that cancels both timers.
 */
export const armDeadlineRace = (input: {
  readonly clock: MonotonicClock;
  readonly timer: DeadlineTimerPort;
  readonly controller: DeadlineController;
  readonly per_network_deadline_at_ms: number;
  readonly global_deadline_at_ms: number;
}): (() => void) => {
  const { clock, timer, controller, per_network_deadline_at_ms, global_deadline_at_ms } =
    input;
  const effective = Math.min(per_network_deadline_at_ms, global_deadline_at_ms);

  if (isPastDeadline(clock.nowMs(), effective)) {
    const reason =
      isPastDeadline(clock.nowMs(), global_deadline_at_ms) &&
      global_deadline_at_ms <= per_network_deadline_at_ms
        ? "global_deadline"
        : "per_network_deadline";
    controller.abort(reason);
    return () => undefined;
  }

  const cancelPerNetwork = timer.scheduleAt(per_network_deadline_at_ms, () => {
    controller.abort("per_network_deadline");
  });
  const cancelGlobal = timer.scheduleAt(global_deadline_at_ms, () => {
    controller.abort("global_deadline");
  });

  return () => {
    cancelPerNetwork();
    cancelGlobal();
  };
};

/**
 * Classify which deadline was exceeded after a probe settles (or mid-race).
 */
export const classifyDeadlineBreach = (input: {
  readonly now_ms: number;
  readonly per_network_deadline_at_ms: number;
  readonly global_deadline_at_ms: number;
  readonly abort_reason?: string;
}): "per_network_deadline" | "global_deadline" | undefined => {
  if (input.abort_reason === "global_deadline") return "global_deadline";
  if (input.abort_reason === "per_network_deadline") return "per_network_deadline";
  if (isPastDeadline(input.now_ms, input.global_deadline_at_ms)) return "global_deadline";
  if (isPastDeadline(input.now_ms, input.per_network_deadline_at_ms)) {
    return "per_network_deadline";
  }
  return undefined;
};

export type DeadlineKind = "per_network_deadline" | "global_deadline";

/**
 * Race an Effect settlement against absolute deadline timers.
 *
 * Starts the supplied Effect exactly once via `Effect.runCallback` (one fiber).
 * On the first deadline: abort via `onDeadline`, seal `timeoutValue` immediately,
 * then interrupt that same fiber. Late settlement handlers only consume
 * rejection / discard value from that one execution.
 *
 * Sync-compatible: when the single execution settles synchronously (hermetic
 * virtual adapters), the race completes under `runSync`. Async effects (real
 * timers) require `runPromise`.
 */
export const raceSettlementAgainstDeadlines = <A>(input: {
  readonly effect: Effect.Effect<A, never>;
  readonly clock: MonotonicClock;
  readonly timer: DeadlineTimerPort;
  readonly deadlines: ReadonlyArray<{
    readonly at_ms: number;
    readonly kind: DeadlineKind;
  }>;
  readonly onDeadline: (kind: DeadlineKind) => void;
  readonly timeoutValue: A;
}): Effect.Effect<A, never> =>
  Effect.async<A>((resume) => {
    let sealed = false;
    const cancels: Array<() => void> = [];
    let cancelExecution: (() => void) | undefined;

    const seal = (value: A): void => {
      if (sealed) return;
      sealed = true;
      for (const cancel of cancels) cancel();
      resume(Effect.succeed(value));
    };

    const fireDeadline = (kind: DeadlineKind): void => {
      if (sealed) return;
      input.onDeadline(kind);
      seal(input.timeoutValue);
      // Interrupt the one in-flight fiber after seal; late onExit discards.
      cancelExecution?.();
    };

    const now = input.clock.nowMs();
    const expiredDeadline = input.deadlines.reduce<
      { readonly at_ms: number; readonly kind: DeadlineKind } | undefined
    >((earliest, deadline) => {
      if (!isPastDeadline(now, deadline.at_ms)) return earliest;
      if (earliest === undefined || deadline.at_ms < earliest.at_ms) return deadline;
      return earliest;
    }, undefined);

    // An already-expired absolute deadline is a pre-start boundary. Select the
    // earliest expiry independent of caller ordering and never launch work.
    if (expiredDeadline !== undefined) {
      fireDeadline(expiredDeadline.kind);
      return;
    }

    for (const d of input.deadlines) {
      cancels.push(
        input.timer.scheduleAt(d.at_ms, () => {
          fireDeadline(d.kind);
        }),
      );
    }

    // Exactly one execution — never runSyncExit-probe then runPromise-fallback.
    cancelExecution = Effect.runCallback(input.effect, {
      onExit: (exit) => {
        if (sealed) {
          // Late settlement from the same execution: consume only.
          return;
        }
        if (Exit.isSuccess(exit)) {
          seal(exit.value);
        } else {
          seal(input.timeoutValue);
        }
      },
    });
  });

/**
 * Race a shared leader promise against a single remaining deadline.
 * Followers use this so they return at their own global bound.
 */
export const raceSharedAgainstDeadline = <A>(input: {
  readonly shared: Promise<A>;
  readonly clock: MonotonicClock;
  readonly timer: DeadlineTimerPort;
  readonly deadline_at_ms: number;
  readonly onDeadline: () => void;
  readonly timeoutValue: A;
}): Effect.Effect<A, never> =>
  raceSettlementAgainstDeadlines({
    effect: Effect.promise(() => input.shared),
    clock: input.clock,
    timer: input.timer,
    deadlines: [{ at_ms: input.deadline_at_ms, kind: "global_deadline" }],
    onDeadline: () => input.onDeadline(),
    timeoutValue: input.timeoutValue,
  });
