#!/usr/bin/env node
/*
 * sync-dashboard.cjs — local, READ-ONLY dashboard for the green belt cold-sync.
 *
 *   node scripts/sync-dashboard.cjs        # then open http://localhost:8787
 *
 * Queries chain_metadata in Postgres-vRR1 (green) and serves a self-refreshing
 * page: per-chain progress bars, %, blocks remaining, events, live rate + ETA.
 * Zero new deps (uses the repo's bundled postgres.js). Never writes anything.
 *
 * DB URL resolution: GREEN_DB_URL env, else `railway variables --service
 * Postgres-vRR1` using the project token at ~/.railway-green.tok.
 * Override the service with GREEN_PG_SERVICE, the port with PORT.
 */
const http = require("node:http");
const { execSync } = require("node:child_process");
const { readFileSync, existsSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = Number(process.env.PORT || 8787);
const PG_SERVICE = process.env.GREEN_PG_SERVICE || "Postgres-vRR1";
const POSTGRES = path.join(process.cwd(), "node_modules/.pnpm/postgres@3.4.8/node_modules/postgres");
const TOKEN_FILE = path.join(os.homedir(), ".railway-green.tok");
const CHAINS = { 1: "Ethereum", 10: "Optimism", 8453: "Base", 42161: "Arbitrum", 80094: "Berachain", 7777777: "Zora" };

function greenDbUrl() {
  if (process.env.GREEN_DB_URL) return process.env.GREEN_DB_URL;
  if (!existsSync(TOKEN_FILE)) throw new Error(`set GREEN_DB_URL, or put a Railway project token at ${TOKEN_FILE}`);
  const tok = readFileSync(TOKEN_FILE, "utf8").trim();
  const out = execSync(`railway variables --service ${PG_SERVICE} --json`, {
    env: { ...process.env, RAILWAY_TOKEN: tok }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  const url = JSON.parse(out).DATABASE_PUBLIC_URL;
  if (!url) throw new Error(`DATABASE_PUBLIC_URL not found on ${PG_SERVICE}`);
  return url;
}

const postgres = require(POSTGRES);
let sql;
const prev = {}; // chain_id -> { ts, done }

async function snapshot() {
  const rows = await sql`
    select chain_id, start_block, block_height, latest_processed_block,
           latest_fetched_block_number as fetched, num_events_processed, is_hyper_sync,
           timestamp_caught_up_to_head_or_endblock as caught_up
    from chain_metadata order by chain_id`;
  const now = Date.now();
  const chains = rows.map((r) => {
    const start = Number(r.start_block), head = Number(r.block_height), done = Number(r.latest_processed_block);
    const fetched = Math.min(Number(r.fetched), head);
    const span = Math.max(head - start, 1);
    const pct = Math.min(100, Math.max(0, ((done - start) / span) * 100));
    const fetchedPct = Math.min(100, Math.max(0, ((fetched - start) / span) * 100));
    const remaining = Math.max(head - done, 0);
    const fetchAhead = Math.max(fetched - done, 0);
    const converged = !!r.caught_up || remaining <= 100;
    // liveness rate = leading-edge (fetched) movement so a batch-lagging chain still reads active;
    // ETA uses committed (processed) movement, which is what actually closes the gap.
    let rate = null, eta = null;
    const p = prev[r.chain_id];
    if (p && now > p.ts) {
      const dt = (now - p.ts) / 1000;
      const dfetch = fetched - (p.fetched ?? fetched), ddone = done - p.done;
      if (dt > 0) {
        if (dfetch > 0) rate = dfetch / dt; else if (ddone > 0) rate = ddone / dt;
        if (ddone > 1 && !converged) eta = remaining / (ddone / dt);
      }
    }
    prev[r.chain_id] = { ts: now, done, fetched };
    return {
      id: r.chain_id, name: CHAINS[r.chain_id] || String(r.chain_id),
      start, head, done, fetched, pct, fetchedPct, remaining, fetchAhead,
      events: Number(r.num_events_processed), hyperSync: !!r.is_hyper_sync, converged, rate, eta,
    };
  });
  return { ts: now, chains, converged: chains.filter((c) => c.converged).length, total: chains.length };
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>sonar belt — green sync</title>
<style>
  :root{ --bg:#0a0c11; --card:#12151c; --line:#222836; --fg:#e7ecf3; --dim:#7c879b;
         --amber:#f0a830; --green:#39d98a; --track:#1c2230; }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);
    font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;-webkit-font-smoothing:antialiased}
  .wrap{max-width:880px;margin:0 auto;padding:28px 20px 60px}
  header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:22px}
  h1{font-size:15px;font-weight:600;letter-spacing:.02em;margin:0}
  h1 .sub{color:var(--dim);font-weight:400}
  .meta{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}
  .overall{margin:0 0 22px;padding:14px 16px;background:var(--card);border:1px solid var(--line);border-radius:10px;
    display:flex;align-items:center;gap:14px}
  .overall .big{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
  .grid{display:grid;gap:12px}
  .chain{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .row{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
  .name{font-size:14px;font-weight:600}
  .badge{font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--dim);
    border:1px solid var(--line);border-radius:5px;padding:1px 6px;margin-left:8px}
  .pct{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
  .bar{position:relative;height:8px;background:var(--track);border-radius:5px;overflow:hidden;margin:10px 0 8px}
  .ghost{position:absolute;inset:0 auto 0 0;height:100%;background:#2b3650;border-radius:5px;transition:width .6s ease}
  .fill{position:absolute;inset:0 auto 0 0;height:100%;border-radius:5px;transition:width .6s ease}
  .stats{display:flex;flex-wrap:wrap;gap:4px 18px;color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}
  .stats b{color:var(--fg);font-weight:500}
  .ok{color:var(--green)} .go{color:var(--amber)}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .pulse{animation:p 1.6s ease-in-out infinite} @keyframes p{50%{opacity:.35}}
  footer{margin-top:24px;color:var(--dim);font-size:11px;text-align:center}
</style></head><body><div class="wrap">
  <header><h1>sonar belt <span class="sub">· green cold-sync (6-chain consolidated)</span></h1>
    <span class="meta" id="updated">connecting…</span></header>
  <div class="overall"><span class="big" id="ovr">–/–</span><span class="meta" id="ovrtxt">chains converged</span></div>
  <div class="grid" id="grid"></div>
  <footer>read-only · polls every 8s · blue (4-chain mibera belt) still serving the live alias</footer>
</div><script>
const fmtN = n => n.toLocaleString();
const fmtEta = s => { if(s==null) return "—"; if(s<90) return Math.round(s)+"s";
  const h=Math.floor(s/3600), m=Math.round((s%3600)/60); return h?h+"h "+m+"m":m+"m"; };
const fmtRate = r => r==null?"—":(r>=1000?(r/1000).toFixed(1)+"k":Math.round(r))+" blk/s";
async function tick(){
  let d; try{ d = await (await fetch("/api")).json(); }catch(e){ document.getElementById("updated").textContent="(server offline)"; return; }
  document.getElementById("updated").textContent = "updated "+new Date(d.ts).toLocaleTimeString();
  document.getElementById("ovr").textContent = d.converged+"/"+d.total;
  document.getElementById("ovrtxt").textContent = d.converged===d.total ? "✅ all chains converged — ready to certify" : "chains converged · syncing…";
  document.getElementById("grid").innerHTML = d.chains.map(c=>{
    const col = c.converged ? "var(--green)" : "var(--amber)";
    const cls = c.converged ? "ok" : "go";
    const dot = c.converged ? '<span class="dot" style="background:var(--green)"></span>'
                            : '<span class="dot pulse" style="background:var(--amber)"></span>';
    return \`<div class="chain">
      <div class="row"><span class="name">\${dot}\${c.name}<span class="badge">\${c.hyperSync?"hypersync":"rpc"}</span></span>
        <span class="pct \${cls}">\${c.converged?"✓ at head":c.pct.toFixed(1)+"%"}</span></div>
      <div class="bar"><div class="ghost" style="width:\${c.fetchedPct}%"></div><div class="fill" style="width:\${c.pct}%;background:\${col}"></div></div>
      <div class="stats">
        <span><b>\${fmtN(c.done)}</b> / \${fmtN(c.head)}</span>
        <span>remaining <b>\${fmtN(c.remaining)}</b></span>
        \${(!c.converged && c.fetchAhead>1000)?'<span>fetched <b class="go">+'+fmtN(c.fetchAhead)+'</b> ahead</span>':''}
        <span>events <b>\${fmtN(c.events)}</b></span>
        <span>rate <b>\${fmtRate(c.rate)}</b></span>
        <span>eta <b>\${c.converged?"—":fmtEta(c.eta)}</b></span>
      </div></div>\`;
  }).join("");
}
tick(); setInterval(tick, 8000);
</script></body></html>`;

async function main() {
  const url = greenDbUrl();
  sql = postgres(url, { ssl: { rejectUnauthorized: false }, max: 2, idle_timeout: 20 });
  http.createServer(async (req, res) => {
    if (req.url === "/api") {
      try {
        const data = await snapshot();
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  }).listen(PORT, () => {
    console.log(`\n  sonar belt sync dashboard → http://localhost:${PORT}\n  (reading ${PG_SERVICE}; Ctrl-C to stop)\n`);
  });
}
main().catch((e) => { console.error("[sync-dashboard]", e.message); process.exit(1); });
