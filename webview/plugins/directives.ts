/**
 * Container directives — `:::name … :::` fenced blocks (the Docusaurus
 * admonition / remark-directive container syntax).
 *
 * Deliberately NOT built on remark-directive: enabling its micromark
 * extension also enables TEXT directives, which swallow any `:word` in
 * ordinary prose (`note:this`, `re:invent`) — a fidelity hazard for normal
 * documents. Container fences are plain CommonMark paragraphs (`:::note` is
 * just a text line), so — like callouts.ts — this is a parse-time tree
 * transform plus a toMarkdown handler, with zero parser risk.
 *
 * Fence recognition works on the paragraph's inline SEGMENTS (children split
 * on break nodes) rather than raw source slices, so directives nest inside
 * blockquotes/callouts where raw lines carry `> ` prefixes. A fence segment
 * must be a LONE text node with no escapes or character references
 * (`[^\\&]`), which guarantees decoded text == source bytes — the fence
 * attrs then serialize back verbatim. Anything else (formatted fence line,
 * escaped bytes, unclosed fence) stays ordinary paragraphs, exactly as
 * rendered today.
 *
 * `openAttached`/`closeAttached` record whether the fences shared a
 * paragraph with the content (`:::note\ncontent\n:::` is ONE CommonMark
 * paragraph) or were separated by blank lines — without them, serialization
 * would add or drop blank lines.
 *
 * The one place raw source is consulted is the swallowed-close-fence repair
 * (see LAZY_CONTINUABLE below), where the decoded text of two different
 * documents is identical and only the bytes decide.
 */
import { InputRule } from "../pm";
import { $inputRule, $nodeSchema, $remark } from "@milkdown/utils";

export const directiveId = "container_directive";

// ─── Fence parsing ──────────────────────────────────────────────────────────

/** `:::name` + optional raw rest (label/attributes). No escapes/references. */
const OPEN_FENCE_RE = /^(:{3,})([A-Za-z][A-Za-z0-9_-]*)([^\\&]*)$/;
/** Closing fence: colons only. */
const CLOSE_FENCE_RE = /^(:{3,})\s*$/;

export interface DirectiveFenceParts {
    colons: number;
    name: string;
    /** raw bytes after the name (label/attrs), leading space included */
    rest: string;
}

/** Parses an opening fence line; null when it is not one. */
export function parseOpenFence(line: string): DirectiveFenceParts | null {
    const m = OPEN_FENCE_RE.exec(line);
    if (!m) return null;
    return { colons: m[1]!.length, name: m[2]!, rest: m[3] ?? "" };
}

/** Colon count of a closing fence line, or 0 when it is not one. */
export function closeFenceColons(line: string): number {
    const m = CLOSE_FENCE_RE.exec(line);
    return m ? m[1]!.length : 0;
}

/** Display title: the rest bytes with `{attrs}` stripped, trimmed. */
export function directiveTitle(rest: string): string {
    return rest.replace(/\{[^}]*\}\s*$/, "").trim();
}

/**
 * Strips the characters a directive title cannot carry. Unlike callout
 * titles, fence bytes can't be backslash-escaped: the fence guard rejects
 * `\`/`&` (decoded==raw invariant), and inline-construct characters would
 * make the fence line parse as formatted text — no longer a lone text node,
 * so the whole directive would downgrade to paragraphs on the next load.
 */
export function sanitizeDirectiveTitle(title: string): string {
    return title.replace(/[\\&`*_[\]<>~$={}]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * The opening fence for a title edit: colons + name preserved, the new
 * (sanitized) title replaces the old one, and a trailing `{attrs}` block —
 * which the title editor never shows — survives verbatim.
 */
export function openFenceWithTitle(openFence: string, title: string): string {
    const parts = parseOpenFence(openFence);
    if (!parts) return openFence;
    const attrs = /\{[^}]*\}\s*$/.exec(parts.rest)?.[0]?.trim() ?? "";
    const clean = sanitizeDirectiveTitle(title);
    const segments = [clean, attrs].filter((s) => s !== "");
    const head = `${":".repeat(parts.colons)}${parts.name}`;
    return segments.length > 0 ? `${head} ${segments.join(" ")}` : head;
}

/** PM attrs for a directive from its two fence lines. */
export function attrsFromFences(
    openFence: string,
    closeFence: string,
    openAttached: boolean,
    closeAttached: boolean,
): Record<string, unknown> {
    const parts = parseOpenFence(openFence);
    return {
        openFence,
        closeFence,
        name: parts?.name ?? "",
        title: parts ? directiveTitle(parts.rest) : "",
        openAttached,
        closeAttached,
    };
}

// ─── Parse: paragraph-run → directive tree transform ────────────────────────

interface DirectiveMdastNode {
    type: string;
    value?: string;
    openFence?: string;
    closeFence?: string;
    openAttached?: boolean;
    closeAttached?: boolean;
    data?: { isInline?: boolean };
    children?: DirectiveMdastNode[];
    position?: {
        start?: { line?: number; column?: number; offset?: number };
        end?: { line?: number; column?: number; offset?: number };
    };
}

/**
 * Whether `b` starts on the line right after `a` ends (no blank line).
 * Block positions survive parsing (only inline children get rebuilt), and a
 * split paragraph's stale position still ends on its last source line.
 */
function linesAdjacent(
    a: DirectiveMdastNode | undefined,
    b: DirectiveMdastNode | undefined,
): boolean {
    const endLine = a?.position?.end?.line;
    const startLine = b?.position?.start?.line;
    return typeof endLine === "number" && typeof startLine === "number"
        ? startLine === endLine + 1
        : false;
}

/** Child-index ranges of a paragraph's lines (split on break nodes). */
function segmentize(children: DirectiveMdastNode[]): Array<{ start: number; end: number }> {
    const segments: Array<{ start: number; end: number }> = [];
    let start = 0;
    for (let i = 0; i < children.length; i++) {
        if (children[i]!.type === "break") {
            segments.push({ start, end: i });
            start = i + 1;
        }
    }
    segments.push({ start, end: children.length });
    return segments;
}

/** The segment's text when it is a LONE unformatted text node, else null. */
function segmentText(
    children: DirectiveMdastNode[],
    seg: { start: number; end: number },
): string | null {
    if (seg.end - seg.start !== 1) return null;
    const only = children[seg.start]!;
    return only.type === "text" && typeof only.value === "string" ? only.value : null;
}

/** Paragraph node from a child slice; null when the slice is empty. */
function paragraphFrom(
    para: DirectiveMdastNode,
    children: DirectiveMdastNode[],
): DirectiveMdastNode | null {
    return children.length > 0 ? { ...para, children } : null;
}

// ─── Close fences swallowed by the block above (MAR-362, MAR-365) ───────────
//
// A close fence written flush left with no blank line above it never reaches
// us as its own paragraph. CommonMark lazy continuation folds an unindented
// non-blank line into whatever paragraph is open inside a list item, a
// blockquote, or a footnote definition, so the `:::` arrives as the last
// SOFT LINE of that block's final paragraph:
//
//   :::note              list > listItem > paragraph("a\n:::")
//   - a
//   :::
//
// A GFM table and a raw HTML block absorb the same line without a paragraph to
// put it in: the table takes it as a ROW, the HTML block as more of its own
// bytes. The repair therefore descends to whichever block ENDS the sibling and
// takes the fence back off in that block's terms (`tailFence`), then closes the
// directive there.
//
// The hazard is that mdast strips a container's indentation, so a genuinely
// indented `    :::` inside a footnote definition — real content, which the
// author meant to keep — decodes to the exact same paragraph text. Only the
// raw source line tells the two apart, hence `source`.

/**
 * Block types whose children were parsed from a SUBSTRING of the document
 * (`notionCallouts.ts` sub-parses an aside's lead), so their `position`
 * offsets index that substring and address unrelated bytes of the file. Only
 * the source-reading repair below can be misled by them, and it declines
 * rather than reading a line it has no claim on.
 */
const FOREIGN_COORDINATES = new Set(["notionCallout"]);

/** Block types a following unindented line can lazily continue. */
const LAZY_CONTINUABLE = new Set([
    "blockquote",
    "callout",
    "footnoteDefinition",
    "list",
    "listItem",
]);

/**
 * Block types that absorb the fence line itself, each in its own shape: a
 * paragraph takes it as a soft line, a GFM table as a ROW, a raw HTML block as
 * more of its bytes (MAR-365). The descent stops at whichever one it reaches,
 * and `tailFence` knows how to take the fence back off each.
 */
const TAIL_BLOCKS = new Set(["paragraph", "table", "html"]);

/** Container prefix (`> `, indentation) of the line holding `offset`. */
function linePrefix(source: string, offset: number): string {
    return source.slice(source.lastIndexOf("\n", offset - 1) + 1, offset);
}

/** The whole raw source line holding `offset`, and where it starts. */
function rawLineAt(source: string, offset: number): { start: number; text: string } {
    const start = source.lastIndexOf("\n", offset - 1) + 1;
    const nl = source.indexOf("\n", offset);
    return { start, text: source.slice(start, nl < 0 ? source.length : nl) };
}

/**
 * True when some line between the open fence's paragraph and `beforeStart`
 * is a close fence at `prefix` too. The FIRST such line is the one that
 * closes the directive, and by the time this runs it is already buried
 * mid-paragraph inside a block, where splitting it back out would take a
 * reparse. So an ambiguous run declines the repair rather than closing at a
 * later fence and swallowing the real one into the body.
 */
function closeFenceEarlier(
    source: string,
    openEnd: number,
    beforeStart: number,
    prefix: string,
    minColons: number,
): boolean {
    const from = source.indexOf("\n", openEnd);
    if (from < 0 || from + 1 >= beforeStart) return false;
    for (const raw of source.slice(from + 1, beforeStart).split("\n")) {
        if (raw.startsWith(prefix) && closeFenceColons(raw.slice(prefix.length)) >= minColons) {
            return true;
        }
    }
    return false;
}

/**
 * Last-child-first descent to the block that ends `node`, outermost first.
 * Null when any step leaves the lazy-continuable set, which keeps the repair
 * to blocks that can actually have swallowed a line.
 */
function lastTailPath(node: DirectiveMdastNode): DirectiveMdastNode[] | null {
    const path: DirectiveMdastNode[] = [];
    let cur = node;
    while (!TAIL_BLOCKS.has(cur.type)) {
        if (!LAZY_CONTINUABLE.has(cur.type)) return null;
        const last = cur.children?.[cur.children.length - 1];
        if (!last) return null;
        path.push(cur);
        cur = last;
    }
    path.push(cur);
    return path;
}

/** A copy of `pos` ending at `endOffset`, which must be a line's last byte. */
function endingAt(
    pos: DirectiveMdastNode["position"],
    source: string,
    endOffset: number,
): DirectiveMdastNode["position"] {
    if (!pos?.end) return pos;
    const line = rawLineAt(source, endOffset);
    return {
        ...pos,
        end: {
            line: (pos.end.line ?? 1) - 1,
            column: endOffset - line.start + 1,
            offset: endOffset,
        },
    };
}

/**
 * A close fence found at the end of a tail block: its decoded text, its colon
 * count, and how to rebuild the block without it. `rebuild` takes the offset
 * of the last byte BEFORE the fence line, which only the caller knows.
 */
interface TailFence {
    closeFence: string;
    colons: number;
    rebuild: (trimmedEnd: number) => DirectiveMdastNode;
}

/** The fence as a paragraph's last SOFT LINE. */
function paragraphFence(
    para: DirectiveMdastNode,
    minColons: number,
    source: string,
): TailFence | null {
    if (!para.children?.length) return null;
    const children = para.children;
    const segs = segmentize(children);
    // The split needs a break node in front of the fence segment, and a
    // paragraph must not be emptied into nothing. A raw lazy continuation
    // always has the line it continued above it; the exception is a callout,
    // whose marker line callouts.ts peels off into an attr, and whose body
    // paragraph can therefore be the fence alone. That case is declined.
    if (segs.length < 2) return null;
    // The last segment: the only one that can be the fence, since a block
    // absorbs every line up to the one it ends on. `closeFenceEarlier` is
    // what makes taking it safe when the run held more than one candidate.
    const last = segs[segs.length - 1]!;
    const lastLine = segmentText(children, last);
    if (lastLine === null) return null;
    const colons = closeFenceColons(lastLine);
    if (colons < minColons) return null;
    return {
        closeFence: lastLine,
        colons,
        rebuild: (trimmedEnd) => ({
            ...para,
            children: children.slice(0, last.start - 1),
            position: endingAt(para.position, source, trimmedEnd),
        }),
    };
}

/**
 * The fence as a GFM table's last ROW. The row must be the lone cell it takes
 * to spell a bare `:::` line; a wider row could not have been one.
 */
function tableFence(
    table: DirectiveMdastNode,
    minColons: number,
    source: string,
): TailFence | null {
    const rows = table.children;
    // Dropping the row has to leave a table behind: a one-row table's only row
    // is its header, and the delimiter line that made the run a table is not in
    // the tree to rebuild one from. No document reaches this — a table's
    // position ends on its LAST row's line, and a one-row table's next source
    // line is the delimiter, which the raw-line check below never reads as a
    // fence — so it is a bound on the arm rather than a case that fires.
    if (!rows || rows.length < 2) return null;
    const cells = rows[rows.length - 1]!.children;
    if (cells?.length !== 1) return null;
    const inline = cells[0]!.children;
    if (inline?.length !== 1) return null;
    const only = inline[0]!;
    if (only.type !== "text" || typeof only.value !== "string") return null;
    const colons = closeFenceColons(only.value);
    if (colons < minColons) return null;
    return {
        closeFence: only.value,
        colons,
        rebuild: (trimmedEnd) => ({
            ...table,
            children: rows.slice(0, -1),
            position: endingAt(table.position, source, trimmedEnd),
        }),
    };
}

/** The fence as the last line of a raw HTML block's bytes. */
function htmlFence(
    html: DirectiveMdastNode,
    minColons: number,
    source: string,
): TailFence | null {
    const value = html.value;
    if (typeof value !== "string") return null;
    // A single-line block IS the fence rather than a block that swallowed one,
    // and taking the line would leave an empty node behind.
    const nl = value.lastIndexOf("\n");
    if (nl < 0) return null;
    const lastLine = value.slice(nl + 1);
    const colons = closeFenceColons(lastLine);
    if (colons < minColons) return null;
    return {
        closeFence: lastLine,
        colons,
        rebuild: (trimmedEnd) => ({
            ...html,
            value: value.slice(0, nl),
            position: endingAt(html.position, source, trimmedEnd),
        }),
    };
}

/** The fence at the end of whichever tail block the descent reached. */
function tailFence(
    leaf: DirectiveMdastNode,
    minColons: number,
    source: string,
): TailFence | null {
    if (leaf.type === "table") return tableFence(leaf, minColons, source);
    if (leaf.type === "html") return htmlFence(leaf, minColons, source);
    if (leaf.type !== "paragraph" || !leaf.children?.length) return null;
    // A raw HTML block reaches this transform as a paragraph holding one
    // `html` child (see serialization.ts), so its bytes are where the fence is.
    const children = leaf.children;
    const lastChild = children[children.length - 1]!;
    const inner = lastChild.type === "html" ? htmlFence(lastChild, minColons, source) : null;
    if (inner) {
        return {
            ...inner,
            rebuild: (trimmedEnd) => ({
                ...leaf,
                children: [...children.slice(0, -1), inner.rebuild(trimmedEnd)],
                position: endingAt(leaf.position, source, trimmedEnd),
            }),
        };
    }
    return paragraphFence(leaf, minColons, source);
}

/**
 * Splits a swallowed close fence off the block `sib` ends with. Returns the
 * rebuilt sibling and the fence's decoded text, or null when `sib` does not
 * end in one.
 *
 * `prefix` is the container prefix of the OPENING fence's line: the close
 * fence must sit at that same column to be a fence rather than content, and
 * comparing raw lines is what tells an absorbed `:::` from an indented one.
 * Every ancestor on the path gets its `position.end` pulled back to the line
 * above, so a re-scan of the trimmed tree (nested directives) still reads the
 * source line it thinks it is reading.
 */
function splitSwallowedClose(
    sib: DirectiveMdastNode,
    minColons: number,
    prefix: string,
    source: string,
    openEnd: number,
): { sibling: DirectiveMdastNode; closeFence: string } | null {
    const path = lastTailPath(sib);
    if (!path) return null;
    const leaf = path[path.length - 1]!;
    const fence = tailFence(leaf, minColons, source);
    if (!fence) return null;

    const endOffset = leaf.position?.end?.offset;
    if (typeof endOffset !== "number") return null;
    const line = rawLineAt(source, endOffset);
    if (!line.text.startsWith(prefix)) return null;
    // Exact match, not `>=`: the raw fence has to be the decoded one, or the
    // attrs would no longer serialize back verbatim.
    if (closeFenceColons(line.text.slice(prefix.length)) !== fence.colons) return null;
    if (closeFenceEarlier(source, openEnd, line.start, prefix, minColons)) return null;

    const trimmedEnd = line.start - 1;
    let rebuilt: DirectiveMdastNode = fence.rebuild(trimmedEnd);
    for (let k = path.length - 2; k >= 0; k--) {
        const parent = path[k]!;
        rebuilt = {
            ...parent,
            children: [...parent.children!.slice(0, -1), rebuilt],
            position: endingAt(parent.position, source, trimmedEnd),
        };
    }
    return { sibling: rebuilt, closeFence: fence.closeFence };
}

/**
 * Scans one parent's children for directive runs and wraps them. Returns the
 * rewritten child list. Runs bottom-up (callers recurse first), so nested
 * directives with higher colon counts wrap inner ones written with fewer.
 */
function wrapDirectives(
    children: DirectiveMdastNode[],
    source: string | null,
): DirectiveMdastNode[] {
    const out: DirectiveMdastNode[] = [];
    let i = 0;

    outer: while (i < children.length) {
        const node = children[i]!;
        if (node.type !== "paragraph" || !node.children?.length) {
            out.push(node);
            i++;
            continue;
        }
        const segs = segmentize(node.children);
        const openLine = segmentText(node.children, segs[0]!);
        const open = openLine !== null ? parseOpenFence(openLine) : null;
        if (!open) {
            out.push(node);
            i++;
            continue;
        }

        // Closer inside the SAME paragraph → fully contained directive.
        for (let s = 1; s < segs.length; s++) {
            const line = segmentText(node.children, segs[s]!);
            if (line !== null && closeFenceColons(line) >= open.colons) {
                const inner = node.children.slice(segs[1]!.start, segs[s]!.start - 1);
                const content = paragraphFrom(node, inner);
                out.push(
                    makeDirective(openLine!, line, true, true, content ? [content] : [], source),
                );
                // Anything after the closer segment stays a paragraph.
                const tail = node.children.slice(segs[s]!.end + 1);
                if (tail.length > 0) out.push({ ...node, children: tail });
                i++;
                continue outer;
            }
        }

        // Closer in a following sibling paragraph.
        const openRemainder = node.children.slice(
            segs.length > 1 ? segs[1]!.start : node.children.length,
        );
        const body: DirectiveMdastNode[] = [];
        const attachedFirst = paragraphFrom(node, openRemainder);
        if (attachedFirst) body.push(attachedFirst);
        // The column the close fence has to sit at. A split paragraph's start
        // is stale but still on a line of the same container, so its prefix is
        // the right one.
        const openStart = node.position?.start?.offset;
        const openEnd = node.position?.end?.offset;
        const prefix =
            source !== null && typeof openStart === "number" && typeof openEnd === "number"
                ? linePrefix(source, openStart)
                : null;

        for (let j = i + 1; j < children.length; j++) {
            const sib = children[j]!;
            if (sib.type === "paragraph" && sib.children?.length) {
                const sibSegs = segmentize(sib.children);
                const last = sibSegs[sibSegs.length - 1]!;
                const lastLine = segmentText(sib.children, last);
                if (lastLine !== null && closeFenceColons(lastLine) >= open.colons) {
                    // "Attached" = no blank line at that fence. The opener is
                    // attached when content shared its paragraph OR the first
                    // body block starts on the very next line (e.g. a list).
                    const openAttached =
                        attachedFirst !== null || linesAdjacent(node, body[0] ?? sib);
                    if (sibSegs.length === 1) {
                        // The closer is its own paragraph.
                        const closeAttached = linesAdjacent(body[body.length - 1] ?? node, sib);
                        out.push(
                            makeDirective(
                                openLine!, lastLine, openAttached, closeAttached, body, source,
                            ),
                        );
                    } else {
                        // The closer is the last line of a content paragraph.
                        const before = sib.children.slice(0, last.start - 1);
                        const closing = paragraphFrom(sib, before);
                        if (closing) body.push(closing);
                        out.push(
                            makeDirective(openLine!, lastLine, openAttached, true, body, source),
                        );
                    }
                    i = j + 1;
                    continue outer;
                }
            }
            if (prefix !== null) {
                // A closer a lazy continuation absorbed into this sibling: the
                // fence never became a paragraph of its own, so it is always
                // attached (no blank line could have preceded it). Reached for
                // a PARAGRAPH sibling too, which the segment scan above leaves
                // untouched when the fence is inside an `html` child's bytes
                // rather than in a text segment of its own.
                const swallowed = splitSwallowedClose(
                    sib, open.colons, prefix, source!, openEnd!,
                );
                if (swallowed) {
                    const openAttached =
                        attachedFirst !== null || linesAdjacent(node, body[0] ?? swallowed.sibling);
                    body.push(swallowed.sibling);
                    out.push(
                        makeDirective(
                            openLine!, swallowed.closeFence, openAttached, true, body, source,
                        ),
                    );
                    i = j + 1;
                    continue outer;
                }
            }
            body.push(sib);
        }

        // No closer before the parent ends — not a directive.
        out.push(node);
        i++;
    }

    return out;
}

function makeDirective(
    openFence: string,
    closeFence: string,
    openAttached: boolean,
    closeAttached: boolean,
    children: DirectiveMdastNode[],
    source: string | null,
): DirectiveMdastNode {
    return {
        type: "containerDirective",
        openFence,
        closeFence,
        openAttached,
        closeAttached,
        // Recurse: a 4-colon directive's content may hold 3-colon fence
        // paragraphs that only now became wrappable siblings.
        children:
            children.length > 0
                ? wrapDirectives(children, source)
                : [{ type: "paragraph", children: [] }],
    };
}

/** A serialized line that would reparse as a setext-heading underline
 * (a run of `=` or `-`, ≤3 leading spaces): fatal directly under an open
 * fence line, which is itself a text line (MAR-120 case G). Exported for
 * the callout serializer, whose `[!NOTE]` marker line is the same kind of
 * synthesized text line (MAR-157). */
export const SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)[ \t]*$/;

/** The longest `:::`-fence run anywhere in a serialized body (0 if none). */
function maxFenceColons(flow: string): number {
    let max = 0;
    for (const line of flow.split("\n")) {
        const m = /^(:{3,})/.exec(line);
        if (m) {
            max = Math.max(max, m[1]!.length);
        }
    }
    return max;
}

// toMarkdown: fences re-emitted around the standard flow serialization;
// attachment flags reproduce the original blank-line shape.
//
// Two reparse hazards are repaired here (MAR-120):
//   (A) A nested directive must sit inside a STRICTLY LONGER fence, or the
//       inner directive's close fence closes the outer one on reparse and the
//       inner flattens. The outer fence is lengthened to exceed the longest
//       fence in its serialized body (the CommonMark `::::`/`:::` convention).
//   (G) When the first body line would reparse as a setext underline (`---`),
//       an attached open fence (`:::info{…}\n---`) makes the fence line a
//       heading. A blank line after the open fence defuses it.
const directiveToMarkdown = {
    handlers: {
        containerDirective(
            node: DirectiveMdastNode,
            _parent: unknown,
            state: any,
            info: unknown,
        ): string {
            const exit = state.enter("containerDirective");
            const tracker = state.createTracker(info);
            const flow: string = state.containerFlow(
                { ...node, type: "containerDirective" },
                tracker.current(),
            );
            // (A) Fence length: strictly greater than any fence in the body.
            const parts = parseOpenFence(node.openFence ?? ":::note");
            const colons = Math.max(parts?.colons ?? 3, maxFenceColons(flow) + 1);
            const open = parts
                ? `${":".repeat(colons)}${parts.name}${parts.rest}`
                : (node.openFence ?? ":::note");
            const close = ":".repeat(colons);
            // (G) Blank line after the open fence when the body opens on a
            // setext-underline-shaped line.
            const firstLine = flow.split("\n", 1)[0] ?? "";
            const openAttached = node.openAttached && !SETEXT_UNDERLINE_RE.test(firstLine);
            const value =
                (flow === "" ? open : `${open}${openAttached ? "\n" : "\n\n"}${flow}`) +
                `${node.closeAttached ? "\n" : "\n\n"}${close}`;
            exit();
            return value;
        },
    },
};

function remarkDirectives(this: any): (tree: unknown, file: unknown) => void {
    const data = this.data();
    const list = data["toMarkdownExtensions"] ?? (data["toMarkdownExtensions"] = []);
    list.push(directiveToMarkdown);

    return (tree: unknown, file: unknown) => {
        // Raw bytes, for the swallowed-close-fence repair above: mdast strips
        // a container's indentation, so only the source distinguishes an
        // absorbed close fence from an indented one that is real content.
        const raw = (file as { value?: unknown } | undefined)?.value;
        const source = typeof raw === "string" ? raw : String(raw ?? "");
        const walk = (node: DirectiveMdastNode, src: string | null): void => {
            if (!node.children) return;
            // Inside a FOREIGN_COORDINATES node the offsets index a different
            // string, so the repair loses its source and declines; every other
            // branch of the transform reads the tree only and is unaffected.
            const inner = FOREIGN_COORDINATES.has(node.type) ? null : src;
            node.children.forEach((child) => walk(child, inner));
            node.children = wrapDirectives(node.children, inner);
        };
        walk(tree as DirectiveMdastNode, source);
    };
}

export const directiveRemarkPlugin = $remark("remarkDirectives", () => remarkDirectives);

// ─── ProseMirror schema ─────────────────────────────────────────────────────

export const directiveSchema = $nodeSchema(directiveId, () => ({
    content: "block+",
    group: "block",
    defining: true,
    // Both fence lines (`:::name title` … `:::`) live in attrs with no text
    // position — declared for the source-line mapping (utils/sourceCaret.ts).
    markerLines: { closer: true },
    attrs: {
        openFence: { default: ":::note" },
        closeFence: { default: ":::" },
        name: { default: "note" },
        title: { default: "" },
        openAttached: { default: true },
        closeAttached: { default: true },
    },
    parseDOM: [
        {
            tag: 'div[data-type="container-directive"]',
            getAttrs: (dom) => {
                const el = dom as HTMLElement;
                return attrsFromFences(
                    el.dataset["openFence"] ?? ":::note",
                    el.dataset["closeFence"] ?? ":::",
                    el.dataset["openAttached"] !== "false",
                    el.dataset["closeAttached"] !== "false",
                );
            },
        },
    ],
    toDOM: (node) => [
        "div",
        {
            "data-type": "container-directive",
            "data-name": node.attrs["name"] as string,
            "data-open-fence": node.attrs["openFence"] as string,
            "data-close-fence": node.attrs["closeFence"] as string,
            "data-open-attached": String(node.attrs["openAttached"]),
            "data-close-attached": String(node.attrs["closeAttached"]),
            class: "container-directive",
        },
        0,
    ],
    parseMarkdown: {
        match: (node) => node.type === "containerDirective",
        runner: (state, node, type) => {
            state
                .openNode(
                    type,
                    attrsFromFences(
                        (node["openFence"] as string) ?? ":::note",
                        (node["closeFence"] as string) ?? ":::",
                        (node["openAttached"] as boolean) ?? true,
                        (node["closeAttached"] as boolean) ?? true,
                    ),
                )
                .next(node.children)
                .closeNode();
        },
    },
    toMarkdown: {
        match: (node) => node.type.name === directiveId,
        runner: (state, node) => {
            state
                .openNode("containerDirective", undefined, {
                    openFence: node.attrs["openFence"] as string,
                    closeFence: node.attrs["closeFence"] as string,
                    openAttached: node.attrs["openAttached"] as boolean,
                    closeAttached: node.attrs["closeAttached"] as boolean,
                })
                .next(node.content)
                .closeNode();
        },
    },
}));

// ─── Input rule: `:::name ` at the start of a paragraph ─────────────────────

export const DIRECTIVE_INPUT_RULE_RE = /^(:{3,})([A-Za-z][A-Za-z0-9_-]*)\s$/;

export const directiveInputRule = $inputRule((ctx) =>
    new InputRule(DIRECTIVE_INPUT_RULE_RE, (state, match, start, end) => {
        const $start = state.doc.resolve(start);
        const $end = state.doc.resolve(end);
        if ($start.parent.type.name !== "paragraph") return null;
        // Only convert a paragraph that contains nothing but the typed fence
        // (the regex's ^ anchors at the block start; require nothing after).
        if ($end.parentOffset !== $end.parent.content.size) return null;

        const colons = match[1] ?? ":::";
        const openFence = `${colons}${match[2]}`;
        const paraPos = $start.before($start.depth);
        const type = directiveSchema.type(ctx);
        const paragraph = state.schema.nodes["paragraph"];
        if (!paragraph) return null;

        const tr = state.tr.delete(start, end);
        const pos = tr.mapping.map(paraPos);
        const emptied = tr.doc.nodeAt(pos);
        if (!emptied) return null;
        tr.replaceWith(
            pos,
            pos + emptied.nodeSize,
            type.create(
                attrsFromFences(openFence, colons, true, true),
                paragraph.create(),
            ),
        );
        return tr;
    }),
);

/** Parse/serialize plugins, flattened for `Editor.use()` / pureCommonmark. */
export const directivesPlugin = [
    directiveRemarkPlugin,
    directiveSchema,
    directiveInputRule,
].flat();
