/**
 * Production Node DNS + pinned HTTP(S) transport for metadata egress.
 *
 * Connects to the validated public address while presenting the original
 * hostname via Host / SNI. TLS verification stays enabled. Never re-resolves
 * after the address is pinned for a hop.
 */

import * as dns from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import type { DnsAnswer, DnsPort, PinnedTransportPort } from "./ports.js";
import type { TransportRequest, TransportResponse } from "./types.js";

export const createNodeDnsPort = (): DnsPort => ({
  lookup: async (hostname: string): Promise<ReadonlyArray<DnsAnswer>> => {
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    return results.map((entry) => ({
      address: entry.address,
      family: entry.family === 6 ? "ipv6" : "ipv4",
    }));
  },
});

export const createNodePinnedTransport = (): PinnedTransportPort => ({
  exchange: (request: TransportRequest): Promise<TransportResponse> =>
    new Promise((resolve, reject) => {
      const isHttps = request.target.scheme === "https";
      const lib = isHttps ? https : http;
      const headers: Record<string, string> = {
        Accept: request.headers.accept,
        "User-Agent": request.headers["user-agent"],
        Host: request.headers.host,
      };
      if (request.headers["accept-encoding"] !== undefined) {
        headers["Accept-Encoding"] = request.headers["accept-encoding"];
      }

      let settled = false;
      let headersReceived = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(headerTimer);
        reject(error);
      };

      const connectTimer = setTimeout(() => {
        fail(new Error("connect timeout"));
        req.destroy();
      }, request.connect_timeout_ms);

      const headerTimer = setTimeout(() => {
        if (!headersReceived) {
          fail(new Error("header timeout"));
          req.destroy();
        }
      }, request.header_timeout_ms);

      const req = lib.request(
        {
          host: request.target.pinned_address,
          port: request.target.port,
          path: `${request.target.url.pathname}${request.target.url.search}`,
          method: request.method,
          headers,
          // SNI is the original hostname (never the pinned address, never
          // bracketed). TLS verification stays enabled.
          servername: isHttps ? request.target.hostname : undefined,
          setHost: false,
          // Socket inactivity is a backstop; phase timers above are authoritative.
          timeout: Math.max(
            request.connect_timeout_ms,
            request.header_timeout_ms,
            request.body_timeout_ms,
          ),
          rejectUnauthorized: isHttps ? true : undefined,
        },
        (res) => {
          headersReceived = true;
          clearTimeout(connectTimer);
          clearTimeout(headerTimer);

          const chunks: Uint8Array[] = [];
          let total = 0;

          const bodyTimer = setTimeout(() => {
            fail(new Error("body timeout"));
            req.destroy();
          }, request.body_timeout_ms);

          res.on("data", (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > request.max_compressed_bytes) {
              clearTimeout(bodyTimer);
              fail(new Error("compressed size exceeded"));
              req.destroy();
              return;
            }
            chunks.push(new Uint8Array(chunk));
          });

          res.on("end", () => {
            if (settled) return;
            settled = true;
            clearTimeout(bodyTimer);
            const headerMap: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              if (typeof value === "string") headerMap[key] = value;
              else if (Array.isArray(value)) headerMap[key] = value.join(", ");
            }
            const merged = new Uint8Array(total);
            let offset = 0;
            for (const part of chunks) {
              merged.set(part, offset);
              offset += part.byteLength;
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: headerMap,
              body: merged,
            });
          });

          res.on("error", (error) => {
            clearTimeout(bodyTimer);
            fail(error instanceof Error ? error : new Error(String(error)));
          });
        },
      );

      req.on("socket", (socket) => {
        socket.once("connect", () => {
          clearTimeout(connectTimer);
        });
      });

      req.on("timeout", () => {
        fail(new Error(headersReceived ? "body timeout" : "connect timeout"));
        req.destroy();
      });
      req.on("error", (error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
      req.end();
    }),
});
