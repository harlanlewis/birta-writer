/**
 * components/lineNumbers/styles.ts
 *
 * The line-number gutter's CSS, injected on first enable instead of shipping in
 * the eager stylesheet.
 *
 * **Why this is a template string and not a `.css` file.** esbuild collects
 * every stylesheet reachable from the webview entry into the single
 * render-blocking `webview.css` — including ones reached only through a dynamic
 * `import()`. (That is why KaTeX's stylesheet is a separate entry point; see
 * `esbuild.mjs`.) So a `lineNumbers.css` would be bytes on the launch path for
 * everyone, and `birta.lineNumbers` is OFF by default: the overwhelming
 * majority of launches would pay for a feature they never turn on. A `<style>`
 * injected at enable time costs those launches exactly nothing.
 *
 * A `<style>` rather than a lazily-linked stylesheet for the same reason the
 * find bar's highlight rules are (`findBar/highlightStyles.ts`): a `<link>`
 * loads asynchronously and would paint the first numbers unstyled. Inline text
 * applies synchronously, and the webview CSP already allows `'unsafe-inline'`
 * for styles.
 *
 * Idempotence is read off the DOM rather than a module flag, so the guard can
 * never disagree with reality.
 *
 * `noColorLiterals.test.ts` and `chromeTokens.test.ts` both reach this string:
 * they extract CSS authored in `.ts` as well as `.css` (MAR-260). What
 * `lineNumberStyles.test.ts` adds is stricter than either — every `font-size`
 * must be a `--ui-fs-*` token (not merely ≥14px) and no raw px length may appear
 * at all — plus the layout invariants and the no-stylesheet-crept-back guard.
 */

/** `id` of the injected element — also the idempotence key. */
const STYLE_ID = "line-number-styles";

/**
 * The gutter's paint.
 *
 * Geometry notes, since three of these are load-bearing rather than cosmetic:
 *
 * - **`position: absolute` with tops in DOCUMENT coordinates.** The numbers
 *   scroll with the content they label, which means scrolling costs no
 *   measurement at all — a viewport-fixed layer would have to re-measure every
 *   line on every scroll frame.
 * - **`height: 0`.** The layer must never be able to affect layout or the
 *   document's scroll extent; its children are absolutely positioned within it.
 * - **`pointer-events: none`.** The start margin is where marquee block
 *   selection begins (`docs/DESIGN_PRINCIPLES.md` → "The marquee acquires; it
 *   never steals"). The gutter is display only, so it must not intercept.
 *
 * Logical properties throughout (`inset-inline-*`, `text-align: end`) so the
 * gutter lands on the correct edge if the editor ever gains RTL support. It has
 * none today — this is forward-compatibility, not a claim.
 */
export const LINE_NUMBER_CSS = `
.line-number-layer {
    position: absolute;
    top: 0;
    inset-inline-start: var(--ln-inset, var(--ui-space-4));
    width: var(--ln-width, 3ch);
    height: 0;
    z-index: 1;
    pointer-events: none;
    user-select: none;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--ui-fs-xs);
    line-height: 1.5;
    color: var(--vscode-editorLineNumber-foreground);
}

.line-number {
    position: absolute;
    inset-inline-end: 0;
    text-align: end;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
}

/* A docked, OPEN table of contents on the start side owns that edge, so sit
   inside the drawer rather than under it. An overlay drawer deliberately covers
   the document; covering the numbers too is that same promise kept, so it needs
   no rule of its own. */
body.toc-open:not(.toc-right) .line-number-layer {
    --ln-inset: calc(var(--toc-width, 260px) + var(--ui-space-4));
}

/* Docked but collapsed: only the tab strip is at the edge. */
body.toc-docked:not(.toc-open):not(.toc-right) .line-number-layer {
    --ln-inset: calc(var(--toc-tab-width, 20px) + var(--ui-space-4));
}
`;

/** Install the gutter's rules once. Safe to call on every enable. */
export function ensureLineNumberStyles(): void {
    if (document.getElementById(STYLE_ID)) { return; }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = LINE_NUMBER_CSS;
    document.head.appendChild(style);
}
