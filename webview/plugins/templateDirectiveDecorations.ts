/**
 * webview/plugins/templateDirectiveDecorations.ts — the lazy half of the
 * template-directive layer (plugins/templateDirectives.ts holds the eager
 * shell and the reasons). Everything that reads a textblock or builds a
 * decoration is here, loaded by the shell's first post-paint idle pass, so a
 * launch carries only the shell.
 *
 * The CSS is a string injected on load rather than a `.css` import, because
 * esbuild hoists every stylesheet reachable from the entry into the eager
 * `webview.css`, dynamic imports included (`components/gotoLine/styles.ts`).
 * Written flat, since jsdom's CSS parser reads it in the unit tests and
 * refuses native nesting. `noColorLiterals.test.ts` and `chromeTokens.test.ts`
 * both reach this string.
 */
import { AddMarkStep, Decoration, DecorationSet, RemoveMarkStep } from "../pm";
import type { Node as ProseNode, Transaction } from "../pm";
import { countWork } from "../perf";
import { blockDirectives } from "../utils/templateDirectives";
import { touchedRanges } from "./editRanges";
import type { VisibleWindow } from "./visibleRange";

const STYLE_ID = "template-directive-styles";

export const TEMPLATE_DIRECTIVE_CSS = `
/* Source the editor does not run, in the same muted monospace as an html tag
 * chip (docs/DESIGN_PRINCIPLES.md). */
.editor .tpl-directive {
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family);
    font-size: 0.85em;
}

/* A soft break beside a directive that is the whole of its line: it ends the
 * line instead of drawing as a space. Zero height, so it adds no gap, and its
 * space is clipped rather than left at the start of the next line. */
.editor .tpl-line-break {
    display: block;
    height: 0;
    overflow: hidden;
}

/* An html atom inside a directive shows its bytes, not the tag it would render
 * as (usually nothing), so the directive reads whole. The editing face keeps
 * its source panel. */
.editor .html-inline[data-tpl-source]:not(.html-inline--editing) {
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family);
    font-size: 0.85em;
}

.editor .html-inline[data-tpl-source]:not(.html-inline--editing) > :not(.html-src-panel) {
    display: none;
}

.editor .html-inline[data-tpl-source]:not(.html-inline--editing)::before {
    content: attr(data-tpl-source);
}
`;

/** Install the rules once. Idempotence is read off the DOM. */
export function ensureTemplateDirectiveStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = TEMPLATE_DIRECTIVE_CSS;
    document.head.appendChild(style);
}

/** The decorations for one textblock whose content starts at `start`. */
function blockDecorations(block: ProseNode, start: number): Decoration[] {
    const { directives, lineBreaks } = blockDirectives(block, start);
    const out: Decoration[] = [];
    for (const d of directives) {
        out.push(Decoration.inline(d.from, d.to, { class: "tpl-directive" }));
        // The atom's bytes go on an attribute rather than a class: the html
        // NodeView rewrites its own className whenever it repaints.
        for (const atom of d.atoms) {
            out.push(Decoration.node(atom.pos, atom.pos + 1, { "data-tpl-source": atom.value }));
        }
    }
    for (const pos of lineBreaks) {
        out.push(Decoration.node(pos, pos + 1, { class: "tpl-line-break" }));
    }
    return out;
}

/** Every textblock between `from` and `to`, each visited once. */
function forTextblocks(doc: ProseNode, from: number, to: number, cb: (node: ProseNode, pos: number) => void): void {
    doc.nodesBetween(from, to, (node, pos) => {
        if (node.isTextblock) {
            cb(node, pos);
            return false;
        }
        return true;
    });
}

/** The whole set for a window (or the document, when it is null). */
export function buildDirectiveSet(doc: ProseNode, window: VisibleWindow | null): DecorationSet {
    const from = window ? Math.max(0, window.from) : 0;
    const to = window ? Math.min(doc.content.size, window.to) : doc.content.size;
    const decos: Decoration[] = [];
    let blocks = 0;
    forTextblocks(doc, from, to, (node, pos) => {
        blocks++;
        decos.push(...blockDecorations(node, pos + 1));
    });
    countWork("template-directives", { blocks });
    return decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty;
}

/**
 * The ranges a mark step touched. A mark step changes no positions, so its
 * step map is empty and `touchedRanges` never names it, but adding or
 * removing inline code makes or unmakes a directive.
 */
function markRanges(tr: Transaction): Array<{ from: number; to: number }> {
    const out: Array<{ from: number; to: number }> = [];
    tr.steps.forEach((step, i) => {
        if (!(step instanceof AddMarkStep || step instanceof RemoveMarkStep)) return;
        const rest = tr.mapping.slice(i + 1);
        out.push({ from: rest.map(step.from, -1), to: rest.map(step.to, 1) });
    });
    return out;
}

/**
 * `set`, already mapped through `tr`, with the textblocks the transaction
 * touched inside `window` redone. Proportional to the edit: the ranges come
 * from the transaction's own step maps (plugins/editRanges.ts).
 */
export function redoTouched(set: DecorationSet, tr: Transaction, window: VisibleWindow | null): DecorationSet {
    const doc = tr.doc;
    const seen = new Set<number>();
    for (const range of [...touchedRanges(tr), ...markRanges(tr)]) {
        // The window is judged against the BLOCK, not the range: a block that
        // straddles the window's edge was decorated whole, so an edit to its
        // off-screen part still owes it a redo.
        // Clamping both ends into the window keeps the walk to the window
        // while still reaching a block that straddles its edge.
        const lo = window ? Math.min(Math.max(range.from, window.from), window.to) : range.from;
        const hi = window ? Math.min(Math.max(range.to, window.from), window.to) : range.to;
        forTextblocks(doc, lo, hi, (node, pos) => {
            if (window && (pos + node.nodeSize <= window.from || pos >= window.to)) return;
            if (seen.has(pos)) return;
            seen.add(pos);
            set = set.remove(set.find(pos + 1, pos + node.nodeSize - 1));
            const fresh = blockDecorations(node, pos + 1);
            if (fresh.length) set = set.add(doc, fresh);
        });
    }
    countWork("template-directives", { blocks: seen.size });
    return set;
}
