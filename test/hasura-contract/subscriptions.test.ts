// test/hasura-contract/subscriptions.test.ts
//
// T-A3.7 — 3 subscription smoke tests.
//
// Per SDD §8.4 + COOKBOOK §C-6 (subscription continuity deferred to A-3).
// Uses Node 22+'s native WebSocket (no extra dep). Speaks Hasura's
// graphql-ws sub-protocol (https://github.com/enisdenjo/graphql-ws).
//
// Each test:
//   1. Opens a WS to <HASURA_URL>/v1/graphql with subprotocol "graphql-ws"
//   2. Sends connection_init
//   3. Sends `subscribe` for an entity query
//   4. Expects at least one `next` message within timeout
//
// Timeout default: 30s (per sprint AC). Operator can shorten via env if
// staging traffic is high.
//
// LIMITATION: this is a smoke test — it verifies the subscription channel
// stays open and Hasura delivers initial data. End-to-end "insert triggers
// subscription emit" is exercised by the consumer-reconnect drill
// (scripts/consumer-reconnect-drill.sh, T-A3.11).

import { describe, it, expect } from "vitest";

const HASURA_URL = process.env.HASURA_URL;
const HASURA_ADMIN_SECRET = process.env.HASURA_ADMIN_SECRET;
const SUBSCRIPTION_TIMEOUT_MS = Number(process.env.SUBSCRIPTION_TIMEOUT_MS ?? "30000");

function wsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, "ws") + "/v1/graphql";
}

interface SubscriptionResult {
  received: boolean;
  payload: unknown;
  error: string | null;
  durationMs: number;
}

async function smokeSubscribe(query: string, timeoutMs: number): Promise<SubscriptionResult> {
  if (!HASURA_URL) throw new Error("HASURA_URL not set");
  return new Promise<SubscriptionResult>((resolve) => {
    const start = Date.now();
    const headers: Record<string, string> = {};
    if (HASURA_ADMIN_SECRET) headers["x-hasura-admin-secret"] = HASURA_ADMIN_SECRET;

    // Native Node 22+ WebSocket — passes initial headers via connection_init payload.
    const ws = new WebSocket(wsUrl(HASURA_URL), ["graphql-ws"]);
    let settled = false;
    const settle = (r: SubscriptionResult) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* noop */ }
      resolve(r);
    };

    const timeout = setTimeout(() => {
      settle({ received: false, payload: null, error: `timeout after ${timeoutMs}ms`, durationMs: Date.now() - start });
    }, timeoutMs);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        type: "connection_init",
        payload: HASURA_ADMIN_SECRET ? { headers: { "x-hasura-admin-secret": HASURA_ADMIN_SECRET } } : {},
      }));
    });

    ws.addEventListener("error", (e) => {
      clearTimeout(timeout);
      settle({ received: false, payload: null, error: `ws error: ${String((e as Event & { message?: string }).message ?? e)}`, durationMs: Date.now() - start });
    });

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
        if (msg.type === "connection_ack") {
          ws.send(JSON.stringify({ id: "smoke-1", type: "start", payload: { query } }));
        } else if (msg.type === "data" || msg.type === "next") {
          // graphql-ws v1: type="data"; graphql-transport-ws (newer): type="next".
          clearTimeout(timeout);
          settle({ received: true, payload: msg.payload, error: null, durationMs: Date.now() - start });
        } else if (msg.type === "error" || msg.type === "connection_error") {
          clearTimeout(timeout);
          settle({ received: false, payload: msg.payload, error: `subscription error: ${JSON.stringify(msg.payload)}`, durationMs: Date.now() - start });
        }
      } catch (err) {
        clearTimeout(timeout);
        settle({ received: false, payload: null, error: `parse error: ${String(err)}`, durationMs: Date.now() - start });
      }
    });
  });
}

describe.skipIf(!HASURA_URL)("Hasura subscriptions (T-A3.7)", () => {
  it("MintEvent subscription receives initial data within timeout", async () => {
    const query = `subscription { MintEvent(limit: 1, order_by: { timestamp: desc }) { id collectionKey tokenId } }`;
    const result = await smokeSubscribe(query, SUBSCRIPTION_TIMEOUT_MS);
    expect(result.error, `subscription error: ${result.error}`).toBeNull();
    expect(result.received, `no data within ${SUBSCRIPTION_TIMEOUT_MS}ms`).toBe(true);
  }, SUBSCRIPTION_TIMEOUT_MS + 5000);

  it("MiberaTransfer subscription receives initial data within timeout", async () => {
    const query = `subscription { MiberaTransfer(limit: 1, order_by: { timestamp: desc }) { id from to tokenId } }`;
    const result = await smokeSubscribe(query, SUBSCRIPTION_TIMEOUT_MS);
    expect(result.error).toBeNull();
    expect(result.received).toBe(true);
  }, SUBSCRIPTION_TIMEOUT_MS + 5000);

  it("BgtBoostEvent subscription receives initial data within timeout", async () => {
    const query = `subscription { BgtBoostEvent(limit: 1, order_by: { timestamp: desc }) { id account amount } }`;
    const result = await smokeSubscribe(query, SUBSCRIPTION_TIMEOUT_MS);
    expect(result.error).toBeNull();
    expect(result.received).toBe(true);
  }, SUBSCRIPTION_TIMEOUT_MS + 5000);
});
