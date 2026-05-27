#!/usr/bin/env node
// T2 derisk — Path ε empirical instrumentation of envio's RpcSource gate.
//
// Source trace (Path C) said gate at getSelectionConfig should pass for chain-1's
// 7-contract single-Transfer 0-filter config (compresses to 1 selection, dynamic=0,
// path A matches at RpcSource.res:338). Production says gate fires anyway. Source-
// vs-runtime contradiction cannot be closed from static reading alone.
//
// This patch wraps getSelectionConfig entry with a console.error log of:
//   - chain.id
//   - selection.eventConfigs.length
//   - per-entry shape (contractName, name, isWildcard, dependsOnAddresses,
//     filterByAddresses, filter result tag + topic1/2/3 lengths)
//
// One gate fire → full runtime evidence → disambiguates remaining hypotheses
// (cross-chain bleed, envio bug, runtime filter registration not visible statically).
//
// Idempotent: skips if MARKER already present.

const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', 'node_modules', 'envio', 'src', 'sources', 'RpcSource.res.mjs');
const MARKER = '/* T2-INSTRUMENT-PATH-EPSILON */';

if (!fs.existsSync(FILE)) {
  console.error('[patch-envio] FILE not found:', FILE);
  process.exit(1);
}

const content = fs.readFileSync(FILE, 'utf8');

if (content.includes(MARKER)) {
  console.log('[patch-envio] already patched, skipping');
  process.exit(0);
}

const target = 'function getSelectionConfig(selection, chain) {\n';

const injection = `function getSelectionConfig(selection, chain) {
  ${MARKER}
  try {
    var __chainId = chain && chain.id !== undefined ? chain.id : (typeof chain === 'object' ? JSON.stringify(chain) : String(chain));
    var __ecs = (selection && selection.eventConfigs) || [];
    var __shape = __ecs.map(function(ec) {
      var __filt;
      try { __filt = ec.getEventFiltersOrThrow(chain); } catch (__e) { __filt = { error: String(__e) }; }
      var __staticShape;
      if (__filt && __filt.TAG === 'Static' && Array.isArray(__filt._0)) {
        __staticShape = __filt._0.map(function(s) {
          return {
            topic0Count: (s && s.topic0 ? s.topic0.length : 0),
            topic1Count: (s && s.topic1 ? s.topic1.length : 0),
            topic2Count: (s && s.topic2 ? s.topic2.length : 0),
            topic3Count: (s && s.topic3 ? s.topic3.length : 0)
          };
        });
      }
      return {
        contractName: ec.contractName,
        name: ec.name,
        isWildcard: !!ec.isWildcard,
        dependsOnAddresses: !!ec.dependsOnAddresses,
        filterByAddresses: !!ec.filterByAddresses,
        filterTag: __filt && __filt.TAG,
        filterStatic: __staticShape,
        filterDynamicType: __filt && __filt.TAG === 'Dynamic' ? typeof __filt._0 : undefined
      };
    });
    console.error('[T2-INSTRUMENT] getSelectionConfig invoked ' + JSON.stringify({
      chainId: __chainId,
      eventConfigsLength: __ecs.length,
      dependsOnAddresses: !!(selection && selection.dependsOnAddresses),
      eventConfigShape: __shape
    }));
  } catch (__instErr) {
    console.error('[T2-INSTRUMENT] introspection failed: ' + String(__instErr));
  }
`;

const patched = content.replace(target, injection);

if (patched === content) {
  console.error('[patch-envio] target string not found in file — pin mismatch?');
  process.exit(2);
}

fs.writeFileSync(FILE, patched);
console.log('[patch-envio] OK — RpcSource.res.mjs patched with T2 instrumentation');
