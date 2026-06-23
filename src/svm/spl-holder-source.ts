/**
 * spl-holder-source.ts — the SVM substrate SEAM for SPL token HOLDER balances.
 *
 * Sibling of stone-source.ts (Purupuru genesis stones), same design
 * (grimoires/loa/specs/2026-06-23-svm-pump-fun-holders-design.md): an indexer reads a holder
 * SNAPSHOT from a `SplHolderSource` and NEVER learns which substrate produced it. v1 = RPC
 * (`getProgramAccounts` over the mint's token program); `HyperSyncSplHolderSource` swaps in behind
 * the SAME interface once Solana HyperSync gains the account/instruction handlers it lacks today
 * (2026-06-20-svm-substrate-finding.md). Designing for the swap now keeps it a config change, not a
 * rewrite — the lesson the EVM cutover taught.
 *
 * Holders are a CURRENT-STATE snapshot (who holds what now), not an append-only event log — so the
 * source returns the full set at a slot and the indexer reconciles (see pump-fun-indexer.ts).
 *
 * Token-2022 aware: the Pythians mint (7C9…pump) is owned by the Token-2022 program, whose token
 * accounts can carry TLV extensions (length > 165). The base Account fields (mint@0, owner@32,
 * amount u64@64) are identical to the classic layout, so the decode is length-agnostic; only the
 * `getProgramAccounts` dataSize filter differs by program (classic accounts are exactly 165 bytes).
 */

import { Connection, PublicKey, type GetProgramAccountsFilter } from "@solana/web3.js";

/** Classic SPL Token program. */
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/** Token-2022 (Token Extensions) program — owns the Pythians mint. */
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** One holder's aggregated balance for a mint (summed across that owner's token accounts). */
export interface HolderBalance {
  readonly owner: string; // base58 wallet
  readonly amountRaw: bigint; // raw u64 (no decimals applied)
}

/** A full current-state holder snapshot for one mint at one slot — the indexer's only currency. */
export interface HolderSnapshot {
  readonly mint: string; // base58
  readonly program: string; // base58 token program that owns the mint (classic | token-2022)
  readonly decimals: number;
  readonly slot: number; // snapshot slot
  readonly source: "rpc" | "hypersync";
  readonly holders: readonly HolderBalance[]; // amountRaw > 0, sorted desc
}

export interface SourceHealth {
  readonly ok: boolean;
  readonly detail: string;
}

/** The SEAM. Any substrate (RPC today, HyperSync tomorrow) implements this. */
export interface SplHolderSource {
  snapshot(): Promise<HolderSnapshot>;
  health(): Promise<SourceHealth>;
}

// ── pure decoders (no runtime/RPC — unit-testable) ──────────────────────────

/**
 * Mint `decimals` — byte 44 of the mint account. The classic mint base layout
 * (mintAuthorityOption[4] + mintAuthority[32] + supply[8] + decimals[1] + …) is shared by
 * Token-2022 mints for the first 82 bytes, so offset 44 holds regardless of extensions.
 */
export function decodeMintDecimals(data: Buffer): number {
  if (data.length < 45) throw new Error(`mint account too short: ${data.length} bytes`);
  return data[44];
}

/**
 * Parse a token account's base fields. Identical offsets for classic + Token-2022
 * (mint@[0,32) · owner@[32,64) · amount u64 LE@[64,72)); extensions, if any, start at byte 165 and
 * are ignored here.
 */
export function parseTokenAccount(data: Buffer): { mint: string; owner: string; amountRaw: bigint } {
  if (data.length < 72) throw new Error(`token account too short: ${data.length} bytes`);
  return {
    mint: new PublicKey(data.subarray(0, 32)).toBase58(),
    owner: new PublicKey(data.subarray(32, 64)).toBase58(),
    amountRaw: data.readBigUInt64LE(64),
  };
}

/** Sum balances per owner, drop zero balances, sort by balance descending. */
export function aggregateByOwner(
  accounts: ReadonlyArray<{ owner: string; amountRaw: bigint }>,
): HolderBalance[] {
  const byOwner = new Map<string, bigint>();
  for (const a of accounts) {
    byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0n) + a.amountRaw);
  }
  return [...byOwner.entries()]
    .filter(([, amt]) => amt > 0n)
    .map(([owner, amountRaw]) => ({ owner, amountRaw }))
    .sort((a, b) => (b.amountRaw > a.amountRaw ? 1 : b.amountRaw < a.amountRaw ? -1 : 0));
}

// ── v1 RPC substrate ────────────────────────────────────────────────────────

/**
 * v1 — RPC substrate. Detects the mint's token program from the mint account owner, then walks every
 * token account for the mint via `getProgramAccounts(program, memcmp(mint@0))` and aggregates by
 * owner. Needs a capable RPC (Helius via SOLANA_RPC_URL) — a popular mint can have many holders, and
 * public endpoints throttle large `getProgramAccounts`.
 */
export class RpcSplHolderSource implements SplHolderSource {
  private readonly mintPk: PublicKey;

  constructor(
    private readonly conn: Connection,
    readonly mint: string,
  ) {
    this.mintPk = new PublicKey(mint);
  }

  /** Resolve the token program that owns the mint + the mint's decimals. */
  private async resolveMint(): Promise<{ program: PublicKey; decimals: number }> {
    const info = await this.conn.getAccountInfo(this.mintPk);
    if (!info) throw new Error(`mint ${this.mint} not found`);
    const program = info.owner;
    if (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new Error(`mint ${this.mint} not owned by a known token program (owner ${program.toBase58()})`);
    }
    return { program, decimals: decodeMintDecimals(info.data) };
  }

  async snapshot(): Promise<HolderSnapshot> {
    const { program, decimals } = await this.resolveMint();
    const isClassic = program.equals(TOKEN_PROGRAM_ID);

    // memcmp on the token-account `mint` field at offset 0. Classic accounts are exactly 165 bytes;
    // Token-2022 accounts vary (extensions), so the dataSize filter is classic-only.
    const filters: GetProgramAccountsFilter[] = [
      { memcmp: { offset: 0, bytes: this.mint } },
    ];
    if (isClassic) filters.unshift({ dataSize: 165 });

    const accounts = await this.conn.getProgramAccounts(program, { filters });
    const parsed = accounts.map(({ account }) => {
      const { owner, amountRaw } = parseTokenAccount(account.data as Buffer);
      return { owner, amountRaw };
    });

    const slot = await this.conn.getSlot("confirmed");
    return {
      mint: this.mint,
      program: program.toBase58(),
      decimals,
      slot,
      source: "rpc",
      holders: aggregateByOwner(parsed),
    };
  }

  async health(): Promise<SourceHealth> {
    try {
      await this.conn.getSlot();
      return { ok: true, detail: "rpc reachable" };
    } catch (e) {
      return { ok: false, detail: `rpc: ${(e as Error).message}` };
    }
  }
}

/**
 * FUTURE — HyperSync substrate. Stubbed deliberately (mirrors HyperSyncStoneSource). Solana HyperSync
 * today is a rolling window without the account/instruction handlers needed to materialize holder
 * state (2026-06-20-svm-substrate-finding.md). Implement against the firehose when it ships token
 * account tracking — the indexer needs ZERO change (the seam paying off).
 */
export class HyperSyncSplHolderSource implements SplHolderSource {
  async snapshot(): Promise<HolderSnapshot> {
    throw new Error("HyperSyncSplHolderSource: not yet — Solana HyperSync lacks token-account handlers (see SVM finding). Swap in when GA.");
  }
  async health(): Promise<SourceHealth> {
    return { ok: false, detail: "hypersync-svm: not GA for token-account state (stub)" };
  }
}
