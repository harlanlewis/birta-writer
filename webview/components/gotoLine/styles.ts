/**
 * components/gotoLine/styles.ts
 *
 * The Go to Line prompt's CSS, injected on first open instead of shipping in
 * the eager stylesheet, for the reason the shortcuts overlay's is
 * (`shortcutsHelp/styles.ts`): esbuild hoists every stylesheet reachable from
 * the entry into the one render-blocking `webview.css`, dynamic imports
 * included, and this is a prompt most launches never open. Written flat
 * rather than nested because jsdom's CSS parser reads this text in the unit
 * tests and refuses native nesting.
 *
 * `noColorLiterals.test.ts` and `chromeTokens.test.ts` both reach this string.
 */

/** `id` of the injected element, and the idempotence key. */
const STYLE_ID = "goto-line-styles";

export const GOTO_LINE_CSS = `
/* ── Go to Line: a one-field prompt under the bar, centred like a quick
 * input rather than docked at the trailing edge like the find bar: it asks
 * one question and goes away, and a reader's eye is at the text, not at the
 * corner. The card recipe, because it floats over the document. Same z band
 * as the find bar (findBar.css): above the sticky heading, below the bar and
 * its menus. */
.goto-line {
    position: fixed;
    top: calc(var(--editor-topbar-height, 40px) + 6px);
    left: 50%;
    transform: translate(-50%, -4px);
    z-index: 1180;
    width: min(360px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-1);
    padding: var(--ui-space-2);
    background: var(--ui-card-bg);
    border: 1px solid var(--vscode-editorWidget-border);
    border-radius: var(--ui-radius-l);
    box-shadow: var(--ui-card-shadow);
    color: var(--vscode-editorWidget-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--ui-fs-l);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.1s ease, transform 0.1s ease;
}

.goto-line--visible {
    opacity: 1;
    transform: translate(-50%, 0);
    pointer-events: auto;
}

.goto-line__input {
    width: 100%;
    box-sizing: border-box;
    padding: var(--ui-space-2) var(--ui-space-3);
    /* The input border is one of the colours a theme may leave unset
       (optionalColorFallbacks.test.ts): the panel border stands in. */
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: var(--ui-radius-m);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font: inherit;
    outline: none;
}

.goto-line__input:focus {
    border-color: var(--vscode-focusBorder);
}

.goto-line__input::placeholder {
    color: var(--vscode-input-placeholderForeground);
}

/* What the number typed will do, or why it will not: read by assistive tech
 * as the field's description, and drawn under it for everyone else. */
.goto-line__hint {
    padding: 0 var(--ui-space-3) var(--ui-space-1);
    font-size: var(--ui-fs-m);
    color: var(--vscode-descriptionForeground);
}

.goto-line__hint--refused {
    color: var(--vscode-errorForeground);
}
`;

/** Install the prompt's rules once. Safe to call on every open. */
export function ensureGotoLineStyles(): void {
    if (document.getElementById(STYLE_ID)) { return; }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = GOTO_LINE_CSS;
    document.head.appendChild(style);
}
