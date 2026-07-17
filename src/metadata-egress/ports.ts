/**
 * Injectable DNS and pinned-transport ports for CR-004 metadata egress.
 *
 * Production implementations resolve once, validate, and connect to the pinned
 * address (SNI/Host = original hostname). Tests inject scripted ports — no
 * real network I/O.
 */

import type {
  AddressFamily,
  TransportRequest,
  TransportResponse,
} from "./types.js";

export interface DnsAnswer {
  readonly address: string;
  readonly family: AddressFamily;
}

export interface DnsPort {
  /**
   * Resolve one hostname. Implementations MUST stop underlying lookup work
   * when `signal` aborts; retrieval races this port against a bounded DNS
   * deadline and must not leave resolver work orphaned after returning.
   */
  readonly lookup: (
    hostname: string,
    options: { readonly signal: AbortSignal },
  ) => Promise<ReadonlyArray<DnsAnswer>>;
}

/** Monotonic clock used only for absolute egress phase deadlines. */
export interface MetadataEgressClock {
  readonly nowMs: () => number;
}

/** Scheduler sharing the injected clock's absolute millisecond coordinate. */
export interface MetadataEgressDeadlineScheduler {
  readonly scheduleAt: (at_ms: number, callback: () => void) => () => void;
}

export interface PinnedTransportPort {
  /**
   * Perform one HTTP(S) exchange against `request.target.pinned_address`.
   * Implementations MUST NOT re-resolve DNS. TLS verification (when https)
   * MUST remain enabled and validate the original hostname.
   */
  readonly exchange: (request: TransportRequest) => Promise<TransportResponse>;
}

export interface MetadataEgressPorts {
  readonly dns: DnsPort;
  readonly transport: PinnedTransportPort;
}
