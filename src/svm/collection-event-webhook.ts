/**
 * collection-event-webhook.ts — Sprint 3 realtime tail for the SVM collection-event pipe.
 *
 * A small HTTP service that receives Helius webhook POSTs (Enhanced parsed txs for the watched collection
 * mints), verifies the shared secret, decodes each tx with the SAME pure `parseHeliusTx` the backfill uses,
 * and upserts into svm.collection_event. Idempotent with the backfill via the content-addressed PK, so
 * replays / out-of-order deliveries are harmless. The §4.5 reconcile sweep (the backfill on a cron) remains
 * the correctness backstop (SDD §5).
 *
 * Multi-collection (SDD §2.5): ONE service watches every registry entry (`COLLECTIONS`), keeping a
 * per-collection member set and routing each decoded event to the collection whose set contains its mint
 * (sets are disjoint by construction — one mint belongs to one Metaplex collection). The `COLLECTION` env
 * var remains an optional single-tenant override (back-compat / deploy safety): when set, exactly today's
 * pre-§2.5 behavior with only that collection.
 *
 * Deploy: a long-running Railway service (Dockerfile.svm-webhook). Env:
 *   PORT, HELIUS_WEBHOOK_SECRET, HELIUS_API_KEY (member refresh), SVM_HASURA_ENDPOINT,
 *   HASURA_GRAPHQL_ADMIN_SECRET, [COLLECTION].
 */
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { parseHeliusTx, type HeliusParsedTx, type CollectionEvent } from "./collection-event-source";
import { upsertCollectionEvents, fetchMemberMintsFromDb } from "./collection-event-writer";
import { ensureKindConstraint } from "./ensure-kind-constraint";
import { DasNftCollectionSource } from "./nft-collection-source";
import { COLLECTIONS, resolveCollection, type CollectionConfig } from "./collection-registry";
import { writeSyncStatus } from "./sync-status";
import { installMeterExitLog, meterSummary } from "./helius-meter";

/**
 * FL SKP-003/SKP-001: member-set disjointness is an ASSUMPTION, not a guarantee (shared mints
 * across collections have historical precedent). Detection, not silent first-match: overlapping
 * mints are counted per collection pair, logged LOUDLY, and surfaced on /health. Routing stays
 * deterministic (registry order), but an overlap is never silent.
 */
export function auditMemberOverlap(sets: ReadonlyArray<{ key: string; members: ReadonlySet<string> }>): Record<string, number> {
  const overlaps: Record<string, number> = {};
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      let n = 0;
      for (const m of sets[i].members) if (sets[j].members.has(m)) n++;
      if (n > 0) {
        overlaps[`${sets[i].key}|${sets[j].key}`] = n;
        console.warn(`[webhook] MEMBER OVERLAP: ${n} mint(s) in BOTH ${sets[i].key} and ${sets[j].key} — routing by registry order; events for shared mints may be mis-attributed (FL SKP-003)`);
      }
    }
  }
  return overlaps;
}

const PORT = Number(process.env.PORT ?? 8080);
const SECRET = process.env.HELIUS_WEBHOOK_SECRET ?? "";
const API_KEY = process.env.HELIUS_API_KEY ?? "";
const RPC = process.env.SOLANA_RPC_URL ?? (API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${API_KEY}` : "");
const MEMBER_REFRESH_MS = 15 * 60 * 1000; // re-pull each member set every 15 min (new mints, burns)

/**
 * Per-collection member-set state (the isMember filter + its provenance). Provenance keeps a DEGRADED
 * set observable per collection (MINOR-1): "das" = authoritative; "db-fallback" = Helius unavailable,
 * serving the indexed-mints superset; "none" = never loaded.
 */
interface MemberSetState {
  readonly cfg: CollectionConfig;
  members: Set<string>;
  loadedAt: number;
  source: "das" | "db-fallback" | "none";
  refreshInFlight: Promise<void> | null; // per-collection dedupe (FAGAN F4) — see ensureMembersFresh
}

// COLLECTION env = optional single-tenant override (throws on an unknown key, fail-fast at boot — same
// as the pre-§2.5 behavior); unset = watch EVERY registry entry with one service.
const OVERRIDE = (process.env.COLLECTION ?? "").trim();
const watched: readonly CollectionConfig[] = OVERRIDE ? [resolveCollection(OVERRIDE)] : Object.values(COLLECTIONS);

/** Overlap counts without re-logging (for /health polls); refresh paths use the loud auditor. */
function auditQuiet(): Record<string, number> {
  const sets = [...collections.values()].map((st) => ({ key: st.cfg.collectionKey, members: st.members }));
  const overlaps: Record<string, number> = {};
  for (let i = 0; i < sets.length; i++)
    for (let j = i + 1; j < sets.length; j++) {
      let n = 0;
      for (const m of sets[i].members) if (sets[j].members.has(m)) n++;
      if (n > 0) overlaps[`${sets[i].key}|${sets[j].key}`] = n;
    }
  return overlaps;
}

const collections = new Map<string, MemberSetState>(
  watched.map((cfg) => [cfg.collectionKey, { cfg, members: new Set<string>(), loadedAt: 0, source: "none", refreshInFlight: null }]),
);

/** One collection's member-set state for /health + tests (FAGAN MAJOR-2/MINOR-1). Throws on an unwatched key. */
export function memberState(collectionKey: string): { size: number; loadedAt: number; source: MemberSetState["source"] } {
  const st = collections.get(collectionKey);
  if (!st) throw new Error(`memberState: unwatched collection '${collectionKey}' (watched: ${[...collections.keys()].join(", ")})`);
  return { size: st.members.size, loadedAt: st.loadedAt, source: st.source };
}

/**
 * Refresh ONE collection's member set. NEVER throws — a startup failure here used to propagate out of
 * `main()` and `process.exit(1)` the whole service into a Railway crash-loop (observed: a Helius 429
 * "max usage reached" during member refresh took the realtime tail down entirely). Resolution order,
 * PER COLLECTION (one collection's outage never degrades a sibling's set):
 *   1. DAS snapshot — authoritative, catches brand-new mints/burns.
 *   2. DB-derived fallback — the mints already in svm.collection_event (survives a Helius outage, incl.
 *      a monthly credit-quota exhaustion that won't recover for days; filters correctly for known members).
 *   3. Keep the existing (possibly empty) set + log loudly — last resort if both sources fail.
 */
export async function refreshMembers(collectionKey: string): Promise<void> {
  const st = collections.get(collectionKey);
  if (!st) {
    // unwatched key = caller bug, but the never-throws invariant holds — log, don't crash the tail
    console.error(`[webhook] refreshMembers: unwatched collection '${collectionKey}' — ignored (watched: ${[...collections.keys()].join(", ")})`);
    return;
  }
  try {
    const snap = await new DasNftCollectionSource(RPC, st.cfg.collectionMint).snapshot();
    st.members = new Set(snap.members.map((m) => m.nftMint));
    st.loadedAt = Date.now();
    auditMemberOverlap([...collections.values()].map((x) => ({ key: x.cfg.collectionKey, members: x.members })));
    st.source = "das";
    console.log(`[webhook] member set refreshed via DAS: ${st.members.size} ${st.cfg.collectionKey} NFTs`);
    return;
  } catch (dasErr) {
    console.error(`[webhook] DAS member refresh failed for ${st.cfg.collectionKey} (${(dasErr as Error).message}) — falling back to DB-derived set`);
  }
  try {
    const mints = await fetchMemberMintsFromDb(st.cfg.collectionKey);
    if (mints.length > 0) {
      st.members = new Set(mints);
      st.loadedAt = Date.now();
      st.source = "db-fallback";
      console.warn(`[webhook] DEGRADED: member set loaded from DB fallback: ${st.members.size} ${st.cfg.collectionKey} NFTs (Helius unavailable — new-mint events may be missed until DAS recovers)`);
      return;
    }
    console.error(`[webhook] DB member fallback returned 0 rows for ${st.cfg.collectionKey} — keeping existing set (${st.members.size}, source=${st.source})`);
  } catch (dbErr) {
    console.error(`[webhook] DB member fallback failed for ${st.cfg.collectionKey} (${(dbErr as Error).message}) — keeping existing set (${st.members.size}, source=${st.source})`);
  }
}

/**
 * De-duped, never-throws member refresh (FAGAN F4), PER COLLECTION: concurrent stale POSTs share ONE
 * in-flight refresh per key (no thundering herd of DAS snapshots), and a transient DAS failure logs +
 * serves the existing (stale) member set rather than 500-ing every delivery — the cron backstops a stale
 * miss. Staleness clocks are per-collection, so refreshes stagger naturally instead of stampeding.
 */
function ensureMembersFresh(st: MemberSetState): Promise<void> {
  if (Date.now() - st.loadedAt <= MEMBER_REFRESH_MS) return Promise.resolve();
  if (!st.refreshInFlight) {
    st.refreshInFlight = refreshMembers(st.cfg.collectionKey)
      .catch((e) => console.error(`[webhook] member refresh failed for ${st.cfg.collectionKey}, serving stale set: ${(e as Error).message}`))
      .finally(() => {
        st.refreshInFlight = null;
      });
  }
  return st.refreshInFlight;
}

/** The collection whose member set contains this mint (sets are disjoint by construction — SDD §2.5). */
function collectionFor(mint: string): MemberSetState | undefined {
  for (const st of collections.values()) if (st.members.has(mint)) return st;
  return undefined;
}

/** Constant-time bearer-secret compare with a length guard (FAGAN F5). */
function secretMatches(header: string | undefined): boolean {
  if (!SECRET || typeof header !== "string") return false;
  const a = new TextEncoder().encode(header);
  const b = new TextEncoder().encode(SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let aborted = false;
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      if (aborted) return;
      body += c;
      if (body.length > 10_000_000) {
        // Reject AND tear the stream down — otherwise the closure keeps buffering to EOF (FAGAN F2).
        aborted = true;
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!aborted) resolve(body);
    });
    req.on("error", reject);
  });
}

/** Decode a Helius webhook payload (array of parsed txs) into collection events. Exported for tests. */
export function decodeWebhookPayload(payload: unknown, isMember: (m: string) => boolean): ReturnType<typeof parseHeliusTx> {
  if (!Array.isArray(payload)) {
    // A misconfigured webhook (raw, not Enhanced) decodes to nothing — warn so the gap is visible (FAGAN F6).
    console.warn("[webhook] non-array payload — decoded 0 events (misconfigured webhook? expected an Enhanced tx array)");
    return [];
  }
  return (payload as HeliusParsedTx[]).flatMap((tx) => parseHeliusTx(tx, isMember));
}

/** HTTP handler. Exported for tests (routing + /health shape are pinned without binding a port). */
export async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    // Per-collection blocks (SDD §2.5) — one glance shows WHICH collection is degraded, not just "something is".
    const perCollection = Object.fromEntries(
      [...collections.values()].map((st) => [st.cfg.collectionKey, { members: st.members.size, loadedAt: st.loadedAt, source: st.source }]),
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    const member_overlaps = auditQuiet(); // FL SKP-003: surfaced, never silent
    res.end(JSON.stringify({ ok: true, collections: perCollection, member_overlaps, helius_meter: meterSummary() }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end("method not allowed");
    return;
  }
  // Helius sends the configured authHeader value in `Authorization` (constant-time compare).
  if (!secretMatches(req.headers.authorization)) {
    res.writeHead(401).end("unauthorized");
    return;
  }
  try {
    await Promise.all([...collections.values()].map((st) => ensureMembersFresh(st)));
    const body = await readBody(req);
    const payload = JSON.parse(body);
    // isMember = union across watched collections; routing then picks the (unique) owning collection.
    const events = decodeWebhookPayload(payload, (m) => collectionFor(m) !== undefined);
    // Route each event to the collection whose member set contains its mint, and upsert per collection
    // with THAT collection's key/mint (SDD §2.5).
    const byKey = new Map<string, CollectionEvent[]>();
    for (const ev of events) {
      const st = collectionFor(ev.nftMint);
      if (!st) continue; // unreachable (isMember gated the decode) — belt for a mid-flight set swap
      const bucket = byKey.get(st.cfg.collectionKey);
      if (bucket) bucket.push(ev);
      else byKey.set(st.cfg.collectionKey, [ev]);
    }
    let affected = 0;
    for (const [key, evs] of byKey) {
      const st = collections.get(key)!;
      affected += await upsertCollectionEvents(evs, st.cfg.collectionKey, st.cfg.collectionMint, "helius-webhook");
      // Freshness stamp (FR-5) — fail-soft by contract; a status write must never 500 a delivery.
      void writeSyncStatus({
        collectionKey: st.cfg.collectionKey,
        lastEventAt: new Date(Math.max(...evs.map((e) => e.blockTime)) * 1000).toISOString(),
        lastEventSource: "helius-webhook",
      });
    }
    // MINOR-1: a degraded member set drops real members' events at 200 (Helius won't retry). Make it
    // visible PER COLLECTION — a "0 events" delivery against a DAS-authoritative set is healthy; against
    // a degraded set it could be a silently-dropped listing.
    for (const st of collections.values()) {
      if (st.source !== "das") {
        console.warn(`[webhook] DEGRADED member set for ${st.cfg.collectionKey} (source=${st.source}, ${st.members.size} mints): decoded ${events.length} event(s) — non-member events for this delivery are dropped without Helius retry`);
      }
    }
    console.log(`[webhook] decoded ${events.length} event(s), upserted ${affected}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, events: events.length, upserted: affected }));
  } catch (e) {
    console.error(`[webhook] error: ${(e as Error).message}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
  }
}

async function main(): Promise<void> {
  installMeterExitLog("webhook"); // summary on shutdown/restart; live counts via /health helius_meter
  if (!SECRET) throw new Error("HELIUS_WEBHOOK_SECRET required");
  if (!API_KEY && !RPC) throw new Error("HELIUS_API_KEY or SOLANA_RPC_URL required");
  if (!process.env.SVM_HASURA_ENDPOINT) throw new Error("SVM_HASURA_ENDPOINT required");
  if (!process.env.HASURA_GRAPHQL_ADMIN_SECRET) throw new Error("HASURA_GRAPHQL_ADMIN_SECRET required");
  // #85: widen the kind CHECK before accepting any delivery — so a real-time list/delist write can never
  // trip an un-widened constraint (which would 500 the delivery → Helius retry-storm). Safe-by-construction.
  // MAJOR-1: do NOT let a transient Hasura blip here crash-loop the service (the same failure class the
  // refreshMembers hardening targets). The widen is idempotent DDL and is already applied in prod, so a
  // verify failure on restart is non-fatal — reach .listen() degraded; the per-delivery upsert still
  // surfaces a real constraint trip as a 500 (→ Helius retry), the correct backpressure.
  try {
    await ensureKindConstraint({ log: (m) => console.log(`[webhook] ${m}`) });
  } catch (e) {
    console.error(`[webhook] kind-constraint verify failed at startup, continuing degraded: ${(e as Error).message}`);
  }
  await Promise.all([...collections.keys()].map((k) => refreshMembers(k)));
  http.createServer((req, res) => void handle(req, res)).listen(PORT, () => {
    console.log(`[webhook] svm-collection-event webhook listening on :${PORT} (${[...collections.keys()].join(", ")})`);
  });
}

// run only when invoked directly (so decodeWebhookPayload stays importable/testable)
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
