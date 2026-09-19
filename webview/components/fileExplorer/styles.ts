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
/* The card is the surface; the panel is its box. The panel keeps a strip of
   page along its trailing edge (the card's margin) and that strip is where
   the resize sash draws its line: on the panel's edge, as every drawer's
   sash is, and so standing off the card's rounded edge rather than lying
   along it, which read as a border the card had grown on one side. The
   panel's far edge, the number the content's margin and the formatting row
   read, is unchanged; the card gives the strip up from its own width. */
.files-card {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
}

/* The card's own ground: the sidebar shade, a step off the page in either
   theme (darker on light, lighter on dark; the host palette derives it from
   the widget ground so a theme keeps the two apart), with the small radius of
   a surface set into the window rather than the one a floating card takes.
   The inset from the window's edges is the shell's (SIDE_PANEL_INSET in
   components/sidePanel/shell.ts, which the outline's card takes too), and it
   is what makes the ground and the radius visible at all: flush to the frame,
   a rounded corner has nothing to be rounded against. Docked and overlay
   alike, and not the flyout, which is a card of the shell's own. */
.files-panel:not(.files-panel--flyout) .files-card {
    /* The shade unless a host says otherwise. --files-panel-ground is this
       card's ground and nothing else's, so a host that wants the file list
       to read as page (the Mac app's Transparent file list sidebar) declares
       it without touching the palette's own sideBar shade. That shade has
       another reader of its own, the hidden toolbar's tab, and is what the
       outline's ground is set TO when a host asks for one. */
    background: var(--files-panel-ground, var(--vscode-sideBar-background));
    /* Rounded where it stands in from the window and square where it does
       not. The drawer is flush with the chrome above it (SIDE_PANEL_INSET is
       the sides and the foot, never the top), and a rounded corner with
       nothing between it and the bar leaves two notches of page under the
       toolbar that read as a rendering fault rather than as a shape. */
    border-radius: 0 0 var(--ui-radius-l) var(--ui-radius-l);
    margin-right: var(--ui-space-3);
}

.files-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: var(--ui-space-2);
    padding: var(--ui-space-3) var(--ui-space-4) var(--ui-space-1) var(--ui-space-5);
    min-height: 22px;
}

/* The root's name, quieter than the rows under it: it is where the tree
   is, not something in it, and drawn in the tree's own ink it read as the
   first and heaviest row. */
.files-header__name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--vscode-descriptionForeground);
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
   click, drawn quieter so the promise reads before it is made. The dimming
   is on the name and the caret, not the row: a row's opacity is a group,
   and the chip below is inside it, where it would be drawn at the same
   strength as the words it exists to be read over. */
.files-row--other {
    position: relative;
}

.files-row--other .files-row__name,
.files-row--other .files-caret {
    opacity: 0.55;
}

/* And, under the pointer or the keyboard, what it is: the extension, in a
   chip over the name's trailing end. Over rather than beside, because a
   long name has already taken the row and the ellipsis hides the one part
   that said what the file was; a chip laid on the name's end is what the
   name could not show. Only for a row the host hands elsewhere, whose click
   is the promise the chip lets a reader judge; an openable file's row says
   nothing new. */
.files-row--other[data-ext]:is(:hover, :focus-visible)::after {
    content: attr(data-ext);
    position: absolute;
    right: var(--ui-space-2);
    top: 50%;
    transform: translateY(-50%);
    padding: 0 var(--ui-space-2);
    border-radius: var(--ui-radius-s);
    font-size: var(--ui-fs-xs);
    line-height: 1.6;
    letter-spacing: 0.04em;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    pointer-events: none;
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

/* The selected row is the open file, and it stays selected while the reader
   types in the document. Lit in the accent only while the keyboard is in the
   tree; the rest of the time it is the quiet grey a sidebar's selection turns
   when focus leaves it, so a saturated block does not sit beside the text
   being written. */
.files-row--selected,
.files-row--selected:hover {
    color: var(--vscode-list-inactiveSelectionForeground);
    background: var(--vscode-list-inactiveSelectionBackground);
}

.files-tree:focus-within .files-row--selected,
.files-tree:focus-within .files-row--selected:hover {
    color: var(--vscode-list-activeSelectionForeground);
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
