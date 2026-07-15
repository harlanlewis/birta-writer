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
 */
import { InputRule } from "@milkdown/prose/inputrules";
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
        start?: { line?: number };
        end?: { line?: number };
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

/**
 * Scans one parent's children for directive runs and wraps them. Returns the
 * rewritten child list. Runs bottom-up (callers recurse first), so nested
 * directives with higher colon counts wrap inner ones written with fewer.
 */
function wrapDirectives(children: DirectiveMdastNode[]): DirectiveMdastNode[] {
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
                out.push(makeDirective(openLine!, line, true, true, content ? [content] : []));
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
                            makeDirective(openLine!, lastLine, openAttached, closeAttached, body),
                        );
                    } else {
                        // The closer is the last line of a content paragraph.
                        const before = sib.children.slice(0, last.start - 1);
                        const closing = paragraphFrom(sib, before);
                        if (closing) body.push(closing);
                        out.push(
                            makeDirective(openLine!, lastLine, openAttached, true, body),
                        );
                    }
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
                ? wrapDirectives(children)
                : [{ type: "paragraph", children: [] }],
    };
}

/** A serialized line that would reparse as a setext-heading underline
 * (a run of `=` or `-`, ≤3 leading spaces): fatal directly under an open
 * fence line, which is itself a text line (MAR-120 case G). */
const SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)[ \t]*$/;

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

function remarkDirectives(this: any): (tree: unknown) => void {
    const data = this.data();
    const list = data["toMarkdownExtensions"] ?? (data["toMarkdownExtensions"] = []);
    list.push(directiveToMarkdown);

    return (tree: unknown) => {
        const walk = (node: DirectiveMdastNode): void => {
            if (!node.children) return;
            node.children.forEach(walk);
            node.children = wrapDirectives(node.children);
        };
        walk(tree as DirectiveMdastNode);
    };
}

export const directiveRemarkPlugin = $remark("remarkDirectives", () => remarkDirectives);

// ─── ProseMirror schema ─────────────────────────────────────────────────────

export const directiveSchema = $nodeSchema(directiveId, () => ({
    content: "block+",
    group: "block",
    defining: true,
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
