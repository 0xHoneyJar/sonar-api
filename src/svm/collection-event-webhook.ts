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
import { upsertCollectionEvents } from "./collection-event-writer";
import { DasNftCollectionSource } from "./nft-collection-source";
import { PYTHIANS_COLLECTION, COLLECTION_KEY } from "./pythians-collection-indexer";

const PORT = Number(process.env.PORT ?? 8080);
const SECRET = process.env.HELIUS_WEBHOOK_SECRET ?? "";
const API_KEY = process.env.HELIUS_API_KEY ?? "";
const RPC = process.env.SOLANA_RPC_URL ?? (API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${API_KEY}` : "");
const MEMBER_REFRESH_MS = 15 * 60 * 1000; // re-pull the member set every 15 min (new mints, burns)

// Collection member set (the isMember filter). Refreshed periodically so the webhook tracks membership.
let members = new Set<string>();
let membersLoadedAt = 0;

async function refreshMembers(): Promise<void> {
  const snap = await new DasNftCollectionSource(RPC, PYTHIANS_COLLECTION).snapshot();
  members = new Set(snap.members.map((m) => m.nftMint));
  membersLoadedAt = Date.now();
  console.log(`[webhook] member set refreshed: ${members.size} ${COLLECTION_KEY} NFTs`);
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
    res.end(JSON.stringify({ ok: true, members: members.size, membersLoadedAt }));
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
      affected = await upsertCollectionEvents(events, COLLECTION_KEY, PYTHIANS_COLLECTION, "helius-webhook");
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
  await refreshMembers();
  http.createServer((req, res) => void handle(req, res)).listen(PORT, () => {
    console.log(`[webhook] svm-collection-event webhook listening on :${PORT} (${COLLECTION_KEY})`);
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
