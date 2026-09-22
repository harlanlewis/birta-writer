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

.lg-arrow {
    fill: var(--vscode-editorWidget-border);
}

.lg-stage--lit .lg-line,
.lg-stage--lit .lg-arrow {
    opacity: 0.25;
}

.lg-stage--lit .lg-line.lg-lit {
    opacity: 1;
    stroke: var(--vscode-focusBorder);
}

.lg-stage--lit .lg-arrow.lg-lit {
    opacity: 1;
    fill: var(--vscode-focusBorder);
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

.lg-label {
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    max-width: 7.5em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
`;

/** Put the stylesheet on the page once, the first time a graph is drawn. */
export function ensureLocalGraphStyles(doc: Document = document): void {
    if (doc.getElementById(STYLE_ID)) { return; }
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = LOCAL_GRAPH_CSS;
    doc.head.appendChild(style);
}
