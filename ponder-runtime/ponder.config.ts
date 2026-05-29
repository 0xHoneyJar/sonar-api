// ponder-runtime/ponder.config.ts
//
// Ponder loads its config from `<rootDir>/<--config>`. With
// `--root ponder-runtime --config ponder.config.ts` (the green-belt
// deployment per Dockerfile.belt-ponder BELT_CONFIG=ponder.config.ts),
// Ponder reads THIS file. To keep the repo-root `ponder.config.ts` as the
// canonical green-belt config surface, this file is a thin re-export — the
// same pattern as ponder-runtime/ponder.config.mibera.ts (blue belt).
//
// Why a re-export (and not a symlink): Docker COPY of symlinks across
// directory boundaries is unreliable on Linux containers, and `vite-node`
// occasionally double-canonicalizes module ids — keep the re-export explicit.

import config from "../ponder.config";
export default config;
