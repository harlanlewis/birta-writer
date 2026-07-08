/**
 * Notion callouts — `<aside>` blocks from Notion's "Export as Markdown & CSV"
 * (the only block Notion itself documents: "Callout blocks will be exported
 * as HTML, as there is no Markdown equivalent"). Verified byte shape:
 *
 *   <aside>
 *   💡 First line, emoji + one space + text, markdown inside.
 *
 *   </aside>
 *
 * CommonMark parses this as HTML blocks that end at blank lines, so the
 * mdast arrives as: html("<aside>\n💡 First line…") — the raw UNPARSED
 * first segment — then any blank-line-separated inner content as normal
 * parsed blocks, then html("</aside>"). Without a blank line before the
 * closer, the whole aside is ONE html node.
 *
 * The transform pairs those nodes into a `notion_callout` block: the raw
 * first segment (icon stripped) is sub-parsed with the SAME processor
 * (`this.parse` inside the remark plugin), and the already-parsed between
 * blocks are adopted as-is. This plugin must be registered BEFORE the
 * commonmark preset in pureCommonmark so the preset's own transforms
 * (remarkLineBreak, remarkMarker, …) still run over the injected children —
 * otherwise soft breaks and emphasis-marker data would diverge from a
 * normal parse.
 *
 * Fidelity: the serializer reconstructs the exact byte shape — `<aside>`
 * line, icon + space prefix, containerFlow of the children, and the
 * blank-line-before-closer recorded in `closeGap` (a self-contained single
 * html block had no blank line; a separate `</aside>` node means there was
 * one). Shapes outside the verified grammar degrade to today's inert
 * sanitized-HTML rendering, byte-preserved: the `<img>`-icon variant, an
 * `<aside>` with a blank line straight after the opener, an unclosed
 * `<aside>`, and asides indented inside list items.
 */
import { $nodeSchema, $remark } from "@milkdown/utils";
import { calloutKind, type CalloutKind } from "./callouts";

export const notionCalloutId = "notion_callout";

// ─── Icon handling ──────────────────────────────────────────────────────────

/**
 * A leading emoji (pictographic base, optional variation selectors / ZWJ
 * sequences) followed by whitespace OR the end of the segment — the
 * end-of-segment alternative keeps the icon an ICON when a callout's body
 * has been emptied in the editor (`<aside>\n💡\n\n</aside>` reloads with
 * 💡 as the icon, not as body text). `⚠️` is U+26A0 U+FE0F; `💡` is a single
 * pictographic; keycaps like `1️⃣` start with an ASCII digit and never match.
 */
const ICON_RE =
    /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*\uFE0F?)(?:[ \t]+|$)/u;

/** Splits a leading `💡 ` icon off a raw first-segment string. */
export function extractIcon(raw: string): { icon: string; rest: string } {
    const m = ICON_RE.exec(raw);
    return m ? { icon: m[1] ?? "", rest: raw.slice(m[0].length) } : { icon: "", rest: raw };
}

/**
 * Accent kind for a Notion emoji icon (the notion2obsidian mapping family).
 * Lookup on the base codepoint (variation selector stripped); anything
 * unrecognized styles as "note" while the emoji itself stays the icon.
 */
const ICON_KINDS: Record<string, CalloutKind> = {
    "💡": "tip",
    "⚠": "warning",
    "🚨": "warning",
    "❗": "important",
    "📢": "important",
    "⛔": "danger",
    "🚫": "danger",
    "🔥": "danger",
    "ℹ": "info",
    "💬": "info",
    "📝": "note",
    "✏": "note",
    "❓": "question",
    "❔": "question",
    "✅": "success",
    "✔": "success",
    "🐛": "bug",
    "📋": "abstract",
};

/** Kind for an icon string ("" or unknown → "note"). */
export function kindForIcon(icon: string): CalloutKind {
    const base = icon.replace(/\uFE0F/g, "");
    return ICON_KINDS[base] ?? calloutKind("note");
}

// ─── Parse: html-block pairing → notionCallout tree transform ───────────────

interface AsideMdastNode {
    type: string;
    value?: string;
    icon?: string;
    closeGap?: boolean;
    children?: AsideMdastNode[];
}

const OPEN_PREFIX = "<aside>\n";
const SELF_CONTAINED_END = /\n<\/aside>\s*$/;

function makeAside(
    rawFirst: string,
    between: AsideMdastNode[],
    closeGap: boolean,
    parse: (md: string) => { children?: AsideMdastNode[] },
): AsideMdastNode {
    const { icon, rest } = extractIcon(rawFirst);
    const lead = rest.trim() !== "" ? (parse(rest).children ?? []) : [];
    const children = [...lead, ...between];
    return {
        type: "notionCallout",
        icon,
        closeGap,
        children: children.length > 0 ? children : [{ type: "paragraph", children: [] }],
    };
}

/**
 * True when a raw first segment is convertible: non-empty (the verified
 * Notion shape has content on the line right after `<aside>`) and not the
 * `<img src="https://www.notion.so/icons/…">` icon variant — an inner tag
 * would sub-parse into a fresh html block whose rendering (external image
 * under the webview CSP) is worse than the inert sanitized preview.
 */
function convertibleFirstSegment(rawFirst: string): boolean {
    const trimmed = rawFirst.trim();
    return trimmed !== "" && !trimmed.startsWith("<");
}

/**
 * Scans one parent's children for aside runs and wraps them. Anything
 * outside the verified grammar stays inert html.
 */
function wrapAsides(
    children: AsideMdastNode[],
    parse: (md: string) => { children?: AsideMdastNode[] },
): AsideMdastNode[] {
    const out: AsideMdastNode[] = [];
    let i = 0;

    outer: while (i < children.length) {
        const node = children[i]!;
        if (
            node.type === "html" &&
            typeof node.value === "string" &&
            node.value.startsWith(OPEN_PREFIX)
        ) {
            const value = node.value;
            if (SELF_CONTAINED_END.test(value)) {
                // `<aside>\ncontent\n</aside>` in one block: no blank line
                // before the closer existed.
                const rawFirst = value
                    .slice(OPEN_PREFIX.length)
                    .replace(SELF_CONTAINED_END, "");
                if (convertibleFirstSegment(rawFirst)) {
                    out.push(makeAside(rawFirst, [], false, parse));
                    i++;
                    continue;
                }
            } else {
                const rawFirst = value.slice(OPEN_PREFIX.length);
                if (convertibleFirstSegment(rawFirst)) {
                    for (let j = i + 1; j < children.length; j++) {
                        const sib = children[j]!;
                        if (
                            sib.type === "html" &&
                            typeof sib.value === "string" &&
                            sib.value.trim() === "</aside>"
                        ) {
                            out.push(
                                makeAside(rawFirst, children.slice(i + 1, j), true, parse),
                            );
                            i = j + 1;
                            continue outer;
                        }
                    }
                    // No closer before the parent ends — stays inert html.
                }
            }
        }
        out.push(node);
        i++;
    }

    return out;
}

// toMarkdown: reconstruct the exact Notion byte shape around the standard
// flow serialization of the children.
const notionCalloutToMarkdown = {
    handlers: {
        notionCallout(
            node: AsideMdastNode,
            _parent: unknown,
            state: any,
            info: unknown,
        ): string {
            const exit = state.enter("notionCallout");
            const tracker = state.createTracker(info);
            const flow: string = state.containerFlow(
                { ...node, type: "notionCallout" },
                tracker.current(),
            );
            const icon = node.icon ? `${node.icon} ` : "";
            const body = flow === "" ? icon.trimEnd() : `${icon}${flow}`;
            const value = `<aside>\n${body}${node.closeGap ? "\n\n" : "\n"}</aside>`;
            exit();
            return value;
        },
    },
};

function remarkNotionCallouts(this: any): (tree: unknown) => void {
    const data = this.data();
    const list = data["toMarkdownExtensions"] ?? (data["toMarkdownExtensions"] = []);
    list.push(notionCalloutToMarkdown);

    const processor = this;
    return (tree: unknown) => {
        const parse = (md: string) => processor.parse(md) as { children?: AsideMdastNode[] };
        const walk = (node: AsideMdastNode): void => {
            if (!node.children) return;
            node.children.forEach(walk);
            node.children = wrapAsides(node.children, parse);
        };
        walk(tree as AsideMdastNode);
    };
}

export const notionCalloutRemarkPlugin = $remark(
    "remarkNotionCallouts",
    () => remarkNotionCallouts,
);

// ─── ProseMirror schema ─────────────────────────────────────────────────────

export const notionCalloutSchema = $nodeSchema(notionCalloutId, () => ({
    content: "block+",
    group: "block",
    defining: true,
    attrs: {
        icon: { default: "" },
        kind: { default: "note" },
        closeGap: { default: true },
    },
    parseDOM: [
        {
            tag: 'div[data-type="notion-callout"]',
            getAttrs: (dom) => {
                const el = dom as HTMLElement;
                const icon = el.dataset["icon"] ?? "";
                return {
                    icon,
                    kind: kindForIcon(icon),
                    closeGap: el.dataset["closeGap"] !== "false",
                };
            },
        },
    ],
    toDOM: (node) => [
        "div",
        {
            "data-type": "notion-callout",
            "data-kind": node.attrs["kind"] as string,
            "data-icon": node.attrs["icon"] as string,
            "data-close-gap": String(node.attrs["closeGap"]),
            class: "callout callout-aside",
        },
        0,
    ],
    parseMarkdown: {
        match: (node) => node.type === "notionCallout",
        runner: (state, node, type) => {
            const icon = (node["icon"] as string) ?? "";
            state
                .openNode(type, {
                    icon,
                    kind: kindForIcon(icon),
                    closeGap: (node["closeGap"] as boolean) ?? true,
                })
                .next(node.children)
                .closeNode();
        },
    },
    toMarkdown: {
        match: (node) => node.type.name === notionCalloutId,
        runner: (state, node) => {
            state
                .openNode("notionCallout", undefined, {
                    icon: node.attrs["icon"] as string,
                    closeGap: node.attrs["closeGap"] as boolean,
                })
                .next(node.content)
                .closeNode();
        },
    },
}));

/**
 * The two halves register at DIFFERENT positions in pureCommonmark:
 * - `notionCalloutRemarkPlugin` FIRST, so preset transforms still process
 *   the sub-parsed children this transform injects (see module doc);
 * - `notionCalloutSchema` AFTER the preset — schema registration order
 *   decides which node type ProseMirror's createAndFill picks to satisfy a
 *   `block+` content match, and a block whose own content is `block+`
 *   registered before `paragraph` recurses infinitely.
 */
export const notionCalloutRemark = [notionCalloutRemarkPlugin].flat();
export const notionCalloutNodes = [notionCalloutSchema].flat();
