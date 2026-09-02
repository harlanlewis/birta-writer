/**
 * webview/utils/blockSegmenter.ts — where a markdown text may be CUT so that
 * each piece parses on its own to exactly the blocks it contributes to the
 * whole (MAR-427).
 *
 * Text in, cut points out, and no tree is built: this is not a parser and must
 * not drift into one (`ENGINE_AND_DIALECT_STRATEGY.md` section 4 and MAR-102
 * rule that out). It answers one question for the consumers that need a
 * document in pieces (a static first frame, a progressive open, a windowed
 * verification reparse), and it answers it the same way for all of them, so
 * three conservative-but-different segmenters never exist (MAR-343's history is
 * the warning).
 *
 * THE CONTRACT is the parser's own: for every cut this proposes, parsing the
 * two halves and concatenating their top-level blocks equals parsing the whole,
 * node for node. `blockSegmenter.test.ts` holds every fixture in the corpus to
 * that oracle, cut by cut, and it is the only assertion that can catch a wrong
 * cut. Everything below is an argument for why a cut is safe; the test is the
 * proof.
 *
 * CONSERVATIVE BY CONSTRUCTION. A cut is proposed only where it can be argued
 * from the lines alone; anywhere the argument needs the parser, the cut is
 * withheld, and the worst case is the whole text as one chunk, which is
 * exactly today's behaviour for every consumer. The rules, and the construct
 * each refuses to cut inside:
 *
 * - A cut sits only at a blank line, and the line after it starts at column 0.
 *   Every multi-line construct that can span a blank continues through
 *   indentation (a list item's content, an indented code block), so the
 *   column-0 rule closes all of them at once without knowing which one is open.
 * - Never inside a fenced code block. The fence scanner is the diff engine's
 *   own (`fenceStep` in utils/minimalDiff.ts), the one `lineRoles` already runs
 *   on every merge, so the two cannot disagree about where a fence is.
 * - Never between two list-marker lines while a list is open: a blank between
 *   items of the same list is one loose list, and two lists are a different
 *   tree.
 * - Never inside a raw container that may hold blank lines: an HTML block of
 *   the kinds that end on a closing tag rather than a blank (`<pre>`, comments,
 *   processing instructions, declarations, CDATA), a Notion `<aside>` callout,
 *   a `$$` math block, a `:::` directive container, or a frontmatter block at
 *   the top of the text.
 * - Never anywhere, when the text carries a link reference definition or a
 *   footnote definition outside a fence. A reference in one half resolved by a
 *   definition in the other is a different tree from the whole, and which
 *   references reach which definitions is the parser's question. Such a text
 *   is one chunk, on purpose.
 *
 * What it does NOT promise: that the chunks are of any particular size, that
 * every safe cut in the document is found, or anything about inline content.
 * `segmentBlocks` coalesces cuts into chunks of at least `targetLines`; a
 * consumer wanting a first screen takes the first chunk and asks for more.
 */
import { LIST_MARKER_RE, fenceStep, leadingColumns, type OpenFence } from "./minimalDiff";

/** One piece of the text: `[start, end)` are character offsets, the lines they hold, and the bytes. */
export interface BlockChunk {
    start: number;
    end: number;
    startLine: number;
    endLine: number;
    text: string;
}

/**
 * A link reference definition or a footnote definition, under any run of
 * indentation and blockquote markers: one inside a quote or a list item is as
 * document-scoped as one at column 0, and matching an indented code line that
 * merely looks like one costs a cut, never a wrong one.
 */
const DEFINITION_RE = /^[ \t>]*\[(?:\^[^\]]+|[^\]]+)\]:(?:[ \t]|$)/;

/**
 * The HTML block kinds whose end condition is a closing marker rather than a
 * blank line (CommonMark 4.6, kinds 1 to 5). Kinds 6 and 7 end at a blank and
 * need no tracking: a cut after their blank leaves both halves parsing them as
 * the whole does.
 */
const RAW_HTML_STARTS: ReadonlyArray<{ start: RegExp; end: RegExp }> = [
    { start: /^ {0,3}<(?:script|pre|style|textarea)(?:[ \t>]|$)/i, end: /<\/(?:script|pre|style|textarea)>/i },
    // Not CommonMark's: a Notion `<aside>` callout is a kind-6 HTML block to
    // the parser, but `plugins/notionCallouts.ts` stitches the opener, the
    // parsed blocks between, and the `</aside>` into ONE callout node across
    // the blank lines, so a cut inside it yields two html nodes the whole
    // never had. The corpus oracle found this one.
    { start: /^ {0,3}<aside(?:[ \t>]|$)/i, end: /<\/aside>/i },
    { start: /^ {0,3}<!--/, end: /-->/ },
    { start: /^ {0,3}<\?/, end: /\?>/ },
    { start: /^ {0,3}<![A-Za-z]/, end: />/ },
    { start: /^ {0,3}<!\[CDATA\[/, end: /\]\]>/ },
];

const MATH_FENCE_RE = /^ {0,3}\$\$/;
const DIRECTIVE_FENCE_RE = /^ {0,3}(:{3,})(.*)$/;
const FRONTMATTER_FENCE_RE = /^(---|\+\+\+)[ \t]*$/;

/**
 * Whether `line` opens a raw container that may span blank lines; returns the
 * end condition to wait for, or null. A container whose end condition is met
 * on its own opening line is not open.
 */
function rawOpener(line: string): RegExp | null {
    for (const { start, end } of RAW_HTML_STARTS) {
        const m = start.exec(line);
        if (m && !end.test(line.slice(m[0].length))) return end;
    }
    if (MATH_FENCE_RE.test(line)) {
        const rest = line.replace(MATH_FENCE_RE, "");
        if (!rest.includes("$$")) return /\$\$/;
    }
    return null;
}

/**
 * The line indexes a text may be cut BEFORE: each names the first line of a new
 * chunk, and the line above it is blank. Ascending, and never 0.
 */
export function findSafeCuts(lines: readonly string[]): number[] {
    const cuts: number[] = [];
    let fence: OpenFence | null = null;
    let fenceCol = 0;
    let rawEnd: RegExp | null = null;
    let directiveDepth = 0;
    let listOpen = false;
    let blankBefore = false;
    // A cut needs content on both sides: a chunk of nothing but blank lines
    // parses to an empty document, which is one node the whole never had.
    let seenContent = false;

    // Frontmatter at the very top is a raw container closed by its own marker.
    // The host normally splits it off before the text reaches the editor
    // (shared/contentTransform.ts), but a consumer that hands the raw file here
    // must not have its metadata cut in half.
    let frontmatter: string | null = null;
    if (lines.length > 0) {
        const m = FRONTMATTER_FENCE_RE.exec(lines[0]);
        if (m) frontmatter = m[1];
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "") {
            blankBefore = true;
            continue;
        }
        const first = !seenContent;
        seenContent = true;
        if (frontmatter !== null) {
            if (i > 0 && line.trimEnd() === frontmatter) frontmatter = null;
            blankBefore = false;
            continue;
        }

        const step = fenceStep(line, fence);
        const wasInFence = fence !== null;
        if (wasInFence && step.open === null) {
            // `fenceStep` reads a closer at any indent, which the diff engine
            // can afford and a cut cannot: the parser closes a fence only at
            // up to three columns past where it opened. Deeper, the line is
            // content and the fence stays open. Shallower than the opener's
            // own column (a fence on a `- ` marker line closed at column 0),
            // the parser ends the item and opens a NEW fence on this line, so
            // the state is "a fence is open" either way. Both directions
            // withhold cuts; neither can propose one.
            const col = leadingColumns(line);
            if (col >= fenceCol + 4) {
                blankBefore = false;
                continue;
            }
            if (col < fenceCol) {
                fence = fenceStep(line, null).open ?? fence;
                fenceCol = col;
                blankBefore = false;
                continue;
            }
        }
        fence = step.open;
        if (wasInFence) {
            // Content or closer of a fence: verbatim territory, and none of
            // the block rules below apply to its bytes. An OPENER falls
            // through, because a cut right before it is a cut between blocks.
            blankBefore = false;
            continue;
        }
        if (fence !== null) {
            // The column the parser will require a closer to sit within three
            // of: the line's own indent, or, for a fence riding a list-marker
            // line, the marker's content column.
            const marker = LIST_MARKER_RE.exec(line);
            fenceCol = marker && !/^[ \t]*(`{3,}|~{3,})/.test(line) ? marker[0].length : leadingColumns(line);
        }

        if (rawEnd) {
            if (rawEnd.test(line)) rawEnd = null;
            blankBefore = false;
            continue;
        }

        if (DEFINITION_RE.test(line)) {
            // A reference may reach this from anywhere in the text; no cut is
            // provably safe, so the whole text is one chunk.
            return [];
        }

        const directive = DIRECTIVE_FENCE_RE.exec(line);
        if (directive) {
            if (directive[2].trim() === "") {
                if (directiveDepth > 0) directiveDepth--;
            } else {
                directiveDepth++;
            }
            blankBefore = false;
            continue;
        }

        const isMarker = LIST_MARKER_RE.test(line);
        if (
            blankBefore &&
            !first &&
            directiveDepth === 0 &&
            leadingColumns(line) === 0 &&
            !(listOpen && isMarker)
        ) {
            cuts.push(i);
            listOpen = false;
        }
        if (isMarker) listOpen = true;

        // A fence opener cannot also open an HTML or math container.
        rawEnd = step.open !== null ? null : rawOpener(line);
        blankBefore = false;
    }
    return cuts;
}

/** Split `text` into lines without their endings, remembering where each starts. */
function lineStarts(text: string): { lines: string[]; starts: number[] } {
    const lines: string[] = [];
    const starts: number[] = [];
    let pos = 0;
    while (pos <= text.length) {
        const nl = text.indexOf("\n", pos);
        const end = nl === -1 ? text.length : nl;
        starts.push(pos);
        lines.push(text.slice(pos, end).replace(/\r$/, ""));
        if (nl === -1) break;
        pos = nl + 1;
    }
    return { lines, starts };
}

/**
 * The text in chunks of at least `targetLines` lines, cut only where
 * `findCuts` allows (a format's own segmenter, `FormatModule.findSafeCuts`;
 * markdown's by default). The chunks partition the text byte for byte (line
 * endings included, CRLF kept), the last chunk may be shorter than the target,
 * and a text with no safe cut is one chunk.
 */
export function segmentBlocks(
    text: string,
    targetLines: number,
    findCuts: (lines: readonly string[]) => number[] = findSafeCuts,
): BlockChunk[] {
    const { lines, starts } = lineStarts(text);
    const cuts = findCuts(lines);
    const chunks: BlockChunk[] = [];
    let startLine = 0;
    for (const cut of cuts) {
        if (cut - startLine < targetLines) continue;
        chunks.push({
            start: starts[startLine],
            end: starts[cut],
            startLine,
            endLine: cut,
            text: text.slice(starts[startLine], starts[cut]),
        });
        startLine = cut;
    }
    chunks.push({
        start: starts[startLine],
        end: text.length,
        startLine,
        endLine: lines.length,
        text: text.slice(starts[startLine]),
    });
    return chunks;
}
