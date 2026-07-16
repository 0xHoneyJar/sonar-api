/**
 * Monotonic server clock + deadline timer ports for CR-102.
 *
 * Production uses wall-derived monotonic ms; hermetic tests inject a virtual
 * clock so deadlines/TTLs advance without sleeps or external networks.
 * Timers fire when monotonic time reaches their absolute deadline — never by
 * wall-clock sleeps in hermetic mode.
 */
export interface MonotonicClock {
  /** Monotonic milliseconds since an arbitrary origin (never goes backwards). */
  readonly nowMs: () => number;
  /** Canonical UTC ISO timestamp for emitted records (may be virtual). */
  readonly nowIso: () => string;
}

/**
 * Schedule absolute-deadline callbacks against the injected monotonic clock.
 * Used to race adapters with per-network and global cancellation boundaries.
 */
export interface DeadlineTimerPort {
  /**
   * Schedule `cb` to run once when `nowMs() >= at_ms`.
   * If already past, invokes synchronously. Returns a cancel function.
   */
  readonly scheduleAt: (at_ms: number, cb: () => void) => () => void;
}

export interface VirtualClock extends MonotonicClock, DeadlineTimerPort {
  readonly advanceMs: (delta: number) => void;
  readonly setIsoBase: (iso: string) => void;
}

const ISO_Z =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const toIso = (epochMs: number): string => new Date(epochMs).toISOString();

interface ScheduledTimer {
  readonly at_ms: number;
  readonly cb: () => void;
  cancelled: boolean;
}

/**
 * Virtual deterministic clock. Starts at `originMs` / `isoBase`.
 * `advanceMs` is the only way time moves in hermetic tests; scheduled timers
 * fire as time crosses their absolute deadlines.
 */
export const createVirtualClock = (input?: {
  readonly originMs?: number;
  readonly isoBase?: string;
}): VirtualClock => {
  let current = input?.originMs ?? 0;
  let isoBaseMs =
    input?.isoBase !== undefined && ISO_Z.test(input.isoBase)
      ? Date.parse(input.isoBase)
      : Date.parse("2026-07-16T12:00:00.000Z");
  const timers: ScheduledTimer[] = [];

  const flushTimers = (): void => {
    // Fire in deadline order; newly scheduled-from-callback timers flush too.
    for (;;) {
      let nextIdx = -1;
      let nextAt = Number.POSITIVE_INFINITY;
      for (let i = 0; i < timers.length; i++) {
        const t = timers[i]!;
        if (t.cancelled) continue;
        if (t.at_ms <= current && t.at_ms < nextAt) {
          nextAt = t.at_ms;
          nextIdx = i;
        }
      }
      if (nextIdx < 0) {
        // Drop cancelled entries.
        for (let i = timers.length - 1; i >= 0; i--) {
          if (timers[i]!.cancelled) timers.splice(i, 1);
        }
        return;
      }
      const due = timers.splice(nextIdx, 1)[0]!;
      if (!due.cancelled) due.cb();
    }
  };

  return {
    nowMs: () => current,
    nowIso: () => toIso(isoBaseMs + current),
    advanceMs: (delta: number) => {
      if (!Number.isFinite(delta) || delta < 0) {
        throw new Error("virtual clock advanceMs requires non-negative finite delta");
      }
      current += delta;
      flushTimers();
    },
    setIsoBase: (iso: string) => {
      if (!ISO_Z.test(iso)) {
        throw new Error("virtual clock isoBase must be canonical UTC Z");
      }
      isoBaseMs = Date.parse(iso);
    },
    scheduleAt: (at_ms: number, cb: () => void) => {
      if (!Number.isFinite(at_ms)) {
        throw new Error("scheduleAt requires finite absolute deadline");
      }
      const entry: ScheduledTimer = { at_ms, cb, cancelled: false };
      if (at_ms <= current) {
        cb();
        return () => {
          entry.cancelled = true;
        };
      }
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
};

/** Production-ish monotonic clock (process hrtime derived) with real timers. */
export const createProcessMonotonicClock = (): MonotonicClock & DeadlineTimerPort => {
  const origin = process.hrtime.bigint();
  const wallOrigin = Date.now();
  const nowMs = (): number => Number((process.hrtime.bigint() - origin) / 1_000_000n);
  return {
    nowMs,
    nowIso: () =>
      new Date(wallOrigin + Number((process.hrtime.bigint() - origin) / 1_000_000n)).toISOString(),
    scheduleAt: (at_ms: number, cb: () => void) => {
      const delay = Math.max(0, at_ms - nowMs());
      const handle = setTimeout(cb, delay);
      return () => clearTimeout(handle);
    },
  };
};

/** Bind a DeadlineTimerPort from any VirtualClock / process clock that exposes scheduleAt. */
export const asDeadlineTimer = (
  clock: MonotonicClock & Partial<DeadlineTimerPort>,
): DeadlineTimerPort => {
  if (typeof clock.scheduleAt === "function") {
    return { scheduleAt: clock.scheduleAt.bind(clock) };
  }
  // Fallback: poll-less no-op timer (deadlines checked explicitly after results).
  return {
    scheduleAt: (at_ms, cb) => {
      if (clock.nowMs() >= at_ms) {
        cb();
      }
      return () => undefined;
    },
  };
};
