/**
 * The bare `refractor` specifier, rebound to the empty core instance.
 *
 * esbuild redirects every `import ... from "refractor"` in the webview bundle
 * here (see the `refractor-singleton` plugin in `esbuild.mjs`); subpath imports
 * such as `refractor/core` and `refractor/zig` are untouched.
 *
 * The package's bare entry is `refractor/lib/common.js`, which re-exports the
 * very same singleton as `refractor/core` but registers 35 grammars onto it as
 * an import-time side effect — and refractor lists that file in `sideEffects`,
 * so esbuild cannot tree-shake the registrations away. `@milkdown/plugin-prism`
 * imports it, which without this rebinding drags all 35 grammars into the
 * *eager* launch bundle, duplicating a subset of what `highlighterLanguages.ts`
 * already ships in a lazy chunk.
 *
 * Nothing else changes: the instance is identical either way, so the prism
 * plugin keeps highlighting with the same object `highlighter.ts` registers our
 * grammars on. The only observable difference is *when* common's 35 grammars
 * become available — now on the lazy chunk's arrival rather than at boot —
 * which is why `highlighterLanguages.ts` must register a superset of them.
 */
export { refractor } from "refractor/core";
