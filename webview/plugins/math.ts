/**
 * KaTeX math support — inline `$...$` and block `$$...$$`.
 *
 * Ported from `@milkdown/crepe`'s `feature/latex` (7.21.2) but WITHOUT taking a
 * dependency on Crepe itself, and adapted to this project's own code-block UI
 * (the Crepe original drives a CodeMirror `renderPreview`; here block math is
 * previewed by the existing NodeView in components/codeBlock).
 *
 * Pipeline:
 *  - `remarkMathPlugin` wraps `remark-math`, so the mdast parser understands
 *    `$...$` (→ `inlineMath`) and `$$...$$` (→ `math`) and — crucially — the
 *    stringifier learns to serialize those node types BACK to dollar syntax.
 *  - `remarkMathBlockPlugin` rewrites every block-level `math` mdast node into a
 *    `code` node with `lang: "LaTeX"` on parse, so block math flows through the
 *    EXISTING fenced-code-block machinery (schema, NodeView, serializer).
 *  - `blockLatexSchema` extends the commonmark `code_block` schema so a
 *    LaTeX-language code block serializes back to a `math` mdast node (→ `$$`).
 *  - `mathInlineSchema` models the inline atom; its DOM rendering is handled by
 *    the NodeView in components/math (lazy KaTeX), not by this schema's `toDOM`.
 *  - input rules convert typed `$...$` / `$$ ` into math on the fly.
 *  - `insertInlineMathCommand` powers the toolbar button.
 *
 * Differences from the Crepe source worth noting:
 *  - Crepe's inline input rule (`/(?:\$)([^$]+)(?:\$)$/`) has NO currency guard,
 *    so "costs $5 and $10" would wrongly become math. Ours requires non-space
 *    inner edges and a negative lookbehind on `\`/`$`, so currency and escaped
 *    dollars are left alone.
 *  - Crepe's inline `toDOM` calls `katex.render` synchronously, forcing KaTeX
 *    into the main bundle. Ours renders through a lazy NodeView instead.
 */
import type { Node as MdastNode } from "@milkdown/transformer";
import { codeBlockSchema } from "@milkdown/preset-commonmark";
import { findNodeInSelection, nodeRule } from "@milkdown/prose";
import { NodeSelection, TextSelection } from "@milkdown/prose/state";
import { textblockTypeInputRule } from "@milkdown/prose/inputrules";
import { $command, $inputRule, $nodeSchema, $remark } from "@milkdown/utils";
import remarkMath from "remark-math";
import { visit } from "unist-util-visit";

export const mathInlineId = "math_inline";

/** `remark-math`: teaches the parser/stringifier the `$...$` / `$$...$$` syntax. */
export const remarkMathPlugin = $remark("remarkMath", () => remarkMath);

/** Rewrite block-level `math` mdast nodes into `code` nodes (`lang: "LaTeX"`). */
function visitMathBlock(ast: MdastNode): void {
    visit(
        ast,
        "math",
        (
            node: MdastNode & { value: string },
            index: number | undefined,
            parent: (MdastNode & { children: MdastNode[] }) | undefined,
        ) => {
            if (parent == null || index == null) return;
            parent.children.splice(index, 1, {
                type: "code",
                lang: "LaTeX",
                value: node.value,
            } as unknown as MdastNode);
        },
    );
}

/** Turn a block math node into a LaTeX code block so the code machinery owns it. */
export const remarkMathBlockPlugin = $remark(
    "remarkMathBlock",
    () => () => visitMathBlock,
);

/**
 * Serialize a LaTeX-language `code_block` back to a `math` mdast node so it
 * round-trips as `$$...$$` instead of a fenced ```` ```LaTeX ```` block.
 */
export const blockLatexSchema = codeBlockSchema.extendSchema((prev) => (ctx) => {
    const baseSchema = prev(ctx);
    return {
        ...baseSchema,
        toMarkdown: {
            match: baseSchema.toMarkdown.match,
            runner: (state, node) => {
                const language = (node.attrs["language"] as string) ?? "";
                if (language.toLowerCase() === "latex") {
                    state.addNode(
                        "math",
                        undefined,
                        node.content.firstChild?.text || "",
                    );
                } else {
                    baseSchema.toMarkdown.runner(state, node);
                }
            },
        },
    };
});

/**
 * Inline math atom. Rendering into DOM is done by the NodeView
 * (components/math); this schema's `toDOM`/`parseDOM` only need to preserve the
 * value for clipboard round-trips, so no synchronous KaTeX is pulled in here.
 */
export const mathInlineSchema = $nodeSchema(mathInlineId, () => ({
    group: "inline",
    inline: true,
    draggable: true,
    atom: true,
    attrs: {
        value: { default: "" },
    },
    parseDOM: [
        {
            tag: `span[data-type="${mathInlineId}"]`,
            getAttrs: (dom) => ({
                value: (dom as HTMLElement).dataset["value"] ?? "",
            }),
        },
    ],
    toDOM: (node) => {
        const value = node.attrs["value"] as string;
        return [
            "span",
            { "data-type": mathInlineId, "data-value": value },
            value,
        ];
    },
    parseMarkdown: {
        match: (node) => node.type === "inlineMath",
        runner: (state, node, type) => {
            state.addNode(type, { value: node["value"] as string });
        },
    },
    toMarkdown: {
        match: (node) => node.type.name === mathInlineId,
        runner: (state, node) => {
            state.addNode("inlineMath", undefined, node.attrs["value"] as string);
        },
    },
}));

/**
 * Inline input rule: typed `$...$` becomes inline math.
 *
 * Guards vs. the Crepe original:
 *  - `(?<![\\$])` — the opening `$` may not follow a backslash (escaped `\$`)
 *    or another `$` (that is block math, handled separately).
 *  - inner content must have non-space edges, so "costs $5 and $10" (a space
 *    before the closing `$`) is NOT converted, but "$a + b$" is.
 */
export const INLINE_MATH_RULE_REGEX = /(?<![\\$])\$([^\s$](?:[^$]*[^\s$])?)\$$/;

export const mathInlineInputRule = $inputRule((ctx) =>
    nodeRule(INLINE_MATH_RULE_REGEX, mathInlineSchema.type(ctx), {
        getAttr: (match) => ({ value: match[1] ?? "" }),
    }),
);

/** Block input rule: typing `$$` then a space/newline starts a LaTeX block. */
export const mathBlockInputRule = $inputRule((ctx) =>
    textblockTypeInputRule(/^\$\$[\s\n]$/, codeBlockSchema.type(ctx), () => ({
        language: "LaTeX",
    })),
);

/**
 * Toggle inline math over the selection (toolbar button / command).
 * With text selected, wraps it as `$...$`; with the caret inside an existing
 * inline math node, unwraps it back to plain text. Ported from Crepe's
 * `toggleLatexCommand`.
 */
export const insertInlineMathCommand = $command(
    "InsertInlineMath",
    (ctx) => () => (state, dispatch) => {
        const mathType = mathInlineSchema.type(ctx);
        const {
            hasNode: hasMath,
            pos: mathPos,
            target: mathNode,
        } = findNodeInSelection(state, mathType);

        const { selection, doc, tr } = state;
        if (!hasMath) {
            const text = doc.textBetween(selection.from, selection.to);
            const next = tr.replaceSelectionWith(mathType.create({ value: text }));
            if (dispatch) {
                dispatch(
                    next.setSelection(
                        NodeSelection.create(next.doc, selection.from),
                    ),
                );
            }
            return true;
        }

        if (!mathNode || mathPos < 0) return false;
        const { from, to } = selection;
        const content = mathNode.attrs["value"] as string;
        let next = tr.delete(mathPos, mathPos + 1);
        next = next.insertText(content, mathPos);
        if (dispatch) {
            dispatch(
                next.setSelection(
                    TextSelection.create(next.doc, from, to + content.length - 1),
                ),
            );
        }
        return true;
    },
);

/** All math plugins, flattened for `Editor.use()` / the pureCommonmark preset. */
export const mathPlugin = [
    remarkMathPlugin,
    remarkMathBlockPlugin,
    mathInlineSchema,
    blockLatexSchema,
    mathInlineInputRule,
    mathBlockInputRule,
    insertInlineMathCommand,
].flat();
