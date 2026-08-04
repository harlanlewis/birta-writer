/**
 * The find bar's `::highlight()` rules, injected on first use instead of
 * shipping in the eager stylesheet.
 *
 * **Why these three rules are not in `findBar.css`.** A `::highlight(name)`
 * rule is not free just because nothing is highlighted. Blink resolves a
 * highlight style for *every registered custom highlight name* as part of
 * resolving *every element's* style, whether or not any `Range` has been put
 * in `CSS.highlights` — so the per-element cost of style recalc scales with
 * how many highlight names the document's stylesheets mention, and on a large
 * document that lands squarely on the mount path (ProseMirror's first DOM
 * build, then the first style/layout/paint).
 *
 * Measured, not reasoned: adding one four-line rule —
 * `::highlight(find-scope)` — to the eager `findBar.css` cost the `large`
 * launch fixture +31 ms and +33.6 ms across two interleaved A/B passes
 * (+3.4% / +3.7%), split about evenly between the `create` and `paint` spans,
 * and failed the blocking `launch-perf` gate twice on CI. No JavaScript ran:
 * the identical bundle with only that rule removed was flat.
 *
 * So the rules live here and are injected the first time the find bar actually
 * paints a highlight. Everyone who never opens Find pays nothing, and someone
 * who does pays one style recalc at that moment rather than on every launch.
 *
 * Two deliberate choices:
 *
 * - **A `<style>` element, not a `<link>` to a lazily-emitted CSS entry** (the
 *   `katexLoader.ts` pattern). A stylesheet link loads asynchronously, which
 *   would paint the first search's matches unstyled for a frame or more.
 *   Inline text applies synchronously. `style-src` in the webview CSP allows
 *   `'unsafe-inline'`, so this needs no new CSP grant.
 * - **Idempotence is read off the DOM**, not a module flag, so the guard can
 *   never disagree with reality (and a test can exercise it more than once).
 *
 * `noColorLiterals.test.ts` and `chromeTokens.test.ts` reach this string: both
 * extract CSS authored in `.ts` as well as `.css` (MAR-260), so the repo-wide
 * color and chrome-token rules apply here with no per-file guard needed.
 * `findHighlightStyles.test.ts` covers what those cannot — that a `::highlight()`
 * rule has not reappeared in `findBar.css`, and that every registered name has
 * exactly one rule.
 */

/** `id` of the injected element — also the idempotence key. */
const STYLE_ID = "find-highlight-styles";

/**
 * The find bar's highlight paint. `find-scope` is the find-in-selection range
 * (MAR-106) and is registered at a lower priority than the match highlights,
 * so a match inside the scope always paints on top.
 */
export const FIND_HIGHLIGHT_CSS = `
::highlight(find-scope) {
    background-color: var(--vscode-editor-findRangeHighlightBackground);
    color: inherit;
}

::highlight(find-highlight) {
    background-color: var(--vscode-editor-findMatchHighlightBackground);
    color: inherit;
}

::highlight(find-highlight-current) {
    background-color: var(--vscode-editor-findMatchBackground);
    color: inherit;
}
`;

/**
 * Install the highlight rules if they are not already in the document. Called
 * from `setHighlight` in `index.ts`, the single funnel every
 * `CSS.highlights.set()` passes through — so the rules arrive exactly when
 * there is something to paint, and it is a hash lookup on every later call.
 */
export function ensureFindHighlightStyles(): void {
    if (typeof document === "undefined" || !document.head) {
        return;
    }
    if (document.getElementById(STYLE_ID)) {
        return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = FIND_HIGHLIGHT_CSS;
    document.head.appendChild(style);
}
