/**
 * Callouts / admonitions (MAR-27) — GitHub alerts (`> [!NOTE]`) and
 * Obsidian-style callouts (`> [!tip]- Optional title`).
 *
 * A callout is an ALREADY-VALID CommonMark blockquote whose first line is a
 * `[!TYPE]` marker, so no micromark tokenizer is needed (unlike wikiLinks.ts):
 * a parse-time `$remark` tree transform rewrites matching `blockquote` mdast
 * nodes into `callout` nodes, and a toMarkdown handler serializes them back
 * through the same machinery the stock blockquote handler uses.
 *
 * Round-trip fidelity follows the wikilinks philosophy — the `marker` attr is
 * the EXACT source bytes of the marker line (sliced from the vfile by
 * position offset, so escapes like `\[!NOTE]` can never false-positive and
 * title escapes/spacing survive verbatim), and the serializer re-emits it
 * unchanged. Byte-identity by construction for untouched callouts.
 *
 * Two deliberate degradations, both to plain blockquote (today's rendering,
 * zero fidelity risk):
 *   - a marker line carrying inline FORMATTING (`> [!NOTE] a **bold** title`)
 *     is not converted — a formatted title cannot be raw-byte-reconstructed
 *     provably;
 *   - a blockquote whose nodes carry no position offsets (programmatic mdast)
 *     is not converted.
 *
 * The `attached` attr records whether body content shared the marker's
 * paragraph (`> [!NOTE]\n> body` parses as ONE paragraph) or was separated by
 * a blank `>` line — without it, serialization would add or drop a `>` line.
 *
 * Unknown types (`[!custom]`) are accepted and styled neutrally (Obsidian's
 * behavior); the marker round-trips verbatim either way. Folding is handled
 * by the NodeView (components/callout) and is VISUAL ONLY — the `-`/`+`
 * marker is never rewritten by collapsing/expanding.
 */
import { InputRule } from "@milkdown/prose/inputrules";
import { wrapIn } from "@milkdown/prose/commands";
import { $command, $inputRule, $nodeSchema, $remark } from "@milkdown/utils";

export const calloutId = "callout";

// ─── Kind registry ──────────────────────────────────────────────────────────

/**
 * Canonical kinds, GitHub's five first. Aliases (Obsidian's synonyms) resolve
 * onto these; anything unrecognized falls back to "note" styling while the
 * raw type stays in the marker and the title bar.
 */
export const CALLOUT_KINDS = [
    "note",
    "tip",
    "important",
    "warning",
    "caution",
    "abstract",
    "info",
    "todo",
    "success",
    "question",
    "failure",
    "danger",
    "bug",
    "example",
    "quote",
] as const;

export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/** GitHub's alert types — new insertions of these use the `[!NOTE]` uppercase convention. */
export const GITHUB_KINDS: ReadonlySet<string> = new Set([
    "note",
    "tip",
    "important",
    "warning",
    "caution",
]);

const KIND_ALIASES: Record<string, CalloutKind> = {
    summary: "abstract",
    tldr: "abstract",
    hint: "tip",
    check: "success",
    done: "success",
    help: "question",
    faq: "question",
    attention: "warning",
    fail: "failure",
    missing: "failure",
    error: "danger",
    cite: "quote",
};

/** Canonical kind for a raw `[!TYPE]` type (case-insensitive); unknown → "note". */
export function calloutKind(rawType: string): CalloutKind {
    const lower = rawType.toLowerCase();
    if ((CALLOUT_KINDS as readonly string[]).includes(lower)) {
        return lower as CalloutKind;
    }
    return KIND_ALIASES[lower] ?? "note";
}

// ─── Marker parsing ─────────────────────────────────────────────────────────

/**
 * `[!type]`, optional `-`/`+` fold marker, then everything else (`rest`,
 * leading whitespace included) as the raw title bytes. Anchored to the full
 * line — callers pass a single line, never text containing `\n`.
 */
const MARKER_RE = /^\[!([A-Za-z][A-Za-z0-9_-]*)\]([+-]?)([ \t].*)?$/;

export interface CalloutMarkerParts {
    /** raw type bytes inside `[!…]` (case preserved) */
    rawType: string;
    /** canonical kind (aliases resolved, unknown → "note") */
    kind: CalloutKind;
    fold: "" | "+" | "-";
    /** raw title bytes after the fold marker, INCLUDING leading whitespace */
    rest: string;
    /** display title: rest trimmed and backslash-unescaped; "" when absent */
    title: string;
}

/** Parses a raw marker line; null when the line is not a callout marker. */
export function parseCalloutMarker(marker: string): CalloutMarkerParts | null {
    const m = MARKER_RE.exec(marker.trimEnd());
    if (!m) return null;
    const rawType = m[1] ?? "";
    const rest = m[3] ?? "";
    return {
        rawType,
        kind: calloutKind(rawType),
        fold: (m[2] ?? "") as "" | "+" | "-",
        rest,
        title: rest.trim().replace(/\\(.)/g, "$1"),
    };
}

/** PM attrs derived from the raw marker line (the wikilinks attrsFromRaw pattern). */
export function attrsFromMarker(
    marker: string,
    attached: boolean,
): Record<string, unknown> {
    const parts = parseCalloutMarker(marker) ?? {
        rawType: "NOTE",
        kind: "note" as CalloutKind,
        fold: "" as const,
        rest: "",
        title: "",
    };
    return {
        marker,
        kind: parts.kind,
        rawType: parts.rawType,
        fold: parts.fold,
        title: parts.title,
        attached,
    };
}

/**
 * The marker line for a kind change: type swapped, fold and raw title bytes
 * preserved, and the original's case convention kept (an all-caps `[!NOTE]`
 * stays caps-style as `[!WARNING]`; Obsidian-style `[!note]` stays lower).
 */
export function markerWithKind(marker: string, kind: CalloutKind): string {
    const parts = parseCalloutMarker(marker);
    if (!parts) return `[!${kind.toUpperCase()}]`;
    const caps = parts.rawType === parts.rawType.toUpperCase();
    const type = caps ? kind.toUpperCase() : kind;
    return `[!${type}]${parts.fold}${parts.rest}`;
}

/**
 * Backslash-escapes the characters that would give a typed title inline
 * meaning on reparse (emphasis, code, links/wikilinks, autolink/html, math,
 * highlight, strikethrough, escapes, references). A formatted marker line is
 * deliberately NOT a callout (see blockquoteToCallout), so an unescaped
 * `*x*` in a title would silently downgrade the callout to a blockquote on
 * the next load. parseCalloutMarker's display unescape is the exact inverse,
 * so what the user typed is what the title bar shows again.
 */
export function escapeCalloutTitle(title: string): string {
    return title.replace(/([\\`*_[\]<>~$=&])/g, "\\$1");
}

/**
 * The marker line for a title edit: type, case, and fold preserved; the new
 * title replaces the raw title bytes (escaped — see escapeCalloutTitle).
 * An empty title drops the title segment entirely.
 */
export function markerWithTitle(marker: string, title: string): string {
    const parts = parseCalloutMarker(marker);
    const head = parts
        ? `[!${parts.rawType}]${parts.fold}`
        : marker.trimEnd() || "[!NOTE]";
    const trimmed = title.trim();
    return trimmed === "" ? head : `${head} ${escapeCalloutTitle(trimmed)}`;
}

// ─── Parse: blockquote → callout tree transform ─────────────────────────────

/** Minimal shape of the mdast nodes the transform inspects. */
interface CalloutMdastNode {
    type: string;
    value?: string;
    marker?: string;
    attached?: boolean;
    children?: CalloutMdastNode[];
    position?: {
        start?: { offset?: number };
        end?: { offset?: number };
    };
}

/**
 * Converts one blockquote into a callout node, or returns it unchanged. The
 * decision is made on the RAW source bytes of the first line (position
 * slice), so `\[!NOTE]` in the source can never match.
 */
function blockquoteToCallout(
    bq: CalloutMdastNode,
    source: string,
): CalloutMdastNode {
    const first = bq.children?.[0];
    if (!first || first.type !== "paragraph" || !first.children?.length) return bq;
    const lead = first.children[0]!;
    if (lead.type !== "text" || typeof lead.value !== "string") return bq;

    // Slice from the PARAGRAPH's position — it starts exactly at the marker,
    // and it survives the preset's remarkLineBreak transform, which rebuilds
    // the paragraph's inline children (text/break/text) WITHOUT positions.
    const startOffset = first.position?.start?.offset;
    if (typeof startOffset !== "number") return bq;
    const lineBreak = source.indexOf("\n", startOffset);
    const rawFirstLine = source.slice(
        startOffset,
        lineBreak < 0 ? source.length : lineBreak,
    );

    const newline = lead.value.indexOf("\n");
    let marker: string;
    let bodyParagraphChildren: CalloutMdastNode[] | null = null;

    if (newline >= 0) {
        // Marker line ends inside this text node (soft break kept as "\n");
        // the rest of the paragraph is body attached to the marker's line.
        marker = rawFirstLine;
        const remainder = lead.value.slice(newline + 1);
        bodyParagraphChildren = [
            ...(remainder !== "" ? [{ ...lead, value: remainder }] : []),
            ...first.children.slice(1),
        ];
    } else if (first.children.length === 1) {
        // The whole paragraph is the marker line (`> [!NOTE]` or
        // `> [!NOTE] Title`, blank `>` line before any body).
        marker = rawFirstLine;
    } else if (first.children[1]?.type === "break") {
        // Marker line ends in a line break node (the preset's remarkLineBreak
        // soft break, or a trailing-double-space hard break); the rest of the
        // paragraph is attached body content.
        marker = rawFirstLine;
        bodyParagraphChildren = first.children.slice(2);
    } else {
        // The marker line carries inline formatting (`[!NOTE] a **bold**
        // title`) — not provably reconstructable; stay a plain blockquote.
        return bq;
    }

    if (!parseCalloutMarker(marker)) return bq;

    const body: CalloutMdastNode[] = [];
    if (bodyParagraphChildren) {
        if (bodyParagraphChildren.length > 0) {
            body.push({ ...first, children: bodyParagraphChildren });
        }
        body.push(...(bq.children?.slice(1) ?? []));
    } else {
        body.push(...(bq.children?.slice(1) ?? []));
    }
    const attached = bodyParagraphChildren !== null || body.length === 0;

    return {
        type: "callout",
        marker,
        attached,
        children: body.length > 0 ? body : [{ type: "paragraph", children: [] }],
    };
}

// toMarkdown: replicate the stock blockquote handler (enter/containerFlow/
// indentLines with the same line map) but emit the raw marker line first,
// joined without a blank line when the body was attached to the marker's
// paragraph. Reusing the blockquote machinery keeps escaping and child
// joining byte-consistent with plain blockquotes.
function calloutLineMap(line: string, _index: number, blank: boolean): string {
    return ">" + (blank ? "" : " ") + line;
}

const calloutToMarkdown = {
    handlers: {
        callout(node: CalloutMdastNode, _parent: unknown, state: any, info: unknown): string {
            const exit = state.enter("blockquote");
            const tracker = state.createTracker(info);
            tracker.move("> ");
            tracker.shift(2);
            const flow: string = state.containerFlow(
                { ...node, type: "blockquote" },
                tracker.current(),
            );
            const marker = node.marker ?? "[!NOTE]";
            const content =
                flow === ""
                    ? marker
                    : node.attached
                      ? `${marker}\n${flow}`
                      : `${marker}\n\n${flow}`;
            const value: string = state.indentLines(content, calloutLineMap);
            exit();
            return value;
        },
    },
};

/**
 * remark plugin: registers the toMarkdown handler and returns the parse-time
 * transformer. `file` is the raw markdown string Milkdown passes to
 * `remark.runSync(tree, markdown)` (wrapped in a vfile), which is what makes
 * raw-byte marker slicing possible.
 */
function remarkCallouts(this: any): (tree: unknown, file: unknown) => void {
    const data = this.data();
    const list = data["toMarkdownExtensions"] ?? (data["toMarkdownExtensions"] = []);
    list.push(calloutToMarkdown);

    return (tree: unknown, file: unknown) => {
        const raw = (file as { value?: unknown } | undefined)?.value;
        const source = typeof raw === "string" ? raw : String(raw ?? "");
        const walk = (node: CalloutMdastNode): void => {
            if (!node.children) return;
            node.children = node.children.map((child) => {
                walk(child);
                return child.type === "blockquote"
                    ? blockquoteToCallout(child, source)
                    : child;
            });
        };
        walk(tree as CalloutMdastNode);
    };
}

export const calloutRemarkPlugin = $remark("remarkCallouts", () => remarkCallouts);

// ─── ProseMirror schema ─────────────────────────────────────────────────────

export const calloutSchema = $nodeSchema(calloutId, () => ({
    content: "block+",
    group: "block",
    defining: true,
    attrs: {
        marker: { default: "[!NOTE]" },
        kind: { default: "note" },
        rawType: { default: "NOTE" },
        fold: { default: "" },
        title: { default: "" },
        attached: { default: true },
    },
    parseDOM: [
        {
            tag: 'div[data-type="callout"]',
            getAttrs: (dom) => {
                const el = dom as HTMLElement;
                return attrsFromMarker(
                    el.dataset["marker"] ?? "[!NOTE]",
                    el.dataset["attached"] !== "false",
                );
            },
        },
    ],
    toDOM: (node) => [
        "div",
        {
            "data-type": "callout",
            "data-kind": node.attrs["kind"] as string,
            "data-marker": node.attrs["marker"] as string,
            "data-attached": String(node.attrs["attached"]),
            class: "callout",
        },
        0,
    ],
    parseMarkdown: {
        match: (node) => node.type === "callout",
        runner: (state, node, type) => {
            state
                .openNode(
                    type,
                    attrsFromMarker(
                        (node["marker"] as string) ?? "[!NOTE]",
                        (node["attached"] as boolean) ?? true,
                    ),
                )
                .next(node.children)
                .closeNode();
        },
    },
    toMarkdown: {
        match: (node) => node.type.name === calloutId,
        runner: (state, node) => {
            state
                .openNode("callout", undefined, {
                    marker: node.attrs["marker"] as string,
                    attached: node.attrs["attached"] as boolean,
                })
                .next(node.content)
                .closeNode();
        },
    },
}));

// ─── Input rule: typing `[!note] ` in a blockquote's first paragraph ────────

export const CALLOUT_INPUT_RULE_RE = /^\[!([A-Za-z][A-Za-z0-9_-]*)\]([+-]?)\s$/;

export const calloutInputRule = $inputRule((ctx) =>
    new InputRule(CALLOUT_INPUT_RULE_RE, (state, match, start, end) => {
        const $start = state.doc.resolve(start);
        const depth = $start.depth;
        if (depth < 2) return null;
        if ($start.node(depth).type.name !== "paragraph") return null;
        if ($start.node(depth - 1).type.name !== "blockquote") return null;
        if ($start.index(depth - 1) !== 0) return null;

        const marker = `[!${match[1]}]${match[2] ?? ""}`;
        const blockquotePos = $start.before(depth - 1);
        const tr = state.tr.delete(start, end);
        tr.setNodeMarkup(
            blockquotePos,
            calloutSchema.type(ctx),
            attrsFromMarker(marker, true),
        );
        return tr;
    }),
);

// ─── Insert command (toolbar/palette/slash) ─────────────────────────────────

/**
 * Wraps the selection in a callout of the given kind (default "note").
 * GitHub's five types insert with their uppercase convention; extended kinds
 * insert lowercase (the Obsidian convention).
 */
export const insertCalloutCommand = $command(
    "InsertCallout",
    (ctx) => (kind?: string) => (state, dispatch) => {
        const k = calloutKind(kind ?? "note");
        const type = GITHUB_KINDS.has(k) ? k.toUpperCase() : k;
        return wrapIn(calloutSchema.type(ctx), attrsFromMarker(`[!${type}]`, true))(
            state,
            dispatch,
        );
    },
);

/** Parse/serialize plugins, flattened for `Editor.use()` / pureCommonmark. */
export const calloutsPlugin = [
    calloutRemarkPlugin,
    calloutSchema,
    calloutInputRule,
].flat();
