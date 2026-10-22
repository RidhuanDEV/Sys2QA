// @sys2qa/contract — the single implementation of the Sys2QA contract (CON-027, ADR-003).
// Structure comes from /schemas; types are generated from it; semantic rules live in ./validation.
export * from "./schemas.js";
export * from "./validation/index.js";
export type * from "./generated/types.js";
