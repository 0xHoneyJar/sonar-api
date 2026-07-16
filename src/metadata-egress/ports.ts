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
  readonly lookup: (hostname: string) => Promise<ReadonlyArray<DnsAnswer>>;
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
