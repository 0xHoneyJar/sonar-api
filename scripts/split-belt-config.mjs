#!/usr/bin/env node
/**
 * scripts/split-belt-config.mjs — Per-chain config generator for D4 belt split.
 *
 * Reads config.yaml (the single hand-edited source of truth) and emits one
 * config.<id>.yaml per chain entry.  Each per-chain file contains:
 *   - All shared top-level keys (every key except `chains`) with `name`
 *     rewritten to `thj-indexer-<id>`.
 *   - `contracts:` filtered to only the contract-type blocks whose `name`
 *     appears in that chain's chains[].contracts[].name set.
 *   - `chains:` reduced to the single matching entry (including its
 *     `hypersync_config` if present — today only chain 80094 carries one).
 *
 * Uses the yaml Document API (parseDocument) throughout so comments and key
 * order are preserved verbatim from the source.  No JSON round-tripping.
 *
 * Emit is idempotent: re-running with no source change yields byte-identical
 * files (deterministic toString() from stable AST clone).
 *
 * Usage:
 *   node scripts/split-belt-config.mjs [--config <path>] [--check] [--help]
 *
 * --config <path>   Source config to split (default: config.yaml, repo root)
 * --check           CI drift guard: diff generated vs on-disk; exit 0 if all
 *                   match, exit 1 + unified diff of first drifting file if not
 * --help            Print this message and exit 0
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  parseDocument,
  visit,
  Document,
  YAMLMap,
  YAMLSeq,
  Pair,
  Scalar,
  isMap,
  isSeq,
  isPair,
  isScalar,
} from 'yaml';

// ---------------------------------------------------------------------------
// BLOCKER fix (verify:d4 DISS): the `yaml` lib parses a bare `0x…` scalar as a
// HEX INTEGER. A 160-bit EVM address exceeds float64's 53-bit mantissa, so it is
// silently rounded — re-emitting the parsed value corrupts every contract address
// (18+ trailing zeros → belts index nothing). Fix: BEFORE any clone/emit, recover
// each hex scalar's EXACT source text (via node.range) and pin it as a quoted
// string so it can never round-trip through the number resolver again. Envio's
// Rust parser reads quoted-hex addresses fine.
// ---------------------------------------------------------------------------
const HEX_ADDR_RE = /^0x[0-9a-fA-F]+$/;

function preserveHexScalars(doc, srcText) {
  let fixed = 0;
  visit(doc, {
    Scalar(_key, node) {
      if (!node || !Array.isArray(node.range)) return;
      const src = srcText.slice(node.range[0], node.range[1]).trim();
      if (HEX_ADDR_RE.test(src)) {
        node.value = src;                 // exact address text, as a string
        node.type = Scalar.QUOTE_SINGLE;  // emit quoted → unambiguous, never re-parsed as a number
        fixed++;
      }
    },
  });
  return fixed;
}

// Extract every 0x-hex address token from a YAML string (for the integrity assert).
function addressTokens(text) {
  return new Set((text.match(/0x[0-9a-fA-F]{6,}/g) || []).map(s => s.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Repo root — the directory that contains this script's parent dir
// ---------------------------------------------------------------------------
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------
function printUsage() {
  process.stdout.write(`
Usage: node scripts/split-belt-config.mjs [options]

Generate per-chain config.<id>.yaml files from a single source config.yaml.

Options:
  --config <path>   Source config path (default: config.yaml relative to repo root)
  --check           CI drift guard: compare generated content to on-disk files.
                    Exit 0 if all match.  Exit 1 and print a unified diff of
                    the first drifting file if any differ.
  --help, -h        Show this message and exit 0

Output files (written to same directory as the source config):
  config.1.yaml     Ethereum
  config.42161.yaml Arbitrum
  config.7777777.yaml Zora
  config.10.yaml    Optimism
  config.8453.yaml  Base
  config.80094.yaml Berachain (carries hypersync_config)
`.trimStart());
}

function parseArgs(argv) {
  const opts = { config: null, check: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') {
      if (i + 1 >= argv.length) { console.error('--config requires a path argument'); process.exit(2); }
      opts.config = argv[++i];
    } else if (a === '--check') {
      opts.check = true;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// YAML AST deep-clone — preserves comments, key order, tags
// ---------------------------------------------------------------------------
function deepClone(node, schema) {
  if (node === null || node === undefined) return node;

  if (isScalar(node)) {
    const s = new Scalar(node.value);
    s.type = node.type;
    s.format = node.format;
    s.comment = node.comment;
    s.commentBefore = node.commentBefore;
    s.spaceBefore = node.spaceBefore;
    s.tag = node.tag;
    return s;
  }

  if (isPair(node)) {
    const p = new Pair(deepClone(node.key, schema), deepClone(node.value, schema));
    p.comment = node.comment;
    p.commentBefore = node.commentBefore;
    p.spaceBefore = node.spaceBefore;
    return p;
  }

  if (isMap(node)) {
    const m = new YAMLMap(schema);
    m.comment = node.comment;
    m.commentBefore = node.commentBefore;
    m.spaceBefore = node.spaceBefore;
    m.flow = node.flow;
    m.tag = node.tag;
    for (const item of node.items) m.items.push(deepClone(item, schema));
    return m;
  }

  if (isSeq(node)) {
    const s = new YAMLSeq(schema);
    s.comment = node.comment;
    s.commentBefore = node.commentBefore;
    s.spaceBefore = node.spaceBefore;
    s.flow = node.flow;
    s.tag = node.tag;
    for (const item of node.items) s.items.push(deepClone(item, schema));
    return s;
  }

  // Null nodes and other non-collection types — return as-is
  return node;
}

// ---------------------------------------------------------------------------
// Per-chain config generator
// ---------------------------------------------------------------------------
/**
 * Generate the YAML string for a single chain config.
 *
 * @param {import('yaml').Document} doc         Parsed source document
 * @param {import('yaml').YAMLMap}  chainNode   The target chain's YAMLMap node
 * @param {string[]}                sharedKeys  Top-level keys to carry (all except 'chains')
 * @returns {string}                            Stringified YAML for this chain
 */
function generateChainConfig(doc, chainNode, sharedKeys) {
  const { schema } = doc;
  const srcMap = doc.contents;

  // Collect the contract names this chain declares
  const chainContractsPair = chainNode.items.find(p => p.key.value === 'contracts');
  const chainContractNames = new Set(
    chainContractsPair.value.items.map(c =>
      c.items.find(p => p.key.value === 'name').value.value
    )
  );

  // Resolve chain id (integer or string in the AST — normalise to string)
  const chainId = String(chainNode.items.find(p => p.key.value === 'id').value.value);

  // Build a new Document
  const newDoc = new Document();
  newDoc.schema = schema;

  const newMap = new YAMLMap(schema);

  // 1. Copy all shared top-level keys, in source order
  for (const key of sharedKeys) {
    const srcPair = srcMap.items.find(p => p.key.value === key);
    if (!srcPair) continue;

    const clonedPair = deepClone(srcPair, schema);

    if (key === 'name') {
      // Rewrite: thj-indexer → thj-indexer-<id>
      clonedPair.value.value = `thj-indexer-${chainId}`;
    } else if (key === 'contracts') {
      // Filter: keep only contract-type blocks referenced by this chain
      clonedPair.value.items = clonedPair.value.items.filter(contractNode => {
        const namePair = contractNode.items.find(p => p.key.value === 'name');
        return chainContractNames.has(namePair.value.value);
      });
    }

    newMap.items.push(clonedPair);
  }

  // 2. Add chains: [<this chain entry>]
  // loa:shortcut: ACCEPTED-LOW — the yaml lib attaches the NEXT source chain's header
  // comment (e.g. "# Berachain Mainnet") as a trailing comment inside this node, so a
  // sibling's provenance comment can bleed into this file. HARMLESS: Envio ignores YAML
  // comments (verify:d4 rated it LOW). A robust strip needs CST-level surgery; not worth it.
  const chainsKeyScalar = new Scalar('chains');
  const newChainsSeq = new YAMLSeq(schema);
  newChainsSeq.items.push(deepClone(chainNode, schema));
  newMap.items.push(new Pair(chainsKeyScalar, newChainsSeq));

  newDoc.contents = newMap;

  // Carry the trailing doc-level comment from the source (the V3 note at EOF)
  if (doc.comment) newDoc.comment = doc.comment;

  // lineWidth:0 disables plain-scalar line-folding (LOW fix — keeps event signatures
  // on one line, matching the source instead of a noisy folded diff).
  return newDoc.toString({ lineWidth: 0 });
}

// ---------------------------------------------------------------------------
// Unified diff helper (uses system `diff -u`)
// ---------------------------------------------------------------------------
/**
 * Produce a unified diff between `expected` (generated) and `actual` (on-disk).
 * Returns the diff string, or empty string if identical.
 */
function unifiedDiff(expectedContent, actualPath) {
  // Write generated to a temp file so `diff` can compare
  const tmpDir = mkdtempSync(join(tmpdir(), 'split-belt-'));
  const tmpFile = join(tmpDir, 'generated');
  try {
    writeFileSync(tmpFile, expectedContent, 'utf8');
    const result = spawnSync('diff', ['-u', actualPath, tmpFile], { encoding: 'utf8' });
    // diff exits 0 (identical), 1 (differ), 2 (error)
    if (result.status === 2) {
      throw new Error(`diff error: ${result.stderr}`);
    }
    return result.stdout || '';
  } finally {
    try { unlinkSync(tmpFile); } catch (_) { /* best-effort cleanup */ }
    try { import('node:fs').then(fs => fs.rmdirSync(tmpDir)); } catch (_) { /* */ }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printUsage();
    process.exit(0);
  }

  // Resolve source config path
  const configPath = opts.config
    ? resolve(opts.config)
    : join(ROOT, 'config.yaml');

  if (!existsSync(configPath)) {
    console.error(`Source config not found: ${configPath}`);
    process.exit(2);
  }

  // Output directory = same directory as the source config
  const outDir = dirname(configPath);

  // Parse source with Document API (preserves comments and key order)
  const srcText = readFileSync(configPath, 'utf8');
  const doc = parseDocument(srcText);

  if (doc.errors && doc.errors.length > 0) {
    console.error('YAML parse errors in source config:');
    for (const e of doc.errors) console.error(' ', e.message);
    process.exit(2);
  }

  // BLOCKER fix: pin every hex address to its exact source text BEFORE any clone/emit,
  // so the yaml lib's number resolver can never corrupt it. Also the trust anchor for
  // the integrity assert below (emitted addresses MUST be a subset of source addresses).
  preserveHexScalars(doc, srcText);
  const srcAddrs = addressTokens(srcText);

  const srcMap = doc.contents;

  // Discover shared keys: every top-level key except 'chains' — dynamic, not hard-coded
  const sharedKeys = srcMap.items
    .map(p => p.key.value)
    .filter(k => k !== 'chains');

  // Enumerate chain entries
  const chainsPair = srcMap.items.find(p => p.key.value === 'chains');
  if (!chainsPair) {
    console.error('Source config has no top-level `chains:` key');
    process.exit(2);
  }
  const chainsSeq = chainsPair.value;

  // Generate and write (or check) per-chain configs
  let firstDrift = null;

  for (const chainNode of chainsSeq.items) {
    const chainId = String(chainNode.items.find(p => p.key.value === 'id').value.value);
    const outFile = join(outDir, `config.${chainId}.yaml`);
    const generated = generateChainConfig(doc, chainNode, sharedKeys);

    // HIGH fix — integrity assert (runs in BOTH --check and write modes): every 0x
    // address emitted MUST appear verbatim in the source. The old --check compared
    // generated-vs-on-disk (both from the same corrupting path) so it green-lit mangled
    // addresses; this compares emitted-vs-SOURCE, so no corruption can ever ship.
    const missing = [...addressTokens(generated)].filter(a => !srcAddrs.has(a));
    if (missing.length > 0) {
      console.error(`ADDRESS CORRUPTION in config.${chainId}.yaml — ${missing.length} emitted address(es) absent from source:`);
      for (const m of missing.slice(0, 5)) console.error('  ', m);
      process.exit(3);
    }

    if (opts.check) {
      // --check mode: compare generated vs on-disk
      if (!existsSync(outFile)) {
        console.error(`DRIFT: ${outFile} does not exist (run without --check to generate)`);
        process.exit(1);
      }
      const onDisk = readFileSync(outFile, 'utf8');
      if (onDisk !== generated) {
        firstDrift = { outFile, generated, onDisk };
        break; // stop at first drifting file
      }
    } else {
      // Write mode
      writeFileSync(outFile, generated, 'utf8');
      console.log(`wrote ${outFile}`);
    }
  }

  if (opts.check) {
    if (firstDrift) {
      console.error(`DRIFT: ${firstDrift.outFile} does not match generated content`);
      // Print unified diff (generated vs on-disk, using system diff -u)
      const diff = unifiedDiff(firstDrift.generated, firstDrift.outFile);
      if (diff) process.stdout.write(diff);
      process.exit(1);
    } else {
      console.log('OK: all on-disk configs match generated content');
      process.exit(0);
    }
  }
}

main();
