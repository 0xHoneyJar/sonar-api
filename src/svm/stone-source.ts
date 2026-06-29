/**
 * stone-source.ts — the SVM substrate SEAM for the Purupuru genesis stones.
 *
 * The design (grimoires/loa/specs/2026-06-21-svm-genesis-stones-design.md): the indexer reads
 * `StoneClaimed` events from a `StoneSource` and NEVER learns which substrate fed it. v1 = RPC
 * (ships now); `HyperSyncStoneSource` swaps in behind the SAME interface once Solana HyperSync gains
 * instruction/log handlers + genesis backfill (today it can't — 2026-06-20-svm-substrate-finding.md).
 * Designing for HyperSync now is what makes that swap a config change, not a rewrite — exactly the
 * lesson the EVM cutover taught (the substrate moved; the belt-gateway blanket held).
 */

import { Connection, PublicKey } from "@solana/web3.js";

/** purupuru-anchor program (mainnet). */
export const GENESIS_STONE_PROGRAM = new PublicKey("7u27WmTz2hZHvvhL89XcSCY3eFhxEfHjUN5MjzMY6v38");

/** Anchor event discriminator for `StoneClaimed` (first 8 bytes of the `Program data:` log). */
export const STONE_CLAIMED_DISCRIMINATOR = Uint8Array.from([138, 131, 241, 101, 8, 187, 119, 216]);

/** element u8 → name (from purupuru-anchor `element_name`). */
export const ELEMENT = { 1: "Wood", 2: "Fire", 3: "Earth", 4: "Metal", 5: "Water" } as const;
export type ElementByte = keyof typeof ELEMENT;

/** The decoded StoneClaimed event — the indexer's only currency, substrate-neutral. */
export interface StoneClaimed {
  readonly wallet: string;        // base58 claimer
  readonly element: number;       // 1..5
  readonly elementName: string;   // Wood/Fire/Earth/Metal/Water
  readonly weather: number;       // u8
  readonly mint: string;          // base58 NFT mint (the entity key)
  readonly slot: number;
  readonly sig: string;           // tx signature (provenance)
  readonly claimedAt: Date;
  readonly source: "rpc" | "hypersync";
}

export interface SourceHealth { readonly ok: boolean; readonly detail: string; }

/**
 * The SEAM. Any substrate (RPC today, HyperSync tomorrow) implements this; the indexer depends on
 * nothing else. backfill() is historical (genesis → toSlot), stream() is the realtime tail.
 */
export interface StoneSource {
  backfill(fromSlot?: number, toSlot?: number): AsyncIterable<StoneClaimed>;
  stream(): AsyncIterable<StoneClaimed>;
  health(): Promise<SourceHealth>;
}

/** Decode a base64 `Program data:` payload into StoneClaimed, or null if it isn't our event. */
export function decodeStoneClaimed(
  base64: string,
  ctx: { slot: number; sig: string; blockTime: number | null | undefined; source: "rpc" | "hypersync" },
): StoneClaimed | null {
  const buf = Buffer.from(base64, "base64");
  // layout: [0..8) discriminator · [8..40) wallet pubkey · [40] element u8 · [41] weather u8 · [42..74) mint pubkey
  if (buf.length < 74) return null;
  for (let i = 0; i < 8; i++) if (buf[i] !== STONE_CLAIMED_DISCRIMINATOR[i]) return null;
  const wallet = new PublicKey(buf.subarray(8, 40)).toBase58();
  const element = buf[40];
  const weather = buf[41];
  const mint = new PublicKey(buf.subarray(42, 74)).toBase58();
  return {
    wallet, element, elementName: ELEMENT[element as ElementByte] ?? `unknown(${element})`,
    weather, mint, slot: ctx.slot, sig: ctx.sig,
    claimedAt: new Date((ctx.blockTime ?? 0) * 1000), source: ctx.source,
  };
}

/** Pull the base64 from an Anchor `Program data:` log line. */
export function programDataFromLog(line: string): string | null {
  const m = line.match(/^Program data: (.+)$/);
  return m ? m[1] : null;
}

/**
 * v1 — RPC substrate. Walks the program's signatures, decodes StoneClaimed from each tx's logs.
 * Cheap (cluster RPC, or a Helius ingress via SOLANA_RPC_URL). The realtime tail uses onLogs.
 * NOTE: the upsert loop + Postgres live in genesis-stone-indexer.ts (next build step); this is the
 * grounded source scaffold proving the decode + the seam.
 */
export class RpcStoneSource implements StoneSource {
  constructor(private readonly conn: Connection) {}

  async *backfill(_fromSlot?: number, _toSlot?: number): AsyncIterable<StoneClaimed> {
    let before: string | undefined;
    for (;;) {
      const sigs = await this.conn.getSignaturesForAddress(GENESIS_STONE_PROGRAM, { before, limit: 1000 });
      if (sigs.length === 0) return;
      for (const s of sigs) {
        const tx = await this.conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
        for (const log of tx?.meta?.logMessages ?? []) {
          const data = programDataFromLog(log);
          if (!data) continue;
          const ev = decodeStoneClaimed(data, { slot: s.slot, sig: s.signature, blockTime: s.blockTime, source: "rpc" });
          if (ev) yield ev;
        }
      }
      before = sigs[sigs.length - 1].signature;
    }
  }

  async *stream(): AsyncIterable<StoneClaimed> {
    // onLogs(program) tail — push-based; bridged to the async iterable in the indexer loop.
    // Scaffolded here as the seam contract; wiring lands with genesis-stone-indexer.ts.
    throw new Error("RpcStoneSource.stream: wire onLogs in genesis-stone-indexer.ts");
  }

  async health(): Promise<SourceHealth> {
    try { await this.conn.getSlot(); return { ok: true, detail: "rpc reachable" }; }
    catch (e) { return { ok: false, detail: `rpc: ${(e as Error).message}` }; }
  }
}

/**
 * FUTURE — HyperSync substrate. Stubbed deliberately. Solana HyperSync today is rolling-window with NO
 * instruction/log handlers, so it cannot decode `StoneClaimed` yet (2026-06-20-svm-substrate-finding.md).
 * When it ships instruction handlers + genesis backfill, implement this against the firehose — the
 * indexer needs ZERO change (that's the seam paying off). Ask Envio for the Solana-HyperSync roadmap.
 */
export class HyperSyncStoneSource implements StoneSource {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *backfill(_f?: number, _t?: number): AsyncIterable<StoneClaimed> {
    throw new Error("HyperSyncStoneSource: not yet — Solana HyperSync lacks instruction handlers + genesis (see SVM finding). Swap in when GA.");
  }
  async *stream(): AsyncIterable<StoneClaimed> {
    throw new Error("HyperSyncStoneSource: not yet — see SVM finding.");
  }
  async health(): Promise<SourceHealth> { return { ok: false, detail: "hypersync-svm: not GA for instruction-level (stub)" }; }
}
