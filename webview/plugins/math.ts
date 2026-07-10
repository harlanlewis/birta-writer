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
 *  - `mathInlineSchema` models inline math as a node whose text CONTENT is the
 *    LaTeX source (per-character caret editing, MAR-74); rendering is handled by
 *    the NodeView in components/math (lazy KaTeX), and the reveal-source-on-
 *    caret-entry behavior by mathInlineEdit.ts.
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
import { NodeSelection, TextSelection } from "@milkdown/prose/state";
import { InputRule, textblockTypeInputRule } from "@milkdown/prose/inputrules";
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
 * An inline `$...$` is only real math when its inner content has non-space edges
 * (mirrors INLINE_MATH_RULE_REGEX). `remark-math` has NO such guard, so on parse
 * it turns "costs $5 and $10" into an `inlineMath` node (value `"5 and "`, note
 * the trailing space). The typing input rule already refuses that shape, but a
 * loaded document bypasses the input rule entirely — so without this guard the
 * same currency renders as math. Keep the two paths consistent.
 */
export function isRealInlineMath(value: string): boolean {
    return value.length > 0 && !/^\s|\s$/.test(value);
}

/**
 * Revert currency-shaped `inlineMath` nodes back to literal `$...$` text so
 * loaded documents render dollar amounts as prose, matching the typing guard.
 */
function visitInlineMathGuard(ast: MdastNode): void {
    visit(
        ast,
        "inlineMath",
        (
            node: MdastNode & { value: string },
            index: number | undefined,
            parent: (MdastNode & { children: MdastNode[] }) | undefined,
        ) => {
            if (parent == null || index == null) return;
            if (isRealInlineMath(node.value)) return;
            parent.children.splice(index, 1, {
                type: "text",
                value: `$${node.value}$`,
            } as unknown as MdastNode);
        },
    );
}

/** Parse-time currency guard for inline math (see isRealInlineMath). */
export const remarkInlineMathGuardPlugin = $remark(
    "remarkInlineMathGuard",
    () => () => visitInlineMathGuard,
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
/**
 * Inline math holds its LaTeX source as REAL TEXT CONTENT (not an attr), so the
 * caret can walk into it character-by-character like inline code (MAR-74). The
 * NodeView (components/math) shows rendered KaTeX while the caret is outside and
 * the raw source while it's inside; `mathInlineEditPlugin` (mathInlineEdit.ts)
 * owns that reveal behavior. `code: true` makes prosemirror-inputrules skip
 * input rules inside the formula (typing `**x**` in LaTeX must stay literal),
 * and `marks: ""` keeps the source a plain-text run.
 */
export const mathInlineSchema = $nodeSchema(mathInlineId, () => ({
    group: "inline",
    inline: true,
    content: "text*",
    marks: "",
    code: true,
    draggable: true,
    parseDOM: [
        {
            tag: `span[data-type="${mathInlineId}"]`,
            // The source is the element's text content (the toDOM hole below);
            // older clipboard HTML also carried it as text, so one rule covers both.
        },
    ],
    toDOM: () => ["span", { "data-type": mathInlineId }, 0],
    parseMarkdown: {
        match: (node) => node.type === "inlineMath",
        runner: (state, node, type) => {
            const value = (node["value"] as string) ?? "";
            state.openNode(type);
            if (value) {
                state.addText(value);
            }
            state.closeNode();
        },
    },
    toMarkdown: {
        match: (node) => node.type.name === mathInlineId,
        runner: (state, node) => {
            state.addNode("inlineMath", undefined, node.textContent);
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

export const mathInlineInputRule = $inputRule((ctx) => {
    const type = mathInlineSchema.type(ctx);
    // A plain InputRule (not nodeRule): the LaTeX lives as the node's text
    // CONTENT, which nodeRule's attr-only factory can't create.
    return new InputRule(INLINE_MATH_RULE_REGEX, (state, match, start, end) => {
        const value = match[1];
        if (!value) {
            return null;
        }
        const node = type.create(null, state.schema.text(value));
        return state.tr.replaceRangeWith(start, end, node);
    });
});

/** Block input rule: typing `$$` then a space/newline starts a LaTeX block. */
export const mathBlockInputRule = $inputRule((ctx) =>
    textblockTypeInputRule(/^\$\$[\s\n]$/, codeBlockSchema.type(ctx), () => ({
        language: "LaTeX",
    })),
);

/**
 * Toggle inline math over the selection (toolbar button / command).
 * With text selected, wraps it as `$...$` and places the caret inside (so the
 * revealed source is immediately editable); with the caret inside an existing
 * inline math node (or one node-selected), unwraps it back to plain text.
 */
export const insertInlineMathCommand = $command(
    "InsertInlineMath",
    (ctx) => () => (state, dispatch) => {
        const mathType = mathInlineSchema.type(ctx);
        const { selection, doc, tr } = state;
        const { $from, $to } = selection;

        // Unwrap: the caret sits inside a math node's source, or one is selected.
        let mathPos = -1;
        let mathNode = null;
        if (selection instanceof NodeSelection && selection.node.type === mathType) {
            mathPos = selection.from;
            mathNode = selection.node;
        } else if ($from.parent.type === mathType) {
            mathPos = $from.before();
            mathNode = $from.parent;
        }
        if (mathNode) {
            const content = mathNode.textContent;
            let next = tr.delete(mathPos, mathPos + mathNode.nodeSize);
            if (content) {
                next = next.insertText(content, mathPos);
            }
            if (dispatch) {
                dispatch(next.setSelection(
                    TextSelection.create(next.doc, mathPos, mathPos + content.length),
                ));
            }
            return true;
        }

        // Refuse where inline math cannot live (e.g. inside a code block, or
        // with a block node selected): replaceSelectionWith would re-fit the
        // content elsewhere.
        const toIndex = $to.sameParent($from) ? $to.index() : $from.index();
        if (!$from.parent.canReplaceWith($from.index(), toIndex, mathType)) {
            return false;
        }
        const text = doc.textBetween(selection.from, selection.to);
        const node = mathType.create(null, text ? state.schema.text(text) : null);
        const next = tr.replaceSelectionWith(node);
        if (dispatch) {
            // Belt and braces: only move the caret inside if the node actually
            // landed at selection.from. Caret inside-at-end reveals the source
            // (mathInlineEdit) so an empty insert is immediately typable.
            if (next.doc.nodeAt(selection.from)?.type === mathType) {
                next.setSelection(
                    TextSelection.create(next.doc, selection.from + 1 + text.length),
                );
            }
            dispatch(next);
        }
        return true;
    },
);

/** All math plugins, flattened for `Editor.use()` / the pureCommonmark preset. */
export const mathPlugin = [
    remarkMathPlugin,
    remarkMathBlockPlugin,
    remarkInlineMathGuardPlugin,
    mathInlineSchema,
    blockLatexSchema,
    mathInlineInputRule,
    mathBlockInputRule,
    insertInlineMathCommand,
].flat();
