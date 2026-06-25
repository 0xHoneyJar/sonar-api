/**
 * collection-event-webhook.ts — Sprint 3 realtime tail for the SVM collection-event pipe.
 *
 * A small HTTP service that receives Helius webhook POSTs (Enhanced parsed txs for the watched collection
 * mints), verifies the shared secret, decodes each tx with the SAME pure `parseHeliusTx` the backfill uses,
 * and upserts into svm.collection_event. Idempotent with the backfill via the content-addressed PK, so
 * replays / out-of-order deliveries are harmless. The §4.5 reconcile sweep (the backfill on a cron) remains
 * the correctness backstop (SDD §5).
 *
 * Deploy: a long-running Railway service (Dockerfile.svm-webhook). Env:
 *   PORT, HELIUS_WEBHOOK_SECRET, HELIUS_API_KEY (member refresh), SVM_HASURA_ENDPOINT,
 *   HASURA_GRAPHQL_ADMIN_SECRET.
 */
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { parseHeliusTx, type HeliusParsedTx } from "./collection-event-source";
import { upsertCollectionEvents, fetchMemberMintsFromDb } from "./collection-event-writer";
import { ensureKindConstraint } from "./ensure-kind-constraint";
import { DasNftCollectionSource } from "./nft-collection-source";
import { resolveCollection, DEFAULT_COLLECTION_KEY } from "./collection-registry";

const PORT = Number(process.env.PORT ?? 8080);
const SECRET = process.env.HELIUS_WEBHOOK_SECRET ?? "";
const API_KEY = process.env.HELIUS_API_KEY ?? "";
const RPC = process.env.SOLANA_RPC_URL ?? (API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${API_KEY}` : "");
const MEMBER_REFRESH_MS = 15 * 60 * 1000; // re-pull the member set every 15 min (new mints, burns)
const cfg = resolveCollection(process.env.COLLECTION || DEFAULT_COLLECTION_KEY); // generic: COLLECTION env selects the collection

// Collection member set (the isMember filter). Refreshed periodically so the webhook tracks membership.
let members = new Set<string>();
let membersLoadedAt = 0;
// Provenance of the live member set so a DEGRADED set is observable (MINOR-1): "das" = authoritative;
// "db-fallback" = Helius unavailable, serving the indexed-mints superset; "none" = never loaded.
let memberSource: "das" | "db-fallback" | "none" = "none";

/** Member-set state for /health + tests (FAGAN MAJOR-2/MINOR-1). */
export function memberState(): { size: number; loadedAt: number; source: typeof memberSource } {
  return { size: members.size, loadedAt: membersLoadedAt, source: memberSource };
}

/**
 * Refresh the member set. NEVER throws — a startup failure here used to propagate out of `main()` and
 * `process.exit(1)` the whole service into a Railway crash-loop (observed: a Helius 429 "max usage reached"
 * during member refresh took the realtime tail down entirely). Resolution order:
 *   1. DAS snapshot — authoritative, catches brand-new mints/burns.
 *   2. DB-derived fallback — the mints already in svm.collection_event (survives a Helius outage, incl.
 *      a monthly credit-quota exhaustion that won't recover for days; filters correctly for known members).
 *   3. Keep the existing (possibly empty) set + log loudly — last resort if both sources fail.
 */
export async function refreshMembers(): Promise<void> {
  try {
    const snap = await new DasNftCollectionSource(RPC, cfg.collectionMint).snapshot();
    members = new Set(snap.members.map((m) => m.nftMint));
    membersLoadedAt = Date.now();
    memberSource = "das";
    console.log(`[webhook] member set refreshed via DAS: ${members.size} ${cfg.collectionKey} NFTs`);
    return;
  } catch (dasErr) {
    console.error(`[webhook] DAS member refresh failed (${(dasErr as Error).message}) — falling back to DB-derived set`);
  }
  try {
    const mints = await fetchMemberMintsFromDb(cfg.collectionKey);
    if (mints.length > 0) {
      members = new Set(mints);
      membersLoadedAt = Date.now();
      memberSource = "db-fallback";
      console.warn(`[webhook] DEGRADED: member set loaded from DB fallback: ${members.size} ${cfg.collectionKey} NFTs (Helius unavailable — new-mint events may be missed until DAS recovers)`);
      return;
    }
    console.error(`[webhook] DB member fallback returned 0 rows — keeping existing set (${members.size}, source=${memberSource})`);
  } catch (dbErr) {
    console.error(`[webhook] DB member fallback failed (${(dbErr as Error).message}) — keeping existing set (${members.size}, source=${memberSource})`);
  }
}

let refreshInFlight: Promise<void> | null = null;
/**
 * De-duped, never-throws member refresh (FAGAN F4): concurrent stale POSTs share ONE in-flight refresh
 * (no thundering herd of DAS snapshots), and a transient DAS failure logs + serves the existing (stale)
 * member set rather than 500-ing every delivery — the cron backstops a stale miss.
 */
function ensureMembersFresh(): Promise<void> {
  if (Date.now() - membersLoadedAt <= MEMBER_REFRESH_MS) return Promise.resolve();
  if (!refreshInFlight) {
    refreshInFlight = refreshMembers()
      .catch((e) => console.error(`[webhook] member refresh failed, serving stale set: ${(e as Error).message}`))
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
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

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, members: members.size, membersLoadedAt, memberSource }));
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
    await ensureMembersFresh();
    const body = await readBody(req);
    const payload = JSON.parse(body);
    const events = decodeWebhookPayload(payload, (m) => members.has(m));
    let affected = 0;
    if (events.length > 0) {
      affected = await upsertCollectionEvents(events, cfg.collectionKey, cfg.collectionMint, "helius-webhook");
    }
    // MINOR-1: a degraded member set drops real members' events at 200 (Helius won't retry). Make it
    // visible — a "0 events" delivery against a DAS-authoritative set is healthy; against a degraded set
    // it could be a silently-dropped listing.
    if (memberSource !== "das") {
      console.warn(`[webhook] DEGRADED member set (source=${memberSource}, ${members.size} mints): decoded ${events.length} event(s) — non-member events for this delivery are dropped without Helius retry`);
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
  await refreshMembers();
  http.createServer((req, res) => void handle(req, res)).listen(PORT, () => {
    console.log(`[webhook] svm-collection-event webhook listening on :${PORT} (${cfg.collectionKey})`);
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
