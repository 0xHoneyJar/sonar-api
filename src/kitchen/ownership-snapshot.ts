/**
 * Ownership Snapshot — Gate Leak E1 (as-of I3) + rich E2 for A4/P2.
 *
 * Evidence only: concentration numbers and whale *candidates* from raw balances.
 * Does NOT apply product policy P2 thresholds (those stay outside Sonar).
 *
 * See freeside-blueprint human/products/access-audits.md · sonar-api#240 · #241
 */

export type OwnershipConcentration = {
  /** Share of total supply held by the top 10 wallets (0..1). */
  top10_share: number;
  /** Herfindahl–Hirschman index over balance shares (0=dispersed, 1=monopoly). */
  hhi: number;
  /** Gini coefficient over balances (0=equal, →1=concentrated). */
  gini: number;
};

export type OwnershipHolderRow = {
  address: string;
  balance: number;
};

export type InsufficientData = {
  status: "insufficient_data";
  reason: string;
};

export type OwnershipSnapshotSubject = {
  caip10: string;
  network_namespace: string;
  network_reference: string;
  address: string;
};

export type OwnershipSnapshot = {
  schema_version: 1;
  plane: "sonar_kitchen_ownership";
  subject: OwnershipSnapshotSubject;
  /** ISO date (YYYY-MM-DD) when dated (E1); null for current (E2). */
  as_of: string | null;
  as_of_timestamp: number | null;
  as_of_block: number | null;
  observed_at: string;
  coverage: {
    ownership: "available" | "unavailable";
  };
  holder_count: number;
  /** Top holders by balance (capped); full vector used for concentration. */
  holders: OwnershipHolderRow[];
  concentration: OwnershipConcentration | InsufficientData;
  /**
   * Count of holders in the top (100 − WHALE_EVIDENCE_PCT)% by balance.
   * Evidence floor for Gate Leak A4 — NOT product policy P2.
   */
  whale_candidate_count: number | InsufficientData;
  metrics?: InsufficientData;
};

/** Evidence cut: top 5% of positive-balance holders (count-stable). Not P2. */
export const WHALE_EVIDENCE_PCT = 95;

/** Max holder rows returned in the snapshot body (concentration uses full set). */
export const HOLDERS_RESPONSE_CAP = 500;

/** Job-class cap on Action rows pulled for as-of replay (aligned with Score audit). */
export const OWNERSHIP_SNAPSHOT_MAX_ACTIONS = 250_000;

export function computeGini(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const asc = [...values].sort((a, b) => a - b);
  const total = asc.reduce((s, v) => s + v, 0);
  if (total === 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * asc[i]!;
  return (2 * cum) / (n * total) - (n + 1) / n;
}

export function computeConcentration(balances: number[]): OwnershipConcentration {
  const holdings = balances.filter((b) => b > 0).sort((a, b) => b - a);
  const total = holdings.reduce((s, n) => s + n, 0);
  const top10 = holdings.slice(0, 10).reduce((s, n) => s + n, 0);
  return {
    top10_share: total > 0 ? top10 / total : 0,
    hhi: total > 0 ? holdings.reduce((s, n) => s + (n / total) ** 2, 0) : 0,
    gini: computeGini(holdings),
  };
}

/**
 * Count-stable whale evidence cut: ceil(n * (100 − pct) / 100) of top holders.
 * Mirrors Score cohort whale_pct semantics without importing Score.
 */
export function countWhaleCandidates(
  balances: number[],
  whalePct: number = WHALE_EVIDENCE_PCT,
): number {
  const positive = balances.filter((b) => b > 0);
  const n = positive.length;
  if (n === 0) return 0;
  const topK = Math.max(1, Math.ceil((n * (100 - whalePct)) / 100));
  return Math.min(n, topK);
}

export function parseCaip10(raw: string): OwnershipSnapshotSubject | null {
  const trimmed = raw.trim();
  const parts = trimmed.split(":");
  if (parts.length !== 3) return null;
  const [network_namespace, network_reference, addressRaw] = parts;
  if (!network_namespace || !network_reference || !addressRaw) return null;
  if (network_namespace !== "eip155") return null;
  if (!/^\d+$/.test(network_reference)) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(addressRaw)) return null;
  const address = addressRaw.toLowerCase();
  return {
    caip10: `${network_namespace}:${network_reference}:${address}`,
    network_namespace,
    network_reference,
    address,
  };
}

/** Parse YYYY-MM-DD (or full ISO) to end-of-UTC-day unix seconds for as_of cutoff. */
export function parseAsOfToUnixSeconds(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dayOnly) {
    const y = Number(dayOnly[1]);
    const m = Number(dayOnly[2]);
    const d = Number(dayOnly[3]);
    const ms = Date.UTC(y, m - 1, d, 23, 59, 59);
    if (Number.isNaN(ms)) return null;
    // Reject overflow / invalid calendar dates (e.g. 2026-02-31 → Mar).
    const check = new Date(ms);
    if (
      check.getUTCFullYear() !== y ||
      check.getUTCMonth() !== m - 1 ||
      check.getUTCDate() !== d
    ) {
      return null;
    }
    return Math.floor(ms / 1000);
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

export function asOfDateString(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function buildOwnershipSnapshot(args: {
  subject: OwnershipSnapshotSubject;
  holders: OwnershipHolderRow[];
  asOfUnixSeconds: number | null;
  asOfBlock?: number | null;
  observedAtMs?: number;
  holdersCap?: number;
  insufficient?: InsufficientData;
}): OwnershipSnapshot {
  const observed_at = new Date(args.observedAtMs ?? Date.now()).toISOString();
  const as_of =
    args.asOfUnixSeconds != null ? asOfDateString(args.asOfUnixSeconds) : null;

  if (args.insufficient) {
    return {
      schema_version: 1,
      plane: "sonar_kitchen_ownership",
      subject: args.subject,
      as_of,
      as_of_timestamp: args.asOfUnixSeconds,
      as_of_block: args.asOfBlock ?? null,
      observed_at,
      coverage: { ownership: "unavailable" },
      holder_count: 0,
      holders: [],
      concentration: args.insufficient,
      whale_candidate_count: args.insufficient,
      metrics: args.insufficient,
    };
  }

  const sorted = [...args.holders]
    .filter((h) => h.balance > 0)
    .map((h) => ({ address: h.address.toLowerCase(), balance: h.balance }))
    .sort((a, b) => b.balance - a.balance || a.address.localeCompare(b.address));

  const balances = sorted.map((h) => h.balance);
  const cap = args.holdersCap ?? HOLDERS_RESPONSE_CAP;

  return {
    schema_version: 1,
    plane: "sonar_kitchen_ownership",
    subject: args.subject,
    as_of,
    as_of_timestamp: args.asOfUnixSeconds,
    as_of_block: args.asOfBlock ?? null,
    observed_at,
    coverage: { ownership: sorted.length > 0 ? "available" : "unavailable" },
    holder_count: sorted.length,
    holders: sorted.slice(0, cap),
    concentration:
      sorted.length > 0
        ? computeConcentration(balances)
        : { status: "insufficient_data", reason: "no positive-balance holders" },
    whale_candidate_count:
      sorted.length > 0
        ? countWhaleCandidates(balances)
        : { status: "insufficient_data", reason: "no positive-balance holders" },
  };
}

/**
 * Replay hold721 Actions into a balance map.
 * `numeric1` is the post-event running balance (authoritative).
 */
export function replayHold721Actions(
  actions: ReadonlyArray<{
    actor: string;
    timestamp: number;
    numeric1: number | null;
    direction?: string | null;
    id: string;
  }>,
  cutoffUnixSeconds: number,
): Map<string, number> {
  const ordered = [...actions]
    .filter((a) => a.timestamp <= cutoffUnixSeconds)
    .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));

  const balances = new Map<string, number>();
  for (const a of ordered) {
    const addr = a.actor.toLowerCase();
    if (!addr || addr === "0x0000000000000000000000000000000000000000") continue;
    if (a.numeric1 != null && Number.isFinite(a.numeric1)) {
      const bal = Math.max(0, Math.floor(a.numeric1));
      if (bal <= 0) balances.delete(addr);
      else balances.set(addr, bal);
      continue;
    }
    // Fallback when numeric1 missing: ±1 from direction.
    const dir = (a.direction ?? "").toLowerCase();
    const prev = balances.get(addr) ?? 0;
    const next = dir === "out" ? prev - 1 : prev + 1;
    if (next <= 0) balances.delete(addr);
    else balances.set(addr, next);
  }
  return balances;
}

export function holdersFromBalanceMap(balances: Map<string, number>): OwnershipHolderRow[] {
  const rows: OwnershipHolderRow[] = [];
  for (const [address, balance] of balances) {
    if (balance > 0) rows.push({ address, balance });
  }
  return rows;
}
