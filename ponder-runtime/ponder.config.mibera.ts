// ponder-runtime/ponder.config.mibera.ts
//
// Ponder loads its config from `<rootDir>/ponder.config.mibera.ts`. With
// `--root ponder-runtime`, Ponder reads THIS file. To keep A-1's repo-root
// `ponder.config.mibera.ts` as the canonical contract surface (referenced by
// tooling tests + the index-parity audit), this file is a thin re-export.
//
// Why a re-export (and not a symlink): Docker COPY of symlinks across
// directory boundaries is unreliable on Linux containers, and `vite-node`
// occasionally double-canonicalizes module ids — better to keep the
// re-export explicit.
//
// Per cookbook §C-1: `database.schema` is NOT a config key. Schema namespace
// MUST be set via `DATABASE_SCHEMA=ponder` env or `--schema ponder` CLI.

import config from "../ponder.config.mibera";
export default config;
