# Over-Engineering Audit + Shortcut Ledger

> `/ride --enriched` Phase 15 · 2026-07-19 · report only, no fixes

## Ranked over-engineering findings

1. `yagni`: Triple product naming (`envio-indexer` / `thj-indexer` / `freeside-sonar`) increases onboarding cognitive load. Document alias map; don't rename packages mid-flight. [`package.json:2`, `config.yaml`, `README.md`]
2. `shrink`: 101 legacy markdown files outside grimoires — high doc surface vs reality hub. Prefer routing agents to `reality/` + active PRD. [`legacy/doc-files.txt`]
3. `yagni`: Dual belt entry (`EventHandlers.ts` + mibera) is justified by deploy topology — keep, but ensure SCALE.md stays the checklist. [`src/EventHandlers.ts`, `src/belts/mibera/`]
4. `stdlib`: `@types/node@20` while engines ≥22 — tiny types lag; bump when convenient. [`package.json:33,69`]
5. `delete?`: Commented contract blocks in `config.yaml` — confirm still needed before pruning. [`config.yaml` ~195+]

net: documentation/cognitive cut preferred over code deletion this pass. ~0 deps removable without product decision.

## loa:shortcut: debt ledger

`src/handlers/seaport.ts:157` — chainId carried on every SALE/PURCHASE row so Sprint-2 S4 projection must filter/carry chainId and must NOT hard-filter `chainId IN (80094,8453)`. ceiling: MintActivity.id omits chainId. upgrade: when SALE projection is chain-aware end-to-end.

`Dockerfile.belt:50` — single baked `NODE_OPTIONS=--max-old-space-size=12288` default (24GB/6-chain sized). ceiling: smaller boxes need per-container override. upgrade: when multi-size belt fleet needs image variants.

`scripts/split-belt-config.mjs:235` — ACCEPTED-LOW yaml lib attaches next chain header comment into node. ceiling: harmless (Envio ignores). upgrade: if split output must be comment-perfect for humans.

**3 markers, 0 no-trigger** (each states ceiling + upgrade/accepted rationale).
