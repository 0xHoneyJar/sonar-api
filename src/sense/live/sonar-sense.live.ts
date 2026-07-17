/**
 * sonar-sense.live.ts — the live runtime (the ONLY place chain config lives).
 *
 * A THIN viem reader (viem-only). It deliberately MIRRORS loa-freeside's
 * `native-reader.ts` viem pattern (createPublicClient + fallback over rpcUrls,
 * inlined ERC20/721 ABIs, readContract, getAddress normalisation) rather than
 * importing `@freeside/adapters` — which has no installable artifact and would
 * drag `@freeside/core`. The clean SonarSense port makes the V2 promotion of
 * this reader into a shared loa-freeside `chain-read` building a move, not a
 * rewrite (D1=extract, executed as B: thin-now / extract-when-Score-binds).
 *
 * Chain config seam (D2): defaults to the public Berachain upstreams from
 * `erpc.yaml`; set `ERPC_URL` (or pass `opts.erpcUrl`) to route every chain
 * through a cluster-consumable eRPC ingress (`${ERPC_URL}/main/evm/${chainId}`).
 *
 * GROUNDING (spec §5): a default read is a single fast read ⇒ grounded on
 * success, unverifiable on malformed/RPC-error (never throws). An `opts.verify`
 * read runs the SAME call against ≥2 independent upstreams and judges agreement
 * — ≥2 agree ⇒ grounded · contradict ⇒ refuted · <2 respond ⇒ unverifiable.
 * That verify path is the parity-check spine Score binds.
 */

import {
  ContractFunctionRevertedError,
  createPublicClient,
  fallback,
  getAddress,
  http,
  parseAbi,
  type Chain,
  type PublicClient,
} from "viem";
import { mainnet, base, optimism } from "viem/chains";
import { grounded, refuted, unverifiable } from "../domain/observation.domain";
import type { Grounding, Observation, ObservationInit } from "../domain/observation.domain";
import type { Address, ChainId, HealthCheck, ReadOptions, SenseHealth, SonarSense } from "../ports/sonar-sense.port";

// --------------------------------------------------------------------------
// ABIs (mirrored from native-reader.ts)
// --------------------------------------------------------------------------

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const ERC721_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "ownerOf", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
] as const;

// --------------------------------------------------------------------------
// Chains — the 4 the Sonar indexer covers (Berachain primary)
// --------------------------------------------------------------------------

/** Berachain mainnet — defined locally (mirrors native-reader.ts). */
const berachain: Chain = {
  id: 80094,
  name: "Berachain",
  nativeCurrency: { name: "BERA", symbol: "BERA", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.berachain.com"] },
    public: { http: ["https://berachain-rpc.publicnode.com"] },
  },
  blockExplorers: { default: { name: "Beratrail", url: "https://beratrail.io" } },
};

interface ChainEntry {
  readonly chain: Chain;
  /** public, anonymous, $0 upstreams (getLogs/eth_call-capable) — from erpc.yaml. */
  readonly rpcUrls: readonly string[];
}

const CHAINS: Readonly<Record<number, ChainEntry>> = {
  80094: { chain: berachain, rpcUrls: ["https://rpc.berachain.com", "https://berachain-rpc.publicnode.com", "https://berachain.drpc.org"] },
  1: { chain: mainnet, rpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"] },
  8453: { chain: base, rpcUrls: ["https://base-rpc.publicnode.com", "https://base.drpc.org"] },
  10: { chain: optimism, rpcUrls: ["https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"] },
};

/** Live Sonar index gateway (200, verified). The default `doctor` GraphQL probe. */
const BELT_GATEWAY = "https://belt-gateway-production.up.railway.app/v1/graphql";
/**
 * A known-DEAD hyperindex alias — `doctor`'s trap (live-probed: 500/unreachable).
 * doctor() treats `status:"up"` (HTTP 200) HERE as a FAILURE — if 914708e is
 * revived or the network is misconfigured, doctor downgrades to unverifiable.
 * See the `ok` computation: ok ⇔ deadTrap.status === "down".
 */
const DEAD_ENDPOINT = "https://indexer.hyperindex.xyz/914708e/v1/graphql";

// --------------------------------------------------------------------------
// Options + helpers
// --------------------------------------------------------------------------

export interface LiveOptions {
  /**
   * Route every chain through a cluster-consumable eRPC ingress; the per-chain
   * path `${erpcUrl}/main/evm/${chainId}` is prepended to the public fallbacks
   * (eRPC tried first, publics as ordered fallback — see the `rank` note below).
   * Defaults to `process.env.ERPC_URL` (unset ⇒ public RPCs only).
   *
   * TRUST MODEL: `erpcUrl`/`graphqlUrl` are OPERATOR-set config (env / CLI /
   * Score config), validated for http(s) shape at construction. Internal hosts
   * (e.g. `erpc.railway.internal`) are intentionally ALLOWED — that is the
   * legitimate D2 path. Do NOT wire untrusted/user-supplied URLs here; the kit
   * is not an SSRF sanitiser, and a caller that accepts user URLs must validate.
   */
  readonly erpcUrl?: string;
  /** per-request timeout (ms). Default 10_000. */
  readonly timeoutMs?: number;
  /** belt-gateway GraphQL endpoint probed by `doctor`. Default {@link BELT_GATEWAY}. */
  readonly graphqlUrl?: string;
}

function rpcUrlsFor(chainId: number, erpcUrl?: string): readonly string[] {
  const publics = CHAINS[chainId]?.rpcUrls ?? [];
  if (!erpcUrl) return publics;
  return [`${erpcUrl.replace(/\/+$/, "")}/main/evm/${chainId}`, ...publics];
}

/**
 * The error CLASS name (e.g. "TimeoutError", "ContractFunctionExecutionError"),
 * sanitised — NEVER the error MESSAGE. A contract revert reason or a hostile RPC
 * body is attacker-influenceable; interpolating it into the trust-bearing,
 * AI-consumed `source` field would open a prompt/log-injection channel AND break
 * the stable-tag pattern consumers match on. The class name is viem-controlled.
 */
function errClass(e: unknown): string {
  const name = e instanceof Error ? e.name : "Unknown";
  return name.replace(/[^A-Za-z0-9]/g, "").slice(0, 40) || "Error";
}

/**
 * Distinguish a genuine on-chain REVERT (burned / nonexistent token) from a
 * transport/RPC failure OR an ambiguous no-data result. viem funnels EVERY
 * readContract failure through `ContractFunctionExecutionError`, nesting the REAL
 * cause (`TimeoutError` / `HttpRequestError` for a network blip;
 * `ContractFunctionRevertedError` for a real revert) as `.cause` — possibly
 * several levels deep. So we WALK the cause chain: ONLY a
 * `ContractFunctionRevertedError` is a DEFINITIVE "not owned" (grounded false).
 * Everything else — transport errors AND zero-data (the call returned nothing,
 * which can mean "not a contract / doesn't implement ownerOf", NOT "verified not
 * owned") — is non-definitive ⇒ rethrow ⇒ unverifiable (the safe default).
 */
export function isContractRevert(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur instanceof Error; depth++) {
    if (cur instanceof ContractFunctionRevertedError) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Parse + protocol-check a URL; throws (at construction) on file://, malformed, or non-http(s). */
function assertHttpUrl(url: string, label: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`sonar-sense: ${label} is not a valid URL: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`sonar-sense: ${label} must be http(s), got "${u.protocol}" (${url})`);
  }
}

/**
 * The Observation's `block_number` is stamped ONLY when the caller pins a block
 * (point-in-time read); for a latest read it is omitted (the domain builder
 * drops an undefined key). So: a grounded read WITHOUT `block_number` = "latest";
 * WITH it = "at that height". (We do not spend an extra RPC to fetch the head.)
 */
function blockNumberField(opts?: ReadOptions): number | undefined {
  return opts?.blockNumber === undefined ? undefined : Number(opts.blockNumber);
}

/** bigint-safe stable stringify (JSON.stringify throws on bigint). */
function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? `${val}n` : val));
}

/** Value equality that survives bigint + nested structures. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return stableStringify(a) === stableStringify(b);
  } catch {
    return false;
  }
}

/** Build an Observation for a dynamically-resolved grounding. */
function buildAs<T>(grounding: Grounding, init: ObservationInit<T>): Observation<T> {
  switch (grounding) {
    case "grounded":
      return grounded<T>(init);
    case "refuted":
      return refuted<T>(init);
    case "unverifiable":
      return unverifiable<T>(init);
    default: {
      const _exhaustive: never = grounding;
      throw new Error(`unreachable grounding: ${String(_exhaustive)}`);
    }
  }
}

/**
 * The verify spine (spec §5): run the SAME read against N independent upstreams
 * and judge agreement. ≥2 results that all agree ⇒ grounded · they contradict ⇒
 * refuted · fewer than 2 responded (degraded) ⇒ unverifiable. A read-fn that
 * throws counts as a non-response (Promise.allSettled rejection).
 */
export async function crossCheck<T>(
  reads: ReadonlyArray<() => Promise<T>>,
): Promise<{ grounding: Grounding; value?: T; agreed: number; total: number }> {
  // `Promise.resolve().then(r)` so a SYNCHRONOUS throw in a read-fn becomes a
  // rejection (a non-response), never crashing crossCheck itself.
  const settled = await Promise.allSettled(reads.map((r) => Promise.resolve().then(r)));
  const oks = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  if (oks.length < 2) {
    return { grounding: "unverifiable", value: oks[0], agreed: oks.length, total: reads.length };
  }
  if (oks.every((v) => sameValue(v, oks[0]))) {
    return { grounding: "grounded", value: oks[0], agreed: oks.length, total: reads.length };
  }
  // refuted ⇒ the upstreams CONTRADICT, so there is NO agreed value. Do not surface
  // an arbitrary one as if authoritative — the caller falls back to its neutral default.
  return { grounding: "refuted", value: undefined, agreed: oks.length, total: reads.length };
}

// --------------------------------------------------------------------------
// Factory
// --------------------------------------------------------------------------

/** Build a live SonarSense bound to real RPC + the belt-gateway index. */
export function makeLiveSonarSense(opts: LiveOptions = {}): SonarSense {
  const erpcUrl = opts.erpcUrl ?? process.env.ERPC_URL ?? undefined;
  const timeout = opts.timeoutMs ?? 10_000;
  const graphqlUrl = opts.graphqlUrl ?? BELT_GATEWAY;
  // Fail fast on bad config: protocol-check (closes the file:// / malformed
  // class). NOT an SSRF block — internal hosts stay allowed for the eRPC path.
  if (erpcUrl) assertHttpUrl(erpcUrl, "erpcUrl/ERPC_URL");
  assertHttpUrl(graphqlUrl, "graphqlUrl");

  const sourceKind = erpcUrl ? "erpc" : "viem";
  const clients = new Map<number, PublicClient>();
  const singles = new Map<string, PublicClient>();
  let seq = 0;
  const trace = (verb: string): string => `live:${verb}:${++seq}`;
  const chainName = (chainId: number): string => CHAINS[chainId]?.chain.name.toLowerCase() ?? String(chainId);
  const sourceTag = (chainId: number): string => `${sourceKind}:${chainName(chainId)}`;

  /** The fallback-chain client for a chain (eRPC-first when configured). */
  function client(chainId: number): PublicClient | null {
    const entry = CHAINS[chainId];
    if (!entry) return null;
    let c = clients.get(chainId);
    if (!c) {
      const urls = rpcUrlsFor(chainId, erpcUrl);
      c = createPublicClient({
        chain: entry.chain,
        // rank:false ⇒ STATIC order (try urls[0] first, fall back in order). With
        // eRPC prepended (rpcUrlsFor), this gives eRPC priority + publics as
        // ordered fallback — exactly the intended hierarchy, without rank:true's
        // periodic latency-probing overhead.
        transport: fallback(
          urls.map((u) => http(u, { timeout, retryCount: 1 })),
          { rank: false },
        ),
      });
      clients.set(chainId, c);
    }
    return c;
  }

  /** A SINGLE-upstream client (one RPC URL, no fallback) — for verify cross-checks. */
  function singleClient(chainId: number, url: string): PublicClient {
    const key = `${chainId}:${url}`;
    let c = singles.get(key);
    if (!c) {
      c = createPublicClient({ chain: CHAINS[chainId]!.chain, transport: http(url, { timeout, retryCount: 1 }) });
      singles.set(key, c);
    }
    return c;
  }

  /**
   * Shared read path for the chain verbs. Default: one read via the fallback
   * chain ⇒ grounded on success, unverifiable on RPC error. `opts.verify`: read
   * `readFn` against ≥2 distinct upstreams and judge via crossCheck (grounded /
   * refuted / unverifiable). `fallbackValue` is the value carried on a failure.
   */
  async function runRead<T>(
    verb: string,
    chain: ChainId,
    fallbackValue: T,
    readFn: (c: PublicClient, blockNumber: bigint | undefined) => Promise<T>,
    opts?: ReadOptions,
  ): Promise<Observation<T>> {
    const fb = client(chain);
    if (!fb) return unverifiable<T>({ value: fallbackValue, source: `live:unsupported-chain:${chain}`, chain_id: chain, trace_id: trace(verb) });

    if (opts?.verify) {
      // Cross-check over the SAME upstream set the reader uses — INCLUDING eRPC
      // (rpcUrlsFor), not just the public RPCs.
      const urls = rpcUrlsFor(chain, erpcUrl).slice(0, 2);
      if (urls.length >= 2) {
        // Pin a COMMON block so normal head-skew between upstreams isn't mistaken for
        // a contradiction (spurious refuted). Use the caller's block, else the MIN of
        // the upstreams' heads — a block BOTH are guaranteed to have.
        let pinned = opts.blockNumber;
        if (pinned === undefined) {
          const heads = await Promise.all(
            urls.map((u) => singleClient(chain, u).getBlockNumber().then((h) => h, () => undefined)),
          );
          const ok = heads.filter((h): h is bigint => typeof h === "bigint");
          if (ok.length >= 2) pinned = ok.reduce((a, b) => (a < b ? a : b));
        }
        const cc = await crossCheck(urls.map((u) => () => readFn(singleClient(chain, u), pinned)));
        return buildAs<T>(cc.grounding, {
          value: cc.value ?? fallbackValue,
          source: `${sourceKind}:verify:${chainName(chain)}`,
          chain_id: chain,
          // Surface ONLY the CALLER's pinned block. The internal auto-pin (used to
          // make the cross-check skew-free) is an implementation detail — a
          // caller-requested "latest" read must NOT leak it as a point-in-time
          // block_number (preserves the bd-zfj.4 latest-vs-pinned contract).
          block_number: blockNumberField(opts),
          trace_id: trace(verb),
        });
      }
      // Only one upstream to read from ⇒ can't cross-check ⇒ unverifiable, not grounded.
      try {
        const value = await readFn(fb, opts.blockNumber);
        return unverifiable<T>({ value, source: `${sourceKind}:single:${chainName(chain)}`, chain_id: chain, block_number: blockNumberField(opts), trace_id: trace(verb) });
      } catch (e) {
        return unverifiable<T>({ value: fallbackValue, source: `live:rpc-error:${errClass(e)}`, chain_id: chain, trace_id: trace(verb) });
      }
    }

    try {
      const value = await readFn(fb, opts?.blockNumber);
      return grounded<T>({ value, source: sourceTag(chain), chain_id: chain, block_number: blockNumberField(opts), trace_id: trace(verb) });
    } catch (e) {
      return unverifiable<T>({ value: fallbackValue, source: `live:rpc-error:${errClass(e)}`, chain_id: chain, trace_id: trace(verb) });
    }
  }

  /**
   * Probe a GraphQL endpoint. `validatePayload` (the live gateway) requires a
   * real GraphQL OK — a 200 carrying `{ errors: [...] }` or no `data` is a
   * DEGRADED service, NOT "up". The dead-endpoint trap passes `false` (any 200 =
   * it answered = suspicious). Always drains/cancels the body so Node's undici
   * keep-alive pool doesn't stall across repeated doctor() calls.
   */
  async function probeGraphql(target: string, url: string, validatePayload: boolean): Promise<HealthCheck> {
    const start = Date.now();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await /* @non-metadata-fetch Sonar sense probe */ fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ __typename }" }),
        signal: ctrl.signal,
      });
      const latency_ms = Date.now() - start;
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { target, status: "down", latency_ms, detail: `HTTP ${res.status}` };
      }
      if (!validatePayload) {
        // reachability-only (the dead-endpoint trap): any 200 = "up" (= suspicious).
        await res.body?.cancel().catch(() => {});
        return { target, status: "up", latency_ms, detail: `HTTP ${res.status}` };
      }
      // gateway: a 200 is healthy ONLY if the GraphQL payload is OK (data, no errors).
      try {
        const body = (await res.json()) as { data?: unknown; errors?: unknown[] };
        // `data` must be present AND non-null — a 200 carrying `{ data: null }`
        // (or no data) is a degraded/failed query, NOT a healthy gateway.
        const healthy = body != null && body.data != null && !(Array.isArray(body.errors) && body.errors.length > 0);
        return { target, status: healthy ? "up" : "down", latency_ms, detail: healthy ? "HTTP 200 · graphql ok" : "HTTP 200 but graphql errors / no data" };
      } catch {
        return { target, status: "down", latency_ms, detail: "HTTP 200 but non-JSON body" };
      }
    } catch (e) {
      return { target, status: "down", latency_ms: Date.now() - start, detail: errClass(e) };
    } finally {
      clearTimeout(t); // always clear — a rejected fetch must NOT leak the abort timer
    }
  }

  async function probeRpc(target: string, chainId: number): Promise<HealthCheck> {
    const start = Date.now();
    const c = client(chainId);
    if (!c) return { target, status: "down", detail: `unsupported chain ${chainId}` };
    try {
      const bn = await c.getBlockNumber();
      return { target, status: "up", latency_ms: Date.now() - start, detail: `block ${bn}` };
    } catch (e) {
      return { target, status: "down", latency_ms: Date.now() - start, detail: errClass(e) };
    }
  }

  return {
    async doctor() {
      const [gateway, rpc, deadTrap] = await Promise.all([
        probeGraphql("belt-gateway:graphql", graphqlUrl, true),
        probeRpc("rpc:berachain", 80094),
        probeGraphql("dead-endpoint-trap", DEAD_ENDPOINT, false),
      ]);
      const checks: HealthCheck[] = [gateway, rpc, deadTrap];
      // ok ⇔ required targets up AND the dead-endpoint trap is correctly down.
      const ok = gateway.status === "up" && rpc.status === "up" && deadTrap.status === "down";
      const value: SenseHealth = { ok, checks };
      const init = { value, source: "live:doctor", chain_id: 80094, trace_id: trace("doctor") };
      return ok ? grounded<SenseHealth>(init) : unverifiable<SenseHealth>(init);
    },

    async read<T>(chain: ChainId, address: Address, fnSig: string, args?: readonly unknown[], opts?: ReadOptions) {
      let addr: Address;
      try {
        addr = getAddress(address);
      } catch {
        return unverifiable<T>({ value: undefined as T, source: "live:malformed-address", chain_id: chain, trace_id: trace("read") });
      }
      let abi;
      let fnName: string | undefined;
      try {
        abi = parseAbi([fnSig]);
        // Derive the function name from the PARSED abi (robust) — a regex on the
        // raw signature mis-fires on nested types like `foo(tuple(uint256) x)`.
        // (viem types parseAbi(runtime-string) as `never`; view it for the lookup.)
        const items = abi as readonly { type: string; name?: string }[];
        fnName = items.find((item) => item.type === "function")?.name;
        if (!fnName) throw new Error("no function in signature");
      } catch {
        return unverifiable<T>({ value: undefined as T, source: "live:malformed-fnSig", chain_id: chain, trace_id: trace("read") });
      }
      const fn = fnName;
      return runRead<T>(
        "read",
        chain,
        undefined as T,
        (c, blockNumber) => c.readContract({ address: addr, abi, functionName: fn, args: (args ?? []) as readonly unknown[], blockNumber }) as Promise<T>,
        opts,
      );
    },

    async balance(chain, owner, token, opts) {
      let o: Address, t: Address;
      try {
        o = getAddress(owner);
        t = getAddress(token);
      } catch {
        return unverifiable<bigint>({ value: 0n, source: "live:malformed-address", chain_id: chain, trace_id: trace("balance") });
      }
      return runRead<bigint>(
        "balance",
        chain,
        0n,
        (c, blockNumber) => c.readContract({ address: t, abi: ERC20_ABI, functionName: "balanceOf", args: [o], blockNumber }) as Promise<bigint>,
        opts,
      );
    },

    async owns(chain, owner, collection, tokenId, opts) {
      let o: Address, col: Address;
      try {
        o = getAddress(owner);
        col = getAddress(collection);
      } catch {
        return unverifiable<boolean>({ value: false, source: "live:malformed-address", chain_id: chain, trace_id: trace("owns") });
      }
      return runRead<boolean>(
        "owns",
        chain,
        false,
        async (c, blockNumber) => {
          if (tokenId !== undefined) {
            try {
              const ownerOf = (await c.readContract({ address: col, abi: ERC721_ABI, functionName: "ownerOf", args: [tokenId], blockNumber })) as Address;
              return ownerOf.toLowerCase() === o.toLowerCase();
            } catch (e) {
              // genuine revert (nonexistent/burned) ⇒ definitive false; transport
              // error ⇒ rethrow so runRead/crossCheck count it as a non-response.
              if (isContractRevert(e)) return false;
              throw e;
            }
          }
          const bal = (await c.readContract({ address: col, abi: ERC721_ABI, functionName: "balanceOf", args: [o], blockNumber })) as bigint;
          return bal > 0n;
        },
        opts,
      );
    },

    async native(chain, account, opts) {
      let a: Address;
      try {
        a = getAddress(account);
      } catch {
        return unverifiable<bigint>({ value: 0n, source: "live:malformed-address", chain_id: chain, trace_id: trace("native") });
      }
      return runRead<bigint>("native", chain, 0n, (c, blockNumber) => c.getBalance({ address: a, blockNumber }), opts);
    },
  };
}
