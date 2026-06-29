#!/usr/bin/env node
// railway-cost-model.mjs — Cost as a first-class loop component (the LOOPS diagram, 2026-06-20).
//
// DISCIPLINE: anchor on the MEASURED number; flag every estimate; never project from vibes.
// (The first draft of this tool estimated $300 when the real bill was $133 — that mistake IS the
//  lesson: cost-awareness means measured-first. The per-service split below is the one thing still
//  estimated; the `--pull` loop that replaces it with the dashboard's "Cost by Service" is the TODO.)
//
// Run:  node scripts/railway-cost-model.mjs              # report
//       HYPERSYNC_USD=20 node scripts/railway-cost-model.mjs   # decide the $70 bar
//       node scripts/railway-cost-model.mjs --json       # loa-finn atomic-cost lines

// ── GROUNDED Railway rates (Railway dashboard, freeside-sonar, 2026-06-20) ──────────────────
const RATE = { mem: 0.000231, cpu: 0.000463, vol: 0.00000347 }; // $/unit/minute
const MIN = 43800; // minutes/month (730h)
const usd = (gb, vcpu, volgb) => gb*RATE.mem*MIN + vcpu*RATE.cpu*MIN + volgb*RATE.vol*MIN;
const GB_MO = usd(1,0,0), VCPU_MO = usd(0,1,0); // $10.12/GB·mo, $20.28/vCPU·mo

// ── MEASURED anchors (not estimated) ────────────────────────────────────────────────────────
const MEASURED_LAST_MONTH = 133.21;   // whole freeside-sonar project, green-Ponder-dominated month
const MEASURED_AVG_GB      = 11.68;   // 504,498 minutely-GB ÷ 43,800 — the project held ~11.7GB avg
const BAR = 70;                       // managed-Envio price (bundles HyperSync) — the bar to beat

// ── Post-cutover KEEP set: the self-host stack at head. [EST] RAM until the --pull loop lands ──
const KEEP = [
  // name                     role                       gb   vcpu  vol   note
  ['belt-indexer-selfhost', 'self-host Envio @ head',   2.5, 0.4,  0,  '[EST] right-sizable to ~2GB'],
  ['Postgres-6J4w',         'self-host DB',             1.5, 0.3, 10,  '[EST] vol grows w/ entities'],
  ['belt-hasura-selfhost',  'self-host GraphQL',        0.6, 0.15, 0,  '[EST]'],
  ['belt-gateway',          'Caddy proxy (the blanket)',0.4, 0.1,  0,  '[EST] consumer-facing'],
];
// What the cutover REMOVES (was most of the $133 green month): green-Ponder v3/v2/green, blue
// belt-indexer, erpc, belt-hasura + belt-hasura-green, Postgres-vRR1/3vIC/(Postgres), + the
// auto-named dup Postgres-0-lR. Retiring them is the saving; the exact $ is in the $133 we already have.
const RETIRE = ['belt-indexer-green-v3','belt-indexer-green-v2','belt-indexer-green','belt-indexer',
  'erpc','belt-hasura-green','belt-hasura','Postgres-vRR1','Postgres-3vIC','Postgres(misc?)','Postgres-0-lR(dup)'];

const sum = (rows) => rows.reduce((a,[,,gb,vcpu,vol])=>a+usd(gb,vcpu,vol),0);
const postCutover = sum(KEEP);
const rightsized  = sum(KEEP.map(r=> r[0]==='belt-indexer-selfhost' ? [...r.slice(0,2),2.0,0.4,0,r[6]] : r));
const HS = process.env.HYPERSYNC_USD ? Number(process.env.HYPERSYNC_USD) : null;
const f = (n)=>`$${n.toFixed(2)}`;

if (process.argv.includes('--json')) {
  const stamp = process.env.COST_STAMP || new Date().toISOString?.() || 'stamp-unset';
  console.log(JSON.stringify({
    ledger:'sonar-infra', source:'railway', rates:RATE, bar_usd:BAR,
    measured:{ last_month_usd:MEASURED_LAST_MONTH, avg_gb:MEASURED_AVG_GB, cost_source:'measured' },
    projected:{ post_cutover_usd:Number(postCutover.toFixed(2)), rightsized_usd:Number(rightsized.toFixed(2)),
                hypersync_usd:HS, cost_source:'measured-rate-estimated-ram' },
    keep: KEEP.map(([n,role,gb,vcpu,vol])=>({service:n,role,usd_month:Number(usd(gb,vcpu,vol).toFixed(2)),gb,vcpu,vol_gb:vol})),
    stamp,
  }, null, 2));
  process.exit(0);
}

console.log(`
  💸 SONAR INFRA COST — Railway · rates MEASURED 2026-06-20 · memory is the whole game
     1 GB held 24/7 = ${f(GB_MO)}/mo   |   1 vCPU = ${f(VCPU_MO)}/mo (barely matters)

  MEASURED last month (whole project, green-Ponder era):  ${f(MEASURED_LAST_MONTH)}   (≈${MEASURED_AVG_GB}GB avg, 87% memory)

  CUTOVER retires ${RETIRE.length} services (the green/blue stack + eRPC + dup DB):
     ${RETIRE.join(', ')}

  POST-CUTOVER keep set — the self-host stack [RAM = ESTIMATE pending the --pull loop]:`);
for (const [n,role,gb,vcpu,vol] of KEEP)
  console.log(`     ${n.padEnd(24)}${role.padEnd(26)}${f(usd(gb,vcpu,vol)).padStart(8)}   (${gb}GB)`);
console.log(`
  PROJECTION:
     post-cutover (as-is)        ${f(postCutover).padStart(8)}
     post-cutover + right-sized  ${f(rightsized).padStart(8)}   ← indexer heap 12GB→2GB at head (the lever)

  THE $${BAR} BAR (managed bundles HyperSync; self-host = Railway + your HyperSync sub):
     Railway (right-sized) ${f(rightsized)} + HyperSync ${HS!==null?f(HS):'$??'} = ${HS!==null?f(rightsized+HS):'?'}
     ${HS!==null
        ? (rightsized+HS<=BAR ? `→ self-host WINS the bar AND owns the data ✅`
                              : `→ self-host is ${f(rightsized+HS-BAR)}/mo OVER managed — but you OWN the data + the cost is legible`)
        : `→ set HYPERSYNC_USD=<n> to decide. Self-host beats $${BAR} iff HyperSync ≤ ${f(BAR-rightsized)}.`}

  HONEST READ: self-host here is ~the same cost as managed, not cheaper — exactly as you said. The win
  is OWNERSHIP + LEGIBILITY: you can see every GB, kill idle services, and right-size. Managed is a
  black box at $70. The real post-cutover $ lands at the cost-tripwire (measured, not this estimate).
`);
