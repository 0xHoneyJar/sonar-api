/**
 * sonar-sense-solana.live.ts — the Solana sense adapter (mini-prototype).
 *
 * PROVES the chain-agnostic thesis: the same `Observation` envelope (grounding
 * tristate = the verified-state primitive, per ACVP) carries a SOLANA read
 * unchanged. The verb-CONCEPTS (native/balance/owns/doctor) are chain-neutral;
 * this adapter specialises them to Solana's account model (accounts hold state,
 * programs are stateless, NFTs are token accounts holding a mint at amount≥1).
 *
 * Sovereign + cheap by default (the eRPC philosophy, generalised): free public
 * cluster RPC, with `SOLANA_RPC_URL` (or `opts.rpcUrl`) as the only opt-in
 * upgrade (e.g. a Helius ingress) — pay for nothing we don't need.
 *
 * Greenfield, deliberately: compass MINTED + consumed events; it never read
 * Solana state first-hand. So this is the EVM sense PATTERN applied to Solana's
 * read primitives — `getBalance` · `getParsedTokenAccountsByOwner` — dogfooding
 * compass's verified stack (@solana/web3.js, base58, the cluster RPC seam).
 *
 * NOT in the prototype (the productization, design-noted): the verify
 * cross-check across ≥2 RPCs (the grounding SPINE — basic grounded-on-success
 * here); `read`/account+IDL decode (Anchor); unifying this with the EVM port
 * behind one `Address` union + `ChainAdapter` registry. This proves the
 * envelope ports; the unification follows once validated.
 */

import { Connection, PublicKey, type Commitment } from "@solana/web3.js";
import { grounded, unverifiable, type Observation } from "../../domain/observation.domain";
import type { HealthCheck, SenseHealth } from "../../ports/sonar-sense.port";

/** A base58 Solana address (validated at the boundary via `new PublicKey`). */
export type SolanaAddress = string;
/** The Solana cluster (the chain-family's "chain" selector). */
export type Cluster = "mainnet-beta" | "devnet";

export interface SolanaReadOptions {
  /** commitment level; defaults to "confirmed". */
  readonly commitment?: Commitment;
}

/**
 * The Solana sense edge — the SAME verb-concepts as the EVM `SonarSense`,
 * specialised to Solana. Returns the chain-neutral `Observation` envelope.
 */
export interface SolanaSense {
  /** Probe the Solana RPC health before trusting any read. */
  doctor(): Promise<Observation<SenseHealth>>;
  /** Native SOL balance (lamports) of an account. */
  native(cluster: Cluster, account: SolanaAddress, opts?: SolanaReadOptions): Promise<Observation<bigint>>;
  /** SPL token balance (raw amount, summed across the owner's token accounts) of a mint. */
  balance(cluster: Cluster, owner: SolanaAddress, mint: SolanaAddress, opts?: SolanaReadOptions): Promise<Observation<bigint>>;
  /** Does `owner` hold ≥1 of `mint`? (an NFT is a token account holding the mint at amount 1). */
  owns(cluster: Cluster, owner: SolanaAddress, mint: SolanaAddress, opts?: SolanaReadOptions): Promise<Observation<boolean>>;
}

/** Free public cluster RPCs (sovereign-cheap default; override via SOLANA_RPC_URL / opts.rpcUrl). */
const CLUSTER_RPC: Readonly<Record<Cluster, string>> = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
};

/**
 * Solana clusters have no numeric chain id — map to sentinel numbers so the
 * V1 Observation (chain_id: number) is reused unchanged. (The productization
 * widens chain_id to number|string; the prototype stays non-invasive.)
 * 101 = mainnet-beta, 103 = devnet (the conventional cluster ids).
 */
const CLUSTER_CHAIN_ID: Readonly<Record<Cluster, number>> = { "mainnet-beta": 101, devnet: 103 };

export interface SolanaLiveOptions {
  /** override the cluster RPC (e.g. a Helius ingress); defaults to `process.env.SOLANA_RPC_URL`, else the public cluster RPC. */
  readonly rpcUrl?: string;
  /** default commitment for reads. */
  readonly commitment?: Commitment;
}

/** Error CLASS only (never the attacker-influenceable message) — same defence as the EVM adapter. */
function errClass(e: unknown): string {
  const name = e instanceof Error ? e.name : "Unknown";
  return name.replace(/[^A-Za-z0-9]/g, "").slice(0, 40) || "Error";
}

/** Build a Solana sense adapter. */
export function makeSolanaSense(opts: SolanaLiveOptions = {}): SolanaSense {
  const override = opts.rpcUrl ?? process.env.SOLANA_RPC_URL ?? undefined;
  const commitment: Commitment = opts.commitment ?? "confirmed";
  const sourceKind = override ? "rpc" : "web3js";
  const conns = new Map<Cluster, Connection>();
  let seq = 0;
  const trace = (verb: string): string => `solana:${verb}:${++seq}`;

  function conn(cluster: Cluster): Connection {
    let c = conns.get(cluster);
    if (!c) {
      c = new Connection(override ?? CLUSTER_RPC[cluster], { commitment });
      conns.set(cluster, c);
    }
    return c;
  }

  /** Parse a base58 address; null (not throw) on malformed input. */
  function pubkey(addr: SolanaAddress): PublicKey | null {
    try {
      return new PublicKey(addr);
    } catch {
      return null;
    }
  }

  async function tokenAmount(cluster: Cluster, owner: PublicKey, mint: PublicKey, c: Commitment): Promise<bigint> {
    const res = await conn(cluster).getParsedTokenAccountsByOwner(owner, { mint }, c);
    let total = 0n;
    for (const { account } of res.value) {
      const data = account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } };
      const amt = data.parsed?.info?.tokenAmount?.amount;
      if (typeof amt === "string" && /^\d+$/.test(amt)) total += BigInt(amt);
    }
    return total;
  }

  return {
    async doctor() {
      const checks: HealthCheck[] = [];
      const start = Date.now();
      let ok = false;
      try {
        const [version, slot] = await Promise.all([conn("mainnet-beta").getVersion(), conn("mainnet-beta").getSlot(commitment)]);
        ok = typeof slot === "number" && slot > 0;
        checks.push({ target: "rpc:solana-mainnet", status: ok ? "up" : "down", latency_ms: Date.now() - start, detail: `core ${version["solana-core"]} · slot ${slot}` });
      } catch (e) {
        checks.push({ target: "rpc:solana-mainnet", status: "down", latency_ms: Date.now() - start, detail: errClass(e) });
      }
      const value: SenseHealth = { ok, checks };
      const init = { value, source: "solana:doctor", chain_id: CLUSTER_CHAIN_ID["mainnet-beta"], trace_id: trace("doctor") };
      return ok ? grounded<SenseHealth>(init) : unverifiable<SenseHealth>(init);
    },

    async native(cluster, account, o) {
      const chain_id = CLUSTER_CHAIN_ID[cluster];
      const pk = pubkey(account);
      if (!pk) return unverifiable<bigint>({ value: 0n, source: "solana:malformed-address", chain_id, trace_id: trace("native") });
      try {
        const lamports = await conn(cluster).getBalance(pk, o?.commitment ?? commitment);
        return grounded<bigint>({ value: BigInt(lamports), source: `${sourceKind}:${cluster}`, chain_id, trace_id: trace("native") });
      } catch (e) {
        return unverifiable<bigint>({ value: 0n, source: `solana:rpc-error:${errClass(e)}`, chain_id, trace_id: trace("native") });
      }
    },

    async balance(cluster, owner, mint, o) {
      const chain_id = CLUSTER_CHAIN_ID[cluster];
      const ownerPk = pubkey(owner);
      const mintPk = pubkey(mint);
      if (!ownerPk || !mintPk) return unverifiable<bigint>({ value: 0n, source: "solana:malformed-address", chain_id, trace_id: trace("balance") });
      try {
        const total = await tokenAmount(cluster, ownerPk, mintPk, o?.commitment ?? commitment);
        return grounded<bigint>({ value: total, source: `${sourceKind}:${cluster}`, chain_id, trace_id: trace("balance") });
      } catch (e) {
        return unverifiable<bigint>({ value: 0n, source: `solana:rpc-error:${errClass(e)}`, chain_id, trace_id: trace("balance") });
      }
    },

    async owns(cluster, owner, mint, o) {
      const chain_id = CLUSTER_CHAIN_ID[cluster];
      const ownerPk = pubkey(owner);
      const mintPk = pubkey(mint);
      if (!ownerPk || !mintPk) return unverifiable<boolean>({ value: false, source: "solana:malformed-address", chain_id, trace_id: trace("owns") });
      try {
        const total = await tokenAmount(cluster, ownerPk, mintPk, o?.commitment ?? commitment);
        return grounded<boolean>({ value: total >= 1n, source: `${sourceKind}:${cluster}`, chain_id, trace_id: trace("owns") });
      } catch (e) {
        return unverifiable<boolean>({ value: false, source: `solana:rpc-error:${errClass(e)}`, chain_id, trace_id: trace("owns") });
      }
    },
  };
}
