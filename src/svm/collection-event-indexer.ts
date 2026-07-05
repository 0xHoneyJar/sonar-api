/**
 * collection-event-indexer.ts — Sprint 2 backfill runner for the generic SVM collection-event pipe.
 *
 * Enumerates a collection's member NFTs (DAS), walks NFT parsed tx history (Helius Enhanced
 * address-history) into mint/transfer/burn/sale events, and upserts them into svm.collection_event. Then
 * RECONCILES (§4.5 go/no-go gate): derives latest-owner-per-NFT from the event stream and compares to the
 * DAS current-ownership snapshot — proving the event history is complete before "full history" is claimed.
 *
 * INCREMENTAL by default (cycle svm-warehouse-loader T-6 / SDD §2.6): DAS snapshot → derive current owner
 * per mint from the events we ALREADY hold in Hasura → walk ONLY the mints whose derived owner disagrees
 * with the snapshot (or that the event stream has never seen). Flags:
 *   --full        preserve the original every-member full-history walk verbatim
 *   --verify-off  Helius/DAS is dark — skip the snapshot entirely and record 'skipped-no-das'
 *
 * Run (dry, no writes — validate + reconcile; incremental still READS Hasura for derived owners):
 *   HELIUS_API_KEY=<key> npx tsx src/svm/collection-event-indexer.ts --dry [--limit N] [--full]
 * Run (backfill into Hasura):
 *   HELIUS_API_KEY=<key> HASURA_GRAPHQL_ADMIN_SECRET=<secret> \
 *   SVM_HASURA_ENDPOINT=https://belt-hasura-selfhost-production.up.railway.app \
 *   npx tsx src/svm/collection-event-indexer.ts
 */
import { fileURLToPath } from "node:url";
import { DasNftCollectionSource, type CollectionSnapshot } from "./nft-collection-source";
import { HeliusCollectionEventSource, type CollectionEvent } from "./collection-event-source";
import { upsertCollectionEvents } from "./collection-event-writer";
import { ensureKindConstraint } from "./ensure-kind-constraint";
import { installMeterExitLog } from "./helius-meter";
import { resolveCollection, DEFAULT_COLLECTION_KEY } from "./collection-registry";

const API_KEY = process.env.HELIUS_API_KEY ?? "";
const RPC = process.env.SOLANA_RPC_URL ?? (API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${API_KEY}` : "");

const RECONCILE_MIN_PCT = 99; // §4.5 go/no-go gate: refuse to write a likely-incomplete history below this

function parseArgs(): ReconcileOpts {
  const dry = process.argv.includes("--dry");
  const force = process.argv.includes("--force");
  const full = process.argv.includes("--full");
  const verifyOff = process.argv.includes("--verify-off");
  if (full && verifyOff) {
    throw new Error("--full and --verify-off are mutually exclusive (--verify-off skips the snapshot a full walk needs)");
  }
  const ci = process.argv.indexOf("--collection");
  const collection = ci >= 0 ? (process.argv[ci + 1] ?? "") : (process.env.COLLECTION || DEFAULT_COLLECTION_KEY);
  const li = process.argv.indexOf("--limit");
  let limit: number | undefined;
  if (li >= 0) {
    // Reject a missing/non-numeric value rather than silently treating it as "no limit" → full backfill (FAGAN F3).
    limit = Number(process.argv[li + 1]);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`--limit requires a positive integer (got '${process.argv[li + 1] ?? ""}')`);
    }
  }
  return { dry, limit, force, collection, full, verifyOff };
}

/**
 * The fields the latest-owner fold reads — a full CollectionEvent satisfies it, and so does a
 * svm.collection_event row pulled back from Hasura (the incremental derived-owner path).
 */
export type OwnershipEvent = Pick<CollectionEvent, "nftMint" | "kind" | "to" | "slot" | "instructionIndex" | "txSignature">;

/**
 * Latest-owner-per-mint from the event stream (chronological by slot then per-mint leg). `null` =
 * burned / no current owner. Exported for tests + the reconciliation gate.
 */
export function deriveLatestOwners(events: readonly OwnershipEvent[]): Map<string, string | null> {
  // Events arrive strictly NEWEST-FIRST per mint (Helius address-history order, preserved by the runner).
  // (slot, instructionIndex) is NOT a total order — instructionIndex is a per-tx-per-mint ordinal, so two
  // events from DIFFERENT txns in the SAME slot tie, and a (sort + last-write) fold would pick the OLDER
  // tx (FAGAN F1). Resolve explicitly: higher slot wins; same slot → first-seen (= newest tx, by stream
  // order) wins; same tx → higher leg index wins (mint-then-transfer in one tx).
  const latest = new Map<string, OwnershipEvent>();
  for (const e of events) {
    const cur = latest.get(e.nftMint);
    if (
      !cur ||
      e.slot > cur.slot ||
      (e.slot === cur.slot && e.txSignature === cur.txSignature && e.instructionIndex > cur.instructionIndex)
    ) {
      latest.set(e.nftMint, e);
    }
  }
  const owner = new Map<string, string | null>();
  for (const [mint, e] of latest) owner.set(mint, e.kind === "burn" ? null : e.to);
  return owner;
}

/**
 * The incremental mint-selection rule (SDD §2.6), pure for unit tests: a snapshot member DRIFTS when the
 * event-stream-derived owner disagrees with the DAS owner, or the derived set has never seen the mint
 * (no indexed events yet). Only drifted mints get an Enhanced walk in incremental mode.
 */
export function selectDriftedMints(
  snapshotMembers: readonly { nftMint: string; owner: string }[],
  derivedOwners: ReadonlyMap<string, string>,
): string[] {
  const drifted: string[] = [];
  for (const m of snapshotMembers) {
    const derived = derivedOwners.get(m.nftMint);
    if (derived === undefined || derived !== m.owner) drifted.push(m.nftMint);
  }
  return drifted;
}

// ── Hasura read path (incremental derived owners) ───────────────────────────

// Mirrors the writer's private hasura() helper (collection-event-writer.ts — not exported; that file is
// owned by parallel work this sprint). Env read at call time so injected-deps tests never touch it.
async function hasura<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const endpoint = (process.env.SVM_HASURA_ENDPOINT ?? "").replace(/\/$/, "");
  const res = await fetch(`${endpoint}/v1/graphql`, {
    method: "POST",
    headers: { "x-hasura-admin-secret": process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`hasura: HTTP ${res.status} ${body.slice(0, 200)}`); // surface 401/5xx clearly
  }
  const d = (await res.json()) as { data?: T; errors?: unknown };
  if (d.errors) throw new Error(`hasura: ${JSON.stringify(d.errors)}`);
  return d.data as T;
}

const DERIVED_PAGE = 5000;

// Latest event per mint via distinct_on — deliberately across ALL kinds (custody semantics), NOT the
// 001_collection_owner_derived beneficial-owner view: DAS reports the marketplace ESCROW as owner for a
// listed NFT, so folding list/delist exactly like deriveLatestOwners does keeps derived == DAS for listed
// NFTs instead of flagging every listing as drift each run. Same fold, same answer, no false walks.
const DERIVED_QUERY = `query DerivedOwners($ck: String!, $limit: Int!, $offset: Int!) {
  svm_collection_event(
    where: { collection_key: { _eq: $ck } }
    distinct_on: nft_mint
    order_by: [{ nft_mint: asc }, { slot: desc }, { instruction_index: desc }]
    limit: $limit
    offset: $offset
  ) { nft_mint kind to slot instruction_index tx_signature }
}`;

interface DerivedRow {
  nft_mint: string;
  kind: string;
  to: string | null;
  slot: number;
  instruction_index: number;
  tx_signature: string;
}

/**
 * Current owner per mint from the events we ALREADY hold in svm.collection_event (the §4.5 fold applied
 * to Hasura rows). distinct_on returns one latest row per mint; the rows still run through
 * deriveLatestOwners so ONE function owns the burn→no-owner rule. Burned mints (owner null) are dropped —
 * a burnt mint never appears in the DAS snapshot anyway.
 */
export async function fetchDerivedOwnersFromHasura(collectionKey: string): Promise<Map<string, string>> {
  const rows: DerivedRow[] = [];
  for (let offset = 0; ; offset += DERIVED_PAGE) {
    const d = await hasura<{ svm_collection_event: DerivedRow[] }>(DERIVED_QUERY, {
      ck: collectionKey,
      limit: DERIVED_PAGE,
      offset,
    });
    rows.push(...d.svm_collection_event);
    if (d.svm_collection_event.length < DERIVED_PAGE) break;
  }
  const latest = deriveLatestOwners(
    rows.map((r) => ({
      nftMint: r.nft_mint,
      kind: r.kind as CollectionEvent["kind"],
      to: r.to,
      slot: r.slot,
      instructionIndex: r.instruction_index,
      txSignature: r.tx_signature,
    })),
  );
  const owners = new Map<string, string>();
  for (const [mint, owner] of latest) if (owner !== null) owners.set(mint, owner);
  return owners;
}

// ── the reconcile flow (dependency-injected — unit-testable without network) ─

/**
 * T-4 (a parallel task) owns src/svm/sync-status.ts and its writeSyncStatus export. The writer is
 * injected as an OPTIONAL dependency (`deps.writeSyncStatus?.(…)`) so this flow — and its tests — run
 * without the module; main() resolves the real module at runtime (loadSyncStatusWriter).
 */
export type SyncStatusWriter = (update: {
  collectionKey: string;
  lastReconcileAt: string; // ISO timestamptz
  lastReconcileResult: "passed" | "failed" | "skipped-no-das"; // T-4's ReconcileResult values
}) => Promise<unknown>;

export interface ReconcileOpts {
  dry: boolean;
  limit?: number;
  force: boolean;
  collection: string;
  full: boolean; // preserve the original every-member walk
  verifyOff: boolean; // Helius dark — skip the DAS snapshot, record 'skipped-no-das'
}

export interface ReconcileDeps {
  snapshot: () => Promise<CollectionSnapshot>;
  events: Pick<HeliusCollectionEventSource, "mintHistory">;
  fetchDerivedOwners: (collectionKey: string) => Promise<Map<string, string>>;
  upsert: typeof upsertCollectionEvents;
  writeSyncStatus?: SyncStatusWriter; // optional — no-op when T-4's module isn't wired yet
  log?: (msg: string) => void;
}

/** The reconcile run, minus CLI/env concerns (main() is the thin wrapper). Exported for tests. */
export async function runReconcile(opts: ReconcileOpts, deps: ReconcileDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const cfg = resolveCollection(opts.collection); // generic: any registered SVM collection (SDD §4.4 / Sprint 4)

  if (opts.verifyOff) {
    // Helius/DAS is dark: nothing to verify against, so no walk and no event writes either — but the
    // skip is RECORDED, not silent (NFR-2), via the sync-status writer when available.
    log(`${cfg.collectionKey}: --verify-off — DAS snapshot skipped; recording 'skipped-no-das'`);
    await deps.writeSyncStatus?.({
      collectionKey: cfg.collectionKey,
      lastReconcileAt: new Date().toISOString(),
      lastReconcileResult: "skipped-no-das",
    });
    return;
  }

  const snap = await deps.snapshot();
  let members = snap.members;
  if (opts.limit && opts.limit > 0) members = members.slice(0, opts.limit);
  log(`${cfg.collectionKey}: ${members.length} member NFTs in snapshot (slot ${snap.slot})${opts.dry ? " [DRY]" : ""}`);

  // Mint selection: INCREMENTAL by default (walk only drifted mints); --full is the original
  // every-member walk verbatim.
  let toWalk: string[];
  if (opts.full) {
    toWalk = members.map((m) => m.nftMint);
    log(`FULL: walking all ${toWalk.length} member NFTs (--full)`);
  } else {
    const derived = await deps.fetchDerivedOwners(cfg.collectionKey);
    // FL SKP-002: with no (or barely any) indexed events, EVERY mint reads as "drifted" and the
    // incremental path silently degenerates into the full Enhanced walk it exists to prevent — the
    // exact cost bomb this cycle removes, sneaking back through an empty derived set. Refuse and
    // route to the cheap lane instead: warehouse-load first, or an EXPLICIT --full.
    const coverage = members.length === 0 ? 1 : derived.size / members.length;
    if (coverage < 0.5) {
      throw new Error(
        `incremental reconcile refused: derived-owner coverage ${(coverage * 100).toFixed(0)}% (<50%) — this collection has few/no indexed events, so "incremental" would walk ~everything at 100cr/mint. Load history first (warehouse-loader --collection ${cfg.collectionKey}), or pass --full to walk deliberately (FL SKP-002)`,
      );
    }
    toWalk = selectDriftedMints(members, derived);
    log(
      `INCREMENTAL: ${toWalk.length}/${members.length} mint(s) drifted (derived owner vs DAS) — walking only those (--full for a full walk)`,
    );
  }

  const events: CollectionEvent[] = [];
  let done = 0;
  for (const mint of toWalk) {
    for await (const ev of deps.events.mintHistory(mint)) events.push(ev);
    if (++done % 250 === 0) log(`  …${done}/${toWalk.length} NFTs walked, ${events.length} events so far`);
  }
  log(`collected ${events.length} events across ${toWalk.length} walked NFTs`);

  // Reconciliation gate (§4.5): latest-owner-from-events vs the DAS current owner, pct over ALL snapshot
  // members. A member NOT walked (incremental only) already matched its derived owner — a match by
  // construction. In --full mode every member is walked, so this is exactly the original comparison.
  const walked = new Set(toWalk);
  const latest = deriveLatestOwners(events);
  let match = 0;
  const mismatches: string[] = [];
  for (const m of members) {
    if (!walked.has(m.nftMint) || latest.get(m.nftMint) === m.owner) match++;
    else mismatches.push(m.nftMint);
  }
  const pct = members.length ? (match / members.length) * 100 : 0;
  log(`RECONCILE: ${match}/${members.length} (${pct.toFixed(2)}%) latest-owner-from-events == DAS owner`);
  if (mismatches.length) log(`  ${mismatches.length} mismatch(es); first 5: ${mismatches.slice(0, 5).join(", ")}`);

  if (opts.dry) {
    log("DRY — no writes performed.");
    return;
  }

  // Record the reconcile outcome BEFORE the gate can throw (SDD §2.3: a failed gate marks
  // last_reconcile_result: failed — verification is a status, it never hides).
  await deps.writeSyncStatus?.({
    collectionKey: cfg.collectionKey,
    lastReconcileAt: new Date().toISOString(),
    lastReconcileResult: pct >= RECONCILE_MIN_PCT ? "passed" : "failed",
  });

  // §4.5 reconciliation gate — refuse to surface a likely-incomplete history (unless explicitly forced).
  if (pct < RECONCILE_MIN_PCT && !opts.force) {
    throw new Error(
      `reconciliation ${pct.toFixed(2)}% < ${RECONCILE_MIN_PCT}% gate — refusing to write a likely-incomplete history. ` +
        `Investigate the mismatches (escrow/finality vs a real coverage gap) or re-run with --force.`,
    );
  }
  const affected = await deps.upsert(events, cfg.collectionKey, cfg.collectionMint, "helius-backfill");
  log(`✅ DONE — upserted ${affected} event rows into svm.collection_event for ${cfg.collectionKey}`);
}

// ── CLI wrapper ──────────────────────────────────────────────────────────────

/**
 * Resolve T-4's sync-status writer at RUNTIME and tolerate its absence, so this file typechecks and runs
 * in a worktree where sync-status.ts hasn't landed — the write degrades to a DECLARED no-op. The
 * specifier is a non-literal so tsc doesn't require the module to exist yet (T-4 owns creating it).
 */
async function loadSyncStatusWriter(): Promise<SyncStatusWriter | undefined> {
  try {
    const specifier: string = "./sync-status";
    const mod = (await import(specifier)) as { writeSyncStatus?: SyncStatusWriter };
    if (typeof mod.writeSyncStatus === "function") return mod.writeSyncStatus;
  } catch {
    /* module not present yet — fall through to the declared no-op */
  }
  console.log("  (sync-status writer unavailable — reconcile result will not be recorded)");
  return undefined;
}

async function main(): Promise<void> {
  installMeterExitLog("reconcile-cron"); // KF-018/#122: credit-burn ledger line, crash paths included
  const opts = parseArgs();
  const cfg = resolveCollection(opts.collection); // fail fast on an unknown key
  if (!opts.verifyOff) {
    if (!API_KEY) throw new Error("HELIUS_API_KEY required");
    if (!RPC) throw new Error("SOLANA_RPC_URL or HELIUS_API_KEY required");
    // Incremental derives owners FROM Hasura, so it needs the read path even under --dry (the original
    // env-free dry run is preserved behind --full).
    if (!opts.full && (!process.env.SVM_HASURA_ENDPOINT || !process.env.HASURA_GRAPHQL_ADMIN_SECRET)) {
      throw new Error(
        "incremental reconcile reads derived owners from Hasura — set SVM_HASURA_ENDPOINT + HASURA_GRAPHQL_ADMIN_SECRET, or pass --full for the snapshot-only walk",
      );
    }
    if (!opts.dry) {
      if (!process.env.HASURA_GRAPHQL_ADMIN_SECRET) throw new Error("HASURA_GRAPHQL_ADMIN_SECRET required (or pass --dry)");
      if (!process.env.SVM_HASURA_ENDPOINT) throw new Error("SVM_HASURA_ENDPOINT required (or pass --dry)");
      // #85: widen the kind CHECK to permit list/delist BEFORE any write — makes the marketplace-kinds
      // cutover safe-by-construction (the upsert can never trip an un-widened constraint). Idempotent.
      const { widened } = await ensureKindConstraint({ log: (m) => console.log(m) });
      if (widened) console.log("  (kind CHECK widened this run)");
    }
  }

  // SVM_BACKFILL_PACE_MS overrides the default inter-request spacing — back off further when the live
  // webhook shares the Helius key (combined rate otherwise trips the ~10 RPS free-tier 429). Default-on.
  // Validate loudly like --limit above (FAGAN F3 / MINOR-2): the only intent is to INCREASE pacing, so a
  // negative / NaN value is operator error — reject it rather than silently disabling pacing or falling
  // back to the default. Unset → undefined (use DEFAULT_PACE_MS).
  let paceMs: number | undefined;
  if (process.env.SVM_BACKFILL_PACE_MS !== undefined && process.env.SVM_BACKFILL_PACE_MS !== "") {
    paceMs = Number(process.env.SVM_BACKFILL_PACE_MS);
    if (!Number.isFinite(paceMs) || paceMs < 0) {
      throw new Error(`SVM_BACKFILL_PACE_MS must be a non-negative number (got '${process.env.SVM_BACKFILL_PACE_MS}')`);
    }
  }

  await runReconcile(opts, {
    snapshot: () => new DasNftCollectionSource(RPC, cfg.collectionMint).snapshot(),
    events: new HeliusCollectionEventSource(API_KEY, cfg.collectionMint, { rpcUrl: RPC, paceMs }),
    fetchDerivedOwners: fetchDerivedOwnersFromHasura,
    upsert: upsertCollectionEvents,
    writeSyncStatus: await loadSyncStatusWriter(),
  });
}

// run only when invoked directly (so the exported functions stay importable/testable)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
