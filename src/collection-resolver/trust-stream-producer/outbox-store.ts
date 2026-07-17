import type { StreamEpochBaseline, TrustEnvelope } from "../trust-protocol.js";

export interface TrustStreamOutboxEntry {
  readonly outboxSeq: number;
  readonly streamId: string;
  readonly streamEpoch: number;
  readonly sequence: number;
  readonly eventId: string;
  readonly envelope: TrustEnvelope;
  readonly committedAtMs: number;
}

export interface TrustStreamSnapshot {
  readonly streamId: string;
  streamEpoch: number;
  nextSequence: number;
  readonly envelopes: ReadonlyArray<TrustEnvelope>;
  readonly baselines: ReadonlyArray<StreamEpochBaseline>;
  readonly seenEventIds: ReadonlySet<string>;
}

export interface TrustStreamOutboxStore {
  /** Atomically allocate the next contiguous sequence and append an outbox row. */
  appendAtomic(input: {
    readonly streamId: string;
    readonly eventId: string;
    readonly envelope: TrustEnvelope;
    readonly committedAtMs: number;
  }): TrustStreamOutboxEntry;

  /** Record a signed epoch baseline after the prior epoch is sealed. */
  recordEpochBaseline(input: {
    readonly streamId: string;
    readonly baseline: StreamEpochBaseline;
    readonly committedAtMs: number;
  }): void;

  /** Advance to a new epoch after baseline is recorded; resets sequence to 1. */
  advanceEpoch(input: { readonly streamId: string; readonly newEpoch: number }): void;

  replayRange(input: {
    readonly streamId: string;
    readonly streamEpoch: number;
    readonly fromSequence: number;
    readonly toSequence: number;
  }): ReadonlyArray<TrustEnvelope>;

  snapshot(streamId: string): TrustStreamSnapshot;

  /** Hydrate producer state from a durable snapshot (failover / restart). */
  restore(snapshot: TrustStreamSnapshot): void;

  hasEventId(streamId: string, eventId: string): boolean;
}

export const createInMemoryTrustStreamOutboxStore = (): TrustStreamOutboxStore => {
  const streamState = new Map<
    string,
    { streamEpoch: number; nextSequence: number; seenEventIds: Set<string> }
  >();
  const outbox: TrustStreamOutboxEntry[] = [];
  const baselinesByStream = new Map<string, StreamEpochBaseline[]>();
  let outboxSeq = 1;

  const ensureStream = (streamId: string) => {
    let state = streamState.get(streamId);
    if (state === undefined) {
      state = { streamEpoch: 1, nextSequence: 1, seenEventIds: new Set() };
      streamState.set(streamId, state);
    }
    return state;
  };

  return {
    appendAtomic(input) {
      const state = ensureStream(input.streamId);
      if (state.seenEventIds.has(input.eventId)) {
        throw new Error("duplicate_event_id");
      }
      if (input.envelope.header.stream_id !== input.streamId) {
        throw new Error("stream_id_mismatch");
      }
      if (input.envelope.header.stream_epoch !== state.streamEpoch) {
        throw new Error("stream_epoch_mismatch");
      }
      if (input.envelope.header.sequence !== state.nextSequence) {
        throw new Error("sequence_not_contiguous");
      }

      const entry: TrustStreamOutboxEntry = {
        outboxSeq: outboxSeq++,
        streamId: input.streamId,
        streamEpoch: state.streamEpoch,
        sequence: state.nextSequence,
        eventId: input.eventId,
        envelope: input.envelope,
        committedAtMs: input.committedAtMs,
      };
      outbox.push(entry);
      state.seenEventIds.add(input.eventId);
      state.nextSequence += 1;
      return entry;
    },

    recordEpochBaseline(input) {
      const list = baselinesByStream.get(input.streamId) ?? [];
      list.push(input.baseline);
      baselinesByStream.set(input.streamId, list);
    },

    advanceEpoch(input) {
      const state = ensureStream(input.streamId);
      state.streamEpoch = input.newEpoch;
      state.nextSequence = 1;
    },

    replayRange(input) {
      return outbox
        .filter(
          (entry) =>
            entry.streamId === input.streamId &&
            entry.streamEpoch === input.streamEpoch &&
            entry.sequence >= input.fromSequence &&
            entry.sequence <= input.toSequence,
        )
        .sort((a, b) => a.sequence - b.sequence)
        .map((entry) => entry.envelope);
    },

    snapshot(streamId) {
      const state = ensureStream(streamId);
      const envelopes = outbox
        .filter((entry) => entry.streamId === streamId && entry.streamEpoch === state.streamEpoch)
        .sort((a, b) => a.sequence - b.sequence)
        .map((entry) => entry.envelope);
      return {
        streamId,
        streamEpoch: state.streamEpoch,
        nextSequence: state.nextSequence,
        envelopes,
        baselines: [...(baselinesByStream.get(streamId) ?? [])],
        seenEventIds: new Set(state.seenEventIds),
      };
    },

    restore(snapshot) {
      streamState.set(snapshot.streamId, {
        streamEpoch: snapshot.streamEpoch,
        nextSequence: snapshot.nextSequence,
        seenEventIds: new Set(snapshot.seenEventIds),
      });
      baselinesByStream.set(snapshot.streamId, [...snapshot.baselines]);
      for (const envelope of snapshot.envelopes) {
        const existing = outbox.some(
          (entry) =>
            entry.streamId === snapshot.streamId &&
            entry.streamEpoch === envelope.header.stream_epoch &&
            entry.sequence === envelope.header.sequence,
        );
        if (!existing) {
          outbox.push({
            outboxSeq: outboxSeq++,
            streamId: snapshot.streamId,
            streamEpoch: envelope.header.stream_epoch,
            sequence: envelope.header.sequence,
            eventId: envelope.header.event_id,
            envelope,
            committedAtMs: Date.parse(envelope.header.issued_at),
          });
        }
      }
    },

    hasEventId(streamId, eventId) {
      return ensureStream(streamId).seenEventIds.has(eventId);
    },
  };
};
