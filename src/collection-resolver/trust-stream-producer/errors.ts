import { Data } from "effect";

export class TrustStreamProducerError extends Data.TaggedError("TrustStreamProducerError")<{
  readonly reason:
    | "duplicate_event_id"
    | "unknown_signing_key"
    | "signing_key_not_active"
    | "epoch_baseline_incomplete"
    | "replay_range_invalid"
    | "stream_not_initialized";
  readonly detail?: string;
}> {}
