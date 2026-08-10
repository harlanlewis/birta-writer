/**
 * webview/format/mdx/index.ts — the MDX FormatModule (MAR-42), format #2.
 *
 * MDX is markdown plus five structural node kinds (`mdxjsEsm`,
 * `mdxFlowExpression`, `mdxJsxFlowElement`, `mdxTextExpression`,
 * `mdxJsxTextElement`), so this module composes the whole markdown format and
 * adds exactly those. Two rules govern the additions, both consequences of the
 * ticket's title ("never execute document code"):
 *
 * - Every mdx construct is STRUCTURAL and OPAQUE: it enters the editor as the
 *   exact source byte range it was parsed from (`remarkMdxRawify` slices the
 *   file by mdast positions) and serializes back verbatim through the
 *   `mdxRawBlock`/`mdxRawInline` toMarkdown handlers. No expression is
 *   evaluated, no component rendered, no import resolved — an MDX file is a
 *   program, and evaluating any of it would be eval of untrusted file content
 *   in the webview.
 * - Prose editing must never produce invalid MDX: `remark-mdx`'s toMarkdown
 *   extension stays registered even though the mdx nodes themselves serialize
 *   through the raw handlers, because it is what escapes `{` and `<` typed
 *   into ordinary prose (`\{`, `\<`) — in MDX those are syntax, not text.
 *
 * MDX parse errors are fatal (a stray `{` or an unclosed tag throws, unlike
 * markdown where every byte sequence is valid). This module does not soften
 * that: a throwing parse rejects `createEditor`, and the webview's init path
 * turns the rejection into the text-editor fallback. Mid-edit reparse sites
 * (paste, verifiedMerge, reparseHazard) each already treat a parser throw as
 * "decline", which is the correct degradation for transiently invalid states.
 *
 * This module must stay OFF the eager import graph: `format/loader.ts` reaches
 * it only via a cached dynamic `import()`, keyed on the document actually
 * being MDX, so a markdown document costs zero extra bytes and zero work.
 */
import remarkMdx from "remark-mdx";
import { visit } from "unist-util-visit";
import { $nodeSchema, $remark } from "@milkdown/utils";
import type { Node as MdastNode } from "@milkdown/transformer";
import { markdownFormat } from "../markdown";
import type { FormatModule } from "../types";
import { createMdxBlockView, createMdxInlineView } from "./views";

export const mdxBlockId = "mdx_block";
export const mdxInlineId = "mdx_inline";

/** The five mdast node kinds `remark-mdx` produces, by placement. */
const MDX_FLOW_KINDS: ReadonlySet<string> = new Set([
    "mdxjsEsm",
    "mdxFlowExpression",
    "mdxJsxFlowElement",
]);
const MDX_TEXT_KINDS: ReadonlySet<string> = new Set([
    "mdxTextExpression",
    "mdxJsxTextElement",
]);

/** `remark-mdx`: micromark syntax + the `{`/`<` prose-escaping serializer rules. */
export const remarkMdxPlugin = $remark("remarkMdx", () => remarkMdx);

/** Verbatim serializer for the rawified nodes: the bytes ARE the output. */
const rawToMarkdown = (node: { value?: string }): string => node.value ?? "";

/**
 * Replace every mdx mdast node with a raw node carrying its exact source
 * slice, and register the toMarkdown handlers that emit that slice verbatim.
 *
 * Slicing the ORIGINAL SOURCE by position (rather than re-stringifying the
 * structured node) is what makes preservation byte-perfect: attribute quoting,
 * whitespace, JSX children — everything comes back exactly as typed. The cost
 * is that a non-allowlisted island is opaque (its nested markdown is not
 * editable), which is this slice's contract.
 */
type PositionedNode = MdastNode & {
    position?: { start?: { offset?: number }; end?: { offset?: number } };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function remarkMdxRawify(this: any) {
    const data = (this as { data: () => Record<string, unknown[]> }).data();
    const list = (data["toMarkdownExtensions"] ??= []);
    list.push({
        handlers: {
            mdxRawBlock: rawToMarkdown,
            mdxRawInline: rawToMarkdown,
        },
    });
    return (tree: MdastNode, file: unknown) => {
        const source = String(file);
        visit(
            tree,
            (
                node: PositionedNode,
                index: number | undefined,
                parent: (MdastNode & { children: MdastNode[] }) | undefined,
            ) => {
                if (parent == null || index == null) {
                    return undefined;
                }
                const kind = node.type;
                const flow = MDX_FLOW_KINDS.has(kind);
                if (!flow && !MDX_TEXT_KINDS.has(kind)) {
                    return undefined;
                }
                const start = node.position?.start?.offset;
                const end = node.position?.end?.offset;
                if (typeof start !== "number" || typeof end !== "number") {
                    // Positionless mdx nodes cannot be preserved byte-perfect.
                    // remark always attaches positions to parsed nodes, so this
                    // is unreachable from a file open; throwing (→ the fatal
                    // parse fallback) beats silently dropping content.
                    throw new Error(`MDX node without source position: ${kind}`);
                }
                parent.children.splice(index, 1, {
                    type: flow ? "mdxRawBlock" : "mdxRawInline",
                    kind,
                    value: source.slice(start, end),
                } as unknown as MdastNode);
                return "skip";
            },
        );
    };
}

/** Parse-time rawify + the raw nodes' verbatim serializer registration. */
export const remarkMdxRawifyPlugin = $remark("remarkMdxRawify", () => remarkMdxRawify);

type RawMdastNode = MdastNode & { value?: string; kind?: string };

/** Flow-level mdx island: opaque atom block, source bytes in `value`. */
export const mdxBlockSchema = $nodeSchema(mdxBlockId, () => ({
    group: "block",
    atom: true,
    marks: "",
    selectable: true,
    attrs: {
        value: { default: "" },
        kind: { default: "mdxJsxFlowElement" },
    },
    parseDOM: [
        {
            tag: `div[data-type="${mdxBlockId}"]`,
            preserveWhitespace: "full" as const,
            getAttrs: (dom: HTMLElement) => ({
                value: dom.textContent ?? "",
                kind: dom.getAttribute("data-kind") ?? "mdxJsxFlowElement",
            }),
        },
    ],
    toDOM: (node) => [
        "div",
        { "data-type": mdxBlockId, "data-kind": node.attrs["kind"] as string },
        node.attrs["value"] as string,
    ],
    parseMarkdown: {
        match: (node) => node.type === "mdxRawBlock",
        runner: (state, node, type) => {
            const raw = node as RawMdastNode;
            state.addNode(type, {
                value: raw.value ?? "",
                kind: raw.kind ?? "mdxJsxFlowElement",
            });
        },
    },
    toMarkdown: {
        match: (node) => node.type.name === mdxBlockId,
        runner: (state, node) => {
            state.addNode("mdxRawBlock", undefined, node.attrs["value"] as string);
        },
    },
}));

/** Inline mdx island (`{expr}`, inline JSX): opaque atom, source in `value`. */
export const mdxInlineSchema = $nodeSchema(mdxInlineId, () => ({
    group: "inline",
    inline: true,
    atom: true,
    marks: "",
    selectable: true,
    attrs: {
        value: { default: "" },
        kind: { default: "mdxTextExpression" },
    },
    parseDOM: [
        {
            tag: `span[data-type="${mdxInlineId}"]`,
            preserveWhitespace: "full" as const,
            getAttrs: (dom: HTMLElement) => ({
                value: dom.textContent ?? "",
                kind: dom.getAttribute("data-kind") ?? "mdxTextExpression",
            }),
        },
    ],
    toDOM: (node) => [
        "span",
        { "data-type": mdxInlineId, "data-kind": node.attrs["kind"] as string },
        node.attrs["value"] as string,
    ],
    parseMarkdown: {
        match: (node) => node.type === "mdxRawInline",
        runner: (state, node, type) => {
            const raw = node as RawMdastNode;
            state.addNode(type, {
                value: raw.value ?? "",
                kind: raw.kind ?? "mdxTextExpression",
            });
        },
    },
    toMarkdown: {
        match: (node) => node.type.name === mdxInlineId,
        runner: (state, node) => {
            state.addNode("mdxRawInline", undefined, node.attrs["value"] as string);
        },
    },
}));

/** All mdx-specific plugins, flattened for the preset list. */
export const mdxSyntaxPlugins = [
    remarkMdxPlugin,
    remarkMdxRawifyPlugin,
    mdxBlockSchema,
    mdxInlineSchema,
].flat();

/**
 * The MDX format: markdown's presets, serializer config, NodeViews, and
 * minimal-diff profile, plus the five opaque mdx node kinds.
 *
 * The formatProfile is markdown's on purpose: outside the mdx islands MDX's
 * line grammar IS markdown's, and an island's lines key as ordinary content
 * lines — stable, because raw islands only ever change wholesale (their bytes
 * are a single attr, not line-editable). An MDX-specific profile earns its
 * existence only when a divergence is demonstrated by a failing fixture.
 */
export const mdxFormat: FormatModule = {
    presets: [...markdownFormat.presets, mdxSyntaxPlugins],
    configureSerialization: markdownFormat.configureSerialization,
    nodeViews: [
        ...markdownFormat.nodeViews,
        [mdxBlockId, (node) => createMdxBlockView(node as { attrs: Record<string, unknown> })],
        [mdxInlineId, (node) => createMdxInlineView(node as { attrs: Record<string, unknown> })],
    ],
    formatProfile: markdownFormat.formatProfile,
};
