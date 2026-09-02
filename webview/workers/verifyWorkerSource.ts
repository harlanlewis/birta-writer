/**
 * The verify worker's source, as a string. This module is a STUB: esbuild
 * replaces it at build time with the bundled worker (`verifyWorkerPlugin` in
 * esbuild.mjs), and the page reaches it through a dynamic `import()` so the
 * bundle keeps it in a lazy chunk that loads on the first sync of a large
 * document and never on the launch path. Under Vitest this file is what
 * resolves, the source is empty, and the oracle reports itself unavailable,
 * which is the main-thread path every test drives unless it injects an
 * oracle of its own (`setVerifyOracleForTests`).
 */
export const source = "";
