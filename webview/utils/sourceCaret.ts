/**
 * sourceCaret.ts
 *
 * Maps a caret between the rendered document and the Markdown source, so that
 * switching modes (Cmd+Shift+M, "Edit Raw Markdown", a global-search hit) lands
 * the cursor where the user left it rather than at the top of the file.
 *
 * The exchange runs through `lineMap` (shared/lineMap.ts), which is **block**
 * granular: one entry per source paragraph-group, with a fenced code block
 * counted as a single unit. Entry `i` is *nominally* `doc.child(i)`, the
 * assumption the scroll path has always made — but it is only nominal, so
 * `blockIndexForSourceLine` verifies the pairing against the document's own
 * text before trusting it (see its contract).
 *
 * Within a block this module refines the position two ways, and both are
 * deliberately conservative — a wrong caret is worse than a coarse one:
 *
 * - **Line**: a code block's text carries its own newlines, and a block holding
 *   several textblocks (a tight list) has one per source line, so the anchors
 *   below enumerate a block's source lines in order.
 * - **Column**: exact when the source line and the rendered text agree up to a
 *   leading marker (`# `, `- `, `> `, indentation) — plain prose, headings,
 *   list items, code. When inline markup makes them diverge (emphasis, links,
 *   inline code), the rendered text is aligned to the source line as a greedy
 *   subsequence — the renderer only ever DROPS characters, never reorders them
 *   — and the column is where the caret's character actually sits in the
 *   source. Only when the rendered text cannot be embedded in the line at all
 *   (an image's alt text, math) does the column degrade to the line start.
 */

import type { Node } from "../pm";

/** A caret in the Markdown source: 1-indexed line, 0-indexed column. */
export interface SourceCaret {
    line: number;
    column: number;
}

/**
 * One source line of a block, as the rendered document knows it.
 *
 * `text` is null for a line that exists in the source but has no text position
 * in the document — a code fence. Such a line still needs an anchor so that
 * source→doc mapping can land somewhere sane, but it can never be the answer
 * going the other way.
 */
interface LineAnchor {
    text: string | null;
    /** The textblock this line lives in. */
    node: Node;
    /** Doc position of the textblock's content start. */
    contentStart: number;
    /** Offset of this line's text within that content. */
    offset: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/** Enumerate the source lines a top-level block covers, in document order. */
function lineAnchors(block: Node, blockStart: number): LineAnchor[] {
    const anchors: LineAnchor[] = [];
    const addTextblock = (node: Node, nodeStart: number): void => {
        const contentStart = nodeStart + 1;
        if (node.type.spec.code) {
            // The opening fence occupies the block's first source line and has
            // no text position; anchor it to the start of the code instead.
            anchors.push({ text: null, node, contentStart, offset: 0 });
            let offset = 0;
            for (const line of node.textContent.split("\n")) {
                anchors.push({ text: line, node, contentStart, offset });
                offset += line.length + 1;
            }
            return;
        }
        // A soft-wrapped paragraph spans several source lines inside ONE
        // textblock; its rendered text gives no honest way to tell where the
        // author's newlines were, so it counts as a single line.
        anchors.push({ text: node.textContent, node, contentStart, offset: 0 });
    };

    if (block.isTextblock) {
        addTextblock(block, blockStart);
        return anchors;
    }
    block.descendants((child, relPos) => {
        if (!child.isTextblock) { return true; }
        addTextblock(child, blockStart + 1 + relPos);
        return false;
    });
    return anchors;
}

/** Doc position where `doc.child(index)` starts. */
function blockStartPos(doc: Node, index: number): number {
    let pos = 0;
    for (let i = 0; i < index; i++) {
        pos += doc.child(i).nodeSize;
    }
    return pos;
}

/**
 * The leading source-only prefix of `sourceLine` — the list bullet, heading
 * hashes, blockquote marker or indentation the renderer swallowed. Returns -1
 * when the rendered text isn't a suffix of the source line, which is the signal
 * that no column can be claimed honestly.
 */
function markerWidth(sourceLine: string, text: string): number {
    return sourceLine.endsWith(text) ? sourceLine.length - text.length : -1;
}

/** Doc offset for `textOffset` characters of text following `from` in `node`'s content. */
function docOffsetForText(node: Node, from: number, textOffset: number): number {
    let offset = from;
    let remaining = textOffset;
    node.forEach((child, childOffset) => {
        const end = childOffset + child.nodeSize;
        if (end <= from || remaining <= 0) { return; }
        const start = Math.max(childOffset, from);
        if (child.isText) {
            const take = Math.min(end - start, remaining);
            offset = start + take;
            remaining -= take;
        } else {
            // An inline leaf (image, math, hard break) carries no text: step
            // over it so the remaining characters are counted after it.
            offset = end;
        }
    });
    return offset;
}

/** How many source lines past the contiguous position an anchor may sit. */
const ANCHOR_LOOKAHEAD = 8;

/** Letters and digits only — markup, punctuation, and spacing stripped. */
const normalize = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, "");

/** Shortest normalized probe treated as real evidence for a fuzzy match. */
const MIN_PROBE = 12;
/** Longest normalized probe compared (a soft-wrapped line carries only a prefix). */
const MAX_PROBE = 24;

/**
 * Does this source line render as `text` (or start the block that does)?
 *
 * Exact suffix first — the renderer only drops a leading marker — with
 * trailing whitespace ignored on both sides (a trailing space in the source is
 * invisible in the rendered text but used to fail the match). When inline
 * markup makes rendered and source text diverge (a link drops its URL,
 * emphasis its asterisks), fall back to letters-and-digits-only comparison:
 * the line matches when its normalized text contains the anchor's normalized
 * prefix. A probe shorter than MIN_PROBE once normalized gets no fuzzy match —
 * too little evidence to risk pairing the wrong block.
 */
function lineMatchesAnchor(sourceLine: string, text: string): boolean {
    if (sourceLine.trimEnd().endsWith(text.trimEnd())) { return true; }
    const anchor = normalize(text);
    if (anchor.length < MIN_PROBE) { return false; }
    const line = normalize(sourceLine);
    // Two probe lengths: the long one is strong evidence; the short one
    // rescues lines where markup the renderer dropped (a link's URL) sits
    // inside the long window and breaks adjacency.
    return line.includes(anchor.slice(0, MAX_PROBE)) || line.includes(anchor.slice(0, MIN_PROBE));
}

/**
 * The source line of each anchor, resolved against the source text.
 *
 * A block's lines are only NOMINALLY contiguous from `blockLine`: a loose list
 * is one node whose items sit blank lines (and nested continuations) apart, so
 * `blockLine + index` drifts further with every gap. Each anchor with text is
 * therefore matched forward through the source (the renderer only ever drops a
 * PREFIX — bullet, hashes, indentation — so the line must end with the text);
 * an anchor that can't be matched within the lookahead (inline markup changed
 * the text, a soft-wrapped paragraph) falls back to the contiguous position —
 * exactly the old behavior, never worse.
 */
function anchorLines(anchors: LineAnchor[], blockLine: number, sourceLines: string[]): number[] {
    const lines: number[] = [];
    let cursor = blockLine;
    for (const a of anchors) {
        let line = cursor;
        if (a.text) {
            const limit = Math.min(cursor + ANCHOR_LOOKAHEAD, sourceLines.length);
            for (let l = cursor; l <= limit; l++) {
                const candidate = sourceLines[l - 1];
                if (candidate !== undefined && lineMatchesAnchor(candidate, a.text)) { line = l; break; }
            }
        }
        lines.push(line);
        cursor = line + 1;
    }
    return lines;
}

/**
 * Does a block with these anchors start at source line `blockLine`?
 *
 * The probe is the block's first non-empty line of text: everything the
 * renderer dropped is a PREFIX of the source line (a bullet, hashes, a quote
 * marker, indentation), so the source line must end with it. A block with
 * nothing to probe (an image-only paragraph, a horizontal rule) is taken on
 * trust — there is no evidence either way.
 */
function anchorsFit(anchors: LineAnchor[], blockLine: number, sourceLines: string[]): boolean {
    const probe = anchors.findIndex((a) => a.text);
    if (probe < 0) { return true; }
    const sourceLine = sourceLines[blockLine + probe - 1];
    return sourceLine !== undefined && lineMatchesAnchor(sourceLine, anchors[probe].text!);
}

/**
 * How far to look for the real pairing once the nominal one is disproved: the
 * whole map.
 *
 * Drift comes from nodes that span several source blocks — a loose list is ONE
 * node but one map entry per item — and it is NOT bounded by the map's net
 * surplus of entries over nodes, because the map can also undercount (a block
 * the map skips but the editor renders shifts the ledger the other way; a real
 * document showed local drift 12 against a net surplus of 10). A fixed span
 * silently gave up and reported the nominal (wrong) line as if it were fine.
 * These paths run only on demand (mode switch, scroll-to-line, an agent pull),
 * so scanning every candidate is cheap; candidates stay ordered nearest-first,
 * which keeps the conservative preference for the closest fit.
 */
function reconcileSpan(doc: Node, lineMap: number[]): number {
    return Math.max(lineMap.length, doc.childCount);
}

/**
 * The block index and start line for a source line, reconciled against the
 * document's own text.
 *
 * `lineMap` counts SOURCE blocks and the document counts NODES, and the two
 * drift apart wherever one node spans several source blocks — a loose list
 * (blank lines between items) is one node and one entry per item, so every
 * block after it pairs one entry early, and the drift accumulates. Taking the
 * index on faith puts the caret (and the scroll) in the wrong block entirely.
 *
 * So the nominal pairing is verified, and when it fails, the neighbourhood is
 * searched for one that holds — nearer blocks first, since drift here runs
 * that way (the map has more entries than the document has nodes). When
 * nothing fits, the nominal answer is returned unchanged: no worse than
 * before, and the column guard downstream still refuses to invent a column.
 */
export function blockIndexForSourceLine(
    doc: Node,
    lineMap: number[],
    sourceLines: string[],
    line: number,
): { index: number; blockLine: number } | undefined {
    if (!lineMap.length || !doc.childCount) { return undefined; }
    let entry = 0;
    for (let i = 0; i < lineMap.length; i++) {
        if (lineMap[i] <= line) { entry = i; } else { break; }
    }
    const blockLine = lineMap[entry];
    const nominal = Math.min(entry, doc.childCount - 1);
    // Pass 1: positive evidence — a block whose first text line matches at
    // blockLine. Blocks with nothing to probe (a horizontal rule, an
    // image-only paragraph) are SKIPPED here rather than taken on trust: in a
    // drifted document a no-text nominal used to swallow lines that really
    // belonged to a text block further on, and the caret arrival then found no
    // text position at all.
    const span = reconcileSpan(doc, lineMap);
    for (let step = 0; step <= span; step++) {
        for (const candidate of step === 0 ? [nominal] : [nominal - step, nominal + step]) {
            if (candidate < 0 || candidate >= doc.childCount) { continue; }
            const anchors = lineAnchors(doc.child(candidate), blockStartPos(doc, candidate));
            if (!anchors.some((a) => a.text)) { continue; }
            if (anchorsFit(anchors, blockLine, sourceLines)) {
                return { index: candidate, blockLine };
            }
        }
    }
    // No block STARTS at blockLine — the line may sit INSIDE one (a loose
    // list's later item has its own map entry, but its node began entries
    // earlier). Find the block whose verified start and resolved anchor lines
    // contain the target line; earlier candidates first, since a container
    // starts before the line it contains.
    for (let step = 0; step <= span; step++) {
        for (const candidate of step === 0 ? [nominal] : [nominal - step, nominal + step]) {
            if (candidate < 0 || candidate >= doc.childCount) { continue; }
            const anchors = lineAnchors(doc.child(candidate), blockStartPos(doc, candidate));
            if (!anchors.length) { continue; }
            const start = sourceLineForBlock(doc, lineMap, sourceLines, candidate);
            if (start === undefined || start > line || !anchorsFit(anchors, start, sourceLines)) { continue; }
            const lines = anchorLines(anchors, start, sourceLines);
            if (line <= lines[lines.length - 1]) { return { index: candidate, blockLine: start }; }
        }
    }
    return { index: nominal, blockLine };
}

/** The source line a block index starts at, reconciled the other way round. */
export function sourceLineForBlock(
    doc: Node,
    lineMap: number[],
    sourceLines: string[],
    index: number,
): number | undefined {
    if (index < 0 || index >= doc.childCount) { return undefined; }
    const anchors = lineAnchors(doc.child(index), blockStartPos(doc, index));
    const nominal = lineMap[Math.min(index, lineMap.length - 1)];
    if (nominal === undefined) { return undefined; }
    if (anchorsFit(anchors, nominal, sourceLines)) { return nominal; }
    const span = reconcileSpan(doc, lineMap);
    for (let step = 1; step <= span; step++) {
        for (const candidate of [index + step, index - step]) {
            const line = lineMap[candidate];
            if (line === undefined) { continue; }
            if (anchorsFit(anchors, line, sourceLines)) { return line; }
        }
    }
    return nominal;
}

/**
 * The source caret for a document position, or undefined when the position
 * can't be placed in the line map (an empty map, or a doc/map mismatch).
 */
export function sourceCaretAt(
    doc: Node,
    lineMap: number[],
    sourceLines: string[],
    pos: number,
): SourceCaret | undefined {
    if (!lineMap.length || !doc.childCount) { return undefined; }
    const $pos = doc.resolve(clamp(pos, 0, doc.content.size));
    const blockIndex = clamp($pos.index(0), 0, doc.childCount - 1);
    const blockLine = sourceLineForBlock(doc, lineMap, sourceLines, blockIndex);
    if (blockLine === undefined) { return undefined; }

    const anchors = lineAnchors(doc.child(blockIndex), blockStartPos(doc, blockIndex));
    // The last anchor at or before the caret; fence anchors are skipped because
    // a caret can never sit on one.
    let index = -1;
    for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i];
        if (a.text === null) { continue; }
        if (a.contentStart + a.offset <= pos || index === -1) { index = i; }
    }
    if (index === -1) { return { line: blockLine, column: 0 }; }

    const anchor = anchors[index];
    const line = anchorLines(anchors, blockLine, sourceLines)[index];
    const text = anchor.text ?? "";
    const sourceLine = sourceLines[line - 1];
    if (sourceLine === undefined) { return { line, column: 0 }; }

    const lineEnd = anchor.offset + text.length;
    const offsetInContent = clamp(pos - anchor.contentStart, anchor.offset, lineEnd);
    const textOffset = anchor.node.textBetween(anchor.offset, offsetInContent).length;
    return { line, column: sourceColumnForTextOffset(sourceLine, text, textOffset) ?? 0 };
}

/**
 * The column in `sourceLine` for a caret `textOffset` characters into that
 * line's rendered `text`.
 *
 * Exact case first: the renderer dropped only a leading marker, so the column
 * is the marker's width plus the offset. Otherwise the rendered text is
 * aligned to the source line as a greedy subsequence — markup the renderer
 * dropped (emphasis asterisks, a link's `](url)` tail, backticks) is skipped
 * wherever the characters differ — and the column is where the caret's
 * character landed. If the whole rendered text cannot be embedded in the line,
 * no column is claimed (the caller degrades to the line start).
 */
function sourceColumnForTextOffset(
    sourceLine: string,
    text: string,
    textOffset: number,
): number | undefined {
    const marker = markerWidth(sourceLine, text);
    if (marker >= 0) { return marker + textOffset; }
    // matched[j] = source index where text[j] matched.
    const matched: number[] = [];
    for (let i = 0; i < sourceLine.length && matched.length < text.length; i++) {
        if (sourceLine[i] === text[matched.length]) { matched.push(i); }
    }
    if (matched.length < text.length) { return undefined; }
    if (textOffset <= 0) { return matched[0] ?? 0; }
    if (textOffset >= text.length) { return (matched[text.length - 1] ?? -1) + 1; }
    return matched[textOffset];
}

/**
 * The rendered-text offset for a source `column` in `sourceLine` — the inverse
 * of sourceColumnForTextOffset, under the same exact-then-subsequence rules.
 * Returns 0 (the line's start) when the text cannot be aligned.
 */
function textOffsetForSourceColumn(
    sourceLine: string,
    text: string,
    column: number,
): number {
    const marker = markerWidth(sourceLine, text);
    if (marker >= 0) { return clamp(column - marker, 0, text.length); }
    const matched: number[] = [];
    for (let i = 0; i < sourceLine.length && matched.length < text.length; i++) {
        if (sourceLine[i] === text[matched.length]) { matched.push(i); }
    }
    if (matched.length < text.length) { return 0; }
    // The offset is how many rendered characters sit strictly before the column.
    let j = 0;
    while (j < matched.length && matched[j]! < column) { j++; }
    return j;
}

/**
 * The document position for a source caret, or undefined when the line falls
 * outside the map. The column maps under the same exact-then-subsequence rules
 * as sourceCaretAt; when the text cannot be aligned, the caret lands at the
 * start of the line's text.
 */
export function docPosForSourceCaret(
    doc: Node,
    lineMap: number[],
    sourceLines: string[],
    caret: SourceCaret,
): number | undefined {
    const block = blockIndexForSourceLine(doc, lineMap, sourceLines, caret.line);
    if (!block) { return undefined; }

    const anchors = lineAnchors(doc.child(block.index), blockStartPos(doc, block.index));
    if (!anchors.length) {
        // A block with no text position at all (a horizontal rule): land at
        // its start — the caller's TextSelection.near snaps to the closest
        // valid spot. Returning undefined here left the arrival with NO caret.
        return blockStartPos(doc, block.index);
    }
    // The last anchor at or before the caret's line, by each anchor's RESOLVED
    // line — in a loose list the anchors are not contiguous from blockLine.
    const lines = anchorLines(anchors, block.blockLine, sourceLines);
    let anchorIndex = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] <= caret.line) { anchorIndex = i; } else { break; }
    }
    const anchor = anchors[anchorIndex];
    const lineStart = anchor.contentStart + anchor.offset;
    if (anchor.text === null || caret.column <= 0) { return lineStart; }

    const sourceLine = sourceLines[caret.line - 1];
    if (sourceLine === undefined) { return lineStart; }
    const textOffset = textOffsetForSourceColumn(sourceLine, anchor.text, caret.column);
    return anchor.contentStart + docOffsetForText(anchor.node, anchor.offset, textOffset);
}
