/**
 * Document-position diagnostics: map a ProseMirror caret position back to a
 * line in the original markdown source. Extracted from the (now unused)
 * selectionToolbar so the toolbar's debug helper can import it without pulling
 * that whole module — and its CSS — into the launch bundle.
 */
import type { EditorView } from "../pm";
import type { ResolvedPos } from "../pm";

/** Strip common markdown markers, for fuzzy comparison against the original content */
function normalizeForSearch(s: string): string {
    return s
        .replace(/^#{1,6}\s+/m, "")
        .replace(/\*+/g, "")
        .replace(/~+/g, "")
        .replace(/`/g, "")
        .replace(/^\s*[-*+]\s+/m, "")
        .replace(/^\s*\d+\.\s+/m, "")
        .replace(/^\s*>\s*/gm, "")
        .replace(/\|/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** Get the full text content of the deepest block-level container node at the caret */
export function getBlockContainerText($pos: ResolvedPos): string {
    for (let d = $pos.depth; d >= 1; d--) {
        const node = $pos.node(d);
        if (node.isBlock && node.type.name !== "doc") {
            const text = node.textContent.trim();
            if (text.length >= 3) return text;
        }
    }
    return "";
}

/** Search the original markdown for the line number (1-indexed) containing the block text; return -1 when not found */
export function findLineInOriginalSource(
    source: string,
    blockText: string,
): number {
    if (!blockText || blockText.length < 3) return -1;
    const normalizedBlock = normalizeForSearch(blockText).slice(0, 60);
    if (normalizedBlock.length < 3) return -1;
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (normalizeForSearch(lines[i]).includes(normalizedBlock))
            return i + 1;
    }
    return -1;
}

/** Debug helper: run line-number computation for any doc position and return diagnostic data */
export function sampleDocPosition(
    view: EditorView,
    docPos: number,
    getLineMapFn: () => number[],
    getMarkdownSourceFn: () => string,
): {
    pos: number;
    nodeType: string;
    nodeIdx: number;
    lineMapVal: number | undefined;
    srcAtMap: string;
    line: number;
    via: string;
    pmSnip: string;
    srcAtCalc: string;
    ok: boolean;
} {
    const doc = view.state.doc;
    const pos = Math.max(1, Math.min(docPos, doc.content.size - 1));
    const $from = doc.resolve(pos);
    const depth1Node = $from.depth >= 1 ? $from.node(1) : $from.node(0);
    const nodeType = depth1Node.type.name;
    const nodeIdx = $from.index(0);
    const lineMap = getLineMapFn();
    const lineMapVal = lineMap[nodeIdx];
    const source = getMarkdownSourceFn();
    const srcLines = source.split("\n");
    const srcAtMap =
        lineMapVal !== undefined ? (srcLines[lineMapVal - 1] ?? "") : "";
    const blockText = getBlockContainerText($from);
    let line: number;
    let via: string;
    const found = findLineInOriginalSource(source, blockText);
    if (found !== -1) {
        line = found;
        via = "textSearch";
    } else if (lineMapVal) {
        line = lineMapVal;
        via = "lineMapFallback";
    } else {
        const textBefore = doc.textBetween(0, pos, "\n");
        line = (textBefore.match(/\n/g) ?? []).length + 1;
        via = "countFallback";
    }
    const srcAtCalc = srcLines[line - 1] ?? "";
    const pmSnip = depth1Node.textContent.slice(0, 50);
    const ok = normalizeForSearch(srcAtCalc).includes(
        normalizeForSearch(pmSnip).slice(0, 20),
    );
    return {
        pos,
        nodeType,
        nodeIdx,
        lineMapVal,
        srcAtMap,
        line,
        via,
        pmSnip,
        srcAtCalc,
        ok,
    };
}
