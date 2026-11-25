/**
 * components/graph/styles.ts
 *
 * The local graph's CSS, injected on the first render rather than shipped in
 * the eager stylesheet: esbuild hoists every stylesheet reachable from the
 * entry into the render-blocking `webview.css`, dynamic imports included, so a
 * `.css` file in this lazy chunk would be paid on every launch
 * (components/fileExplorer/styles.ts has the same note).
 *
 * The drawing vocabulary, declared once so it cannot accumulate: a dot's SIZE
 * says how connected the note is; its HUE says its OKF `type`, from the
 * theme's chart colours with the two warning hues last so a type does not read
 * as an alarm; an OUTLINED dot is a reference that resolves to no note. This
 * note is the one drawn in the focus colour, at the centre. Staleness and
 * status stay out of the drawing: words carry them elsewhere
 * (components/frontmatter/provenance.ts gives the reason).
 */

const STYLE_ID = "local-graph-styles";

export const LOCAL_GRAPH_CSS = `
.lg {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    overflow: auto;
}

.lg-stage {
    position: relative;
    width: 100%;
    aspect-ratio: 1;
    margin-block: var(--ui-space-2);
}

.lg-lines {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
}

.lg-line {
    stroke: var(--vscode-editorWidget-border);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
    fill: none;
}

.lg-stage--lit .lg-line {
    opacity: 0.25;
}

.lg-stage--lit .lg-line.lg-lit {
    opacity: 1;
    stroke: var(--vscode-focusBorder);
}

/* The outer tier waiting for its parent (ringStage.ts \`tierFor\`): drawn,
   so it can fade in where it belongs, and out of the way until then. */
.lg-node--tier,
.lg-line--tier {
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease;
}

.lg-node--tier.lg-tier-open,
.lg-stage--lit .lg-line--tier.lg-tier-open {
    opacity: 1;
    pointer-events: auto;
}

/* The button's box is the dot (plus a margin to hit), centred on the layout
   point, so a line meets the dot and not the middle of dot and label. The
   label hangs below it, outside the box. */
.lg-node {
    position: absolute;
    transform: translate(-50%, -50%);
    display: flex;
    padding: 3px;
    border: none;
    border-radius: var(--ui-radius-s);
    background: none;
    color: var(--vscode-foreground);
    font-size: var(--ui-fs-xs);
    line-height: 1.2;
    cursor: pointer;
}

.lg-node:disabled,
.lg-node--self {
    cursor: default;
}

.lg-dot {
    width: 8px;
    height: 8px;
    border-radius: var(--ui-radius-pill);
    background: var(--vscode-descriptionForeground);
    border: 1.5px solid transparent;
    box-sizing: border-box;
}

/* A note nothing has touched in a long while (folderSignals.ts, activity
   under DORMANT_BELOW): the same dot, faded, so a drawing of a folder shows
   which of its corners are still in use without a second mark to learn.
   Hover and focus bring it back to full ink, since then it is being looked at. */
.lg-node--dormant:not(:hover, :focus-visible) :is(.lg-dot, .lg-label) {
    opacity: 0.4;
}

.lg-size-2 .lg-dot { width: 10px; height: 10px; }
.lg-size-3 .lg-dot { width: 12px; height: 12px; }
.lg-size-4 .lg-dot { width: 14px; height: 14px; }

.lg-hue-0 .lg-dot { background: var(--vscode-charts-blue); }
.lg-hue-1 .lg-dot { background: var(--vscode-charts-purple); }
.lg-hue-2 .lg-dot { background: var(--vscode-charts-green); }
.lg-hue-3 .lg-dot { background: var(--vscode-charts-orange); }
.lg-hue-4 .lg-dot { background: var(--vscode-charts-yellow); }
.lg-hue-5 .lg-dot { background: var(--vscode-charts-red); }

.lg-node--dangling .lg-dot {
    background: none;
    border-color: var(--vscode-descriptionForeground);
}

.lg-node--self .lg-dot {
    width: 14px;
    height: 14px;
    background: var(--vscode-focusBorder);
}

/* Up to two lines, centred under the dot, at a width a title of a few
   words fits in; past two lines it is cut, and the whole name is the
   node's hover and its accessible name. */
.lg-label {
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    width: max-content;
    max-width: 11em;
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    white-space: normal;
    overflow-wrap: anywhere;
    text-align: center;
    color: var(--vscode-foreground);
}

.lg-node--dangling .lg-label {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
}

.lg-node--self .lg-label {
    font-weight: 600;
}

/* A label the drawing had no room for: named on hover and focus, above the
   rest, on the ground every floating chrome paints so it reads over the lines. */
.lg-label--crowded {
    display: none;
}

.lg-node:hover,
.lg-node:focus-visible {
    z-index: 1;
}

.lg-node:hover .lg-label--crowded,
.lg-node:focus-visible .lg-label--crowded {
    display: block;
    background: var(--ui-card-bg);
    border-radius: var(--ui-radius-s);
    padding-inline: var(--ui-space-1);
}

.lg-node:hover .lg-label,
.lg-node:focus-visible .lg-label {
    text-decoration: underline;
}

.lg-node:disabled:hover .lg-label,
.lg-node--self:hover .lg-label {
    text-decoration: none;
}

.lg-caption,
.lg-legend {
    color: var(--vscode-descriptionForeground);
    font-size: var(--ui-fs-xs);
    padding-inline: var(--ui-space-2);
}

.lg-legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--ui-space-1) var(--ui-space-3);
    padding-block: var(--ui-space-1) var(--ui-space-2);
}

.lg-legend-item {
    display: inline-flex;
    align-items: center;
    gap: var(--ui-space-1);
}

.lg-legend-item .lg-dot {
    width: 8px;
    height: 8px;
}

/* A centre that is a note to go to (the folder overview's hub) rather than
   the note on screen: it opens, so it reads as a link like every other dot. */
.lg-node--self.lg-node--opens {
    cursor: pointer;
}

.lg-node--self.lg-node--opens:hover .lg-label {
    text-decoration: underline;
}

/* ── The folder overview (folderOverview.ts) ── */

/* On its surface, which is set in the document's area: one column, a little
   way down the window rather than against the bar, so the view reads as a
   page and not as a menu hanging off the toolbar. The air shrinks with the
   window and the column scrolls only when even that is too short. */
.fo-surface .fs-content {
    align-items: flex-start;
    overflow-y: auto;
    box-sizing: border-box;
    padding: clamp(var(--ui-space-4), 8vh, 72px) var(--ui-space-4) var(--ui-space-5);
}

.fo {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: min(100%, 560px);
    margin-inline: auto;
    color: var(--vscode-foreground);
    font-size: var(--ui-fs-s);
}

/* The folder's name, inset with the rows so the column has one left edge. */
.fo-title {
    margin: 0 0 var(--ui-space-3);
    padding-inline: var(--ui-space-2);
    font-size: var(--ui-fs-l);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* The drawing comes last, after the lists, and is never taller than a
   little over half the viewport. */
.fo .lg-stage {
    width: min(100%, 55vh);
    align-self: center;
    margin-block-start: var(--ui-space-5);
}

.fo-heading {
    margin-block-start: var(--ui-space-4);
    padding-inline: var(--ui-space-2);
}

.fo-recents {
    display: flex;
    flex-direction: column;
}

.fo-empty {
    color: var(--vscode-descriptionForeground);
    padding: var(--ui-space-1) var(--ui-space-2);
}

/* The start view's two ways to a document, on the column's left edge with
   the rows under them. The primitive carries no padding (it is sized for
   icons), so a text button states its own. */
.fo-actions {
    display: flex;
    gap: var(--ui-space-2);
    padding-inline: var(--ui-space-2);
}

.fo-action {
    min-height: 28px;
    padding: 0 var(--ui-space-5);
    font-size: var(--ui-fs-m);
}

/* A row's name is what it is for, so the name keeps its room and the place
   gives way: the place shrinks first, losing its START, since the folders
   nearest the file are the ones that tell two of a name apart. */
.fo .fg-row-label {
    flex: 0 1 auto;
    min-width: 4em;
}

.fo .fo-row-where {
    flex: 0 1000 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* Right to left only so the overflow, and the ellipsis, fall at the
       start; the text itself is an isolated left-to-right run (the span
       inside), or a leading neutral such as a tilde would be moved to the
       far end of the line. */
    direction: rtl;
}

.fo .fo-row-where > span {
    direction: ltr;
    unicode-bidi: isolate;
}

/* The subject drawn in the square below. A state that sets a background sets
   its foreground in the same rule (DESIGN_PRINCIPLES.md), since a theme may
   fill a selection solidly. Inactive selection, not active: the row says
   which subject is drawn, while keyboard focus may be anywhere. */
.fo-subject[aria-pressed="true"] {
    background: var(--vscode-list-inactiveSelectionBackground);
    color: var(--vscode-list-inactiveSelectionForeground);
}

.fo-subject[aria-pressed="true"] .fg-row-label {
    font-weight: 600;
}

/* Open Recent… closes the reader's list, in the list's own row shape and set
   apart in the quieter ink, as the way past it rather than one more file. */
.fo-more {
    color: var(--vscode-descriptionForeground);
}

/* ── The whole-folder view (folderView.ts), on the fullscreen surface ── */

/* The lists on the left, under the title's band, and the drawing on the
   right, where the shell floats its actions (top) and navigation (bottom):
   both clusters then sit over the canvas they control, never over a list. */
.fg {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
}

.fg-stage {
    grid-column: 2;
    grid-row: 1;
    position: relative;
    min-width: 0;
    min-height: 0;
}

.fg-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    cursor: grab;
    touch-action: none;
}

.fg-hover {
    position: absolute;
    pointer-events: none;
    padding: 2px var(--ui-space-2);
    border-radius: var(--ui-radius-s);
    background: var(--ui-card-bg);
    color: var(--vscode-foreground);
    font-size: var(--ui-fs-s);
    white-space: nowrap;
}

.fg-side {
    overflow-y: auto;
    grid-column: 1;
    grid-row: 1;
    border-inline-end: 1px solid var(--vscode-panel-border);
    padding: var(--fs-band) var(--ui-space-3) var(--ui-space-3);
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-1);
    color: var(--vscode-foreground);
    font-size: var(--ui-fs-s);
}

.fg-search {
    width: 100%;
    box-sizing: border-box;
    padding: var(--ui-space-1) var(--ui-space-2);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: var(--ui-radius-s);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font: inherit;
}

.fg-types {
    display: flex;
    flex-wrap: wrap;
    gap: var(--ui-space-1);
    padding-block: var(--ui-space-1);
}

.fg-type {
    display: inline-flex;
    align-items: center;
    gap: var(--ui-space-1);
}

.fg-summary,
.fg-empty {
    color: var(--vscode-descriptionForeground);
    padding-block: var(--ui-space-1);
}

.fg-heading {
    margin-block-start: var(--ui-space-3);
}

.fg-list {
    display: flex;
    flex-direction: column;
}

.fg-row {
    display: flex;
    justify-content: space-between;
    gap: var(--ui-space-2);
    text-align: start;
}

.fg-row[aria-disabled="true"] {
    cursor: default;
}

.fg-row-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.fg-row-detail {
    color: var(--vscode-descriptionForeground);
    font-variant-numeric: tabular-nums;
}
`;

/** Put the stylesheet on the page once, the first time a graph is drawn. */
export function ensureLocalGraphStyles(doc: Document = document): void {
    if (doc.getElementById(STYLE_ID)) { return; }
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = LOCAL_GRAPH_CSS;
    doc.head.appendChild(style);
}
