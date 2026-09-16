/**
 * components/fileExplorer/styles.ts
 *
 * The file explorer's CSS, injected the first time a panel is built rather
 * than shipped in the eager stylesheet.
 *
 * A template string and not a `.css` file for the reason the line-number
 * gutter's is (`components/lineNumbers/styles.ts`): esbuild hoists every
 * stylesheet reachable from the entry into the one render-blocking
 * `webview.css`, dynamic imports included, so a `fileExplorer.css` inside this
 * lazy chunk would still be bytes on every launch. Only a directory window on
 * a host declaring `projectFiles` ever builds this panel; every other launch
 * pays nothing for it. The margin math the OPEN panel imposes on the editor
 * is the one part that does live in `style.css`, beside the TOC math it
 * mirrors, keyed on `body.files-open` so a page without the panel compiles
 * to the values it has today.
 *
 * The drawer, its flyout card, the resize sash and the docked/overlay
 * decision are the shell's (`sidePanel.css`); this styles what the shell
 * holds. The rows borrow the TOC outline's anatomy on purpose: the same
 * 13px caret gutter, the same triangle, the same row radius and hover, so
 * the two sidebars read as one design.
 *
 * `[hidden]` is honoured once, globally, by `ui/chrome.css`; a concealed row
 * gets the attribute and nothing here restates it.
 */

const STYLE_ID = "file-explorer-styles";

export const FILE_EXPLORER_CSS = `
.files-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: var(--ui-space-2);
    padding: var(--ui-space-3) var(--ui-space-4) var(--ui-space-1) var(--ui-space-5);
    min-height: 22px;
    background: var(--vscode-editor-background);
}

.files-header__name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.files-tree {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--ui-space-2) 0 24px;
    outline: none;
}

.files-panel--flyout .files-tree {
    padding: var(--ui-space-2) 0 var(--ui-space-5);
}

/* Type grade from .ui-label (ui/typography.css). Row anatomy is the TOC
   outline's: a fixed caret gutter, then the name, ellipsized. */
.files-row {
    display: flex;
    align-items: center;
    padding: 3px var(--ui-space-4);
    line-height: 1.5;
    cursor: pointer;
    border-radius: var(--ui-radius-s);
    margin: 1px var(--ui-space-2);
    user-select: none;
    white-space: nowrap;
}

.files-row__name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}

.files-caret {
    flex: 0 0 auto;
    align-self: stretch;
    position: relative;
    width: 13px;
    margin-left: -3px;
}

.files-caret::before {
    content: "";
    position: absolute;
    left: 2px;
    top: 50%;
    width: 0;
    height: 0;
    border-left: 5px solid currentColor;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    transform: translateY(-50%) rotate(0deg);
    transition: transform 0.1s ease;
    opacity: 0.6;
    visibility: hidden;
}

/* Every folder shows its toggle: a file tree has no heading rank to reserve
   the persistent affordance for, and a folder with no visible caret reads as
   a file. Open folders point down, closed ones right. */
.files-row--dir .files-caret::before {
    visibility: visible;
}

.files-row--expanded .files-caret::before {
    transform: translateY(-50%) rotate(90deg);
}

/* A file the host hands to another application: still a row, still a
   click, drawn quieter so the promise reads before it is made. */
.files-row--other {
    opacity: 0.55;
}

.files-row--loading,
.files-row--error {
    color: var(--vscode-descriptionForeground);
}

.files-row--loading {
    cursor: default;
}

/* Activating the error row asks again. */
.files-row--error {
    color: var(--vscode-errorForeground);
}

.files-row:hover {
    background: var(--vscode-list-hoverBackground);
}

.files-row--selected,
.files-row--selected:hover {
    color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
    background: var(--vscode-list-activeSelectionBackground);
}

.files-row:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
}

.files-empty {
    padding: var(--ui-space-6) var(--ui-space-5);
    font-size: var(--ui-fs-m);
    color: var(--vscode-descriptionForeground);
    text-align: center;
}
`;

/** Install the panel's rules once. Safe to call on every mount. */
export function ensureFileExplorerStyles(): void {
    if (document.getElementById(STYLE_ID)) { return; }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = FILE_EXPLORER_CSS;
    document.head.appendChild(style);
}
