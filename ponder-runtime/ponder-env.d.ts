/// <reference types="ponder/virtual" />

declare module "ponder:internal" {
  const config: typeof import("./ponder.config.mibera.ts");
  const schema: typeof import("./ponder.schema.ts");
}

declare module "ponder:schema" {
  export * from "./ponder.schema.ts";
}

// This file enables type checking and editor autocomplete for the Ponder
// project. The ponder:registry / ponder:api / ponder:schema virtual modules
// are injected at build time by the vite-node runtime — without this file,
// `import { ponder } from "ponder:registry"` fails type resolution.
//
// Equivalent to the spike/ponder-A-0/ponder-env.d.ts (operator-recommended
// pattern per Ponder docs).
