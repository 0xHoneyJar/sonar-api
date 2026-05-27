// ponder-runtime/ponder.schema.ts
//
// Ponder loads schema from `<rootDir>/ponder.schema.ts`. With
// `--root ponder-runtime`, Ponder reads THIS file. To keep A-1's repo-root
// `ponder.schema.ts` as the canonical schema surface (referenced by index
// parity audit + tooling tests), this file is a thin re-export.
//
// IMPORTANT: schema additions in A-2 (deadLetterEmits, action) are in the
// repo-root file — kept in lockstep here automatically via `export *`.

export * from "../ponder.schema";
