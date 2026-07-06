/**
 * Line breaks inside table cells (MAR-17).
 *
 * Shift+Enter inserts a `hardbreak` node, and preset-commonmark already binds
 * that shortcut and lets the node live inside a table cell (a cell's content is
 * a paragraph, and a hardbreak is inline). The break was lost only on SAVE:
 * mdast-util-to-markdown's `hardBreak` handler, seeing the `tableCell`
 * construct on the serializer stack (entered by `serializeTableNoAlign` in
 * ../serialization.ts), cannot emit an end-of-line and silently degrades the
 * break to a SPACE — so `a<br>b` round-tripped as `a b`. Separately, a `<br>`
 * already present in a cell arrived as the read-only inline `html` atom rather
 * than a real, editable line break.
 *
 * This module fixes both ends of the round trip:
 *
 * - A parse-time `$remark` visitor rewrites inline `<br>` html atoms INSIDE
 *   table cells into real `break` mdast nodes, recording the original bytes
 *   (`<br>` / `<br/>` / `<br />`) on `data.htmlVariant`. This pulls them off
 *   the read-only html-atom path so they render as genuine line breaks. The
 *   visitor is scoped to `tableCell`, so standalone `<br />` html elsewhere in
 *   a document keeps its existing inert-atom behavior.
 * - The `hardbreak` schema is extended with a `variant` attr that carries
 *   those recorded bytes through ProseMirror: `parseMarkdown` reads
 *   `data.htmlVariant`, `toMarkdown` re-attaches it. The stock `isInline`
 *   behavior (soft breaks emitted by `remarkLineBreak`) is preserved.
 *
 * The serializer side (emitting the recorded `<br>` bytes instead of the
 * space-fallback) lives in `serializeTableNoAlign` (../serialization.ts),
 * which pre-transforms `break` nodes into `html` nodes before phrasing so the
 * verbatim html handler wins over the hardBreak space fallback.
 *
 * Shift+Enter needs no new keymap: the gfm `tableKeymap` only binds `Enter` /
 * `Mod-Enter` (ExitTable) and `Tab` (cell navigation), so it never swallows
 * Shift+Enter, and header cells accept a hardbreak the same as body cells.
 */
import { hardbreakSchema } from "@milkdown/preset-commonmark";
import { $remark } from "@milkdown/utils";

/** Matches an inline `<br>` / `<br/>` / `<br />` html atom (case-insensitive). */
const BR_RE = /^<br\s*\/?>$/i;

/** Minimal shape of the mdast nodes the parse-time visitor inspects. */
interface BreakMdastNode {
    type: string;
    value?: string;
    data?: { htmlVariant?: string; isInline?: boolean };
    children?: BreakMdastNode[];
}

/**
 * Parse-time visitor: inside `tableCell` mdast nodes, convert inline `<br>`
 * html atoms into real `break` nodes, recording the original bytes on
 * `data.htmlVariant`. remark-gfm parses tables at PARSE time, so `tableCell`
 * nodes already exist by the time this transformer runs regardless of plugin
 * order. A plain recursive walk avoids importing `unist-util-visit`, which is
 * transitive-only under pnpm's strict layout (mirrors ./sourceStyle.ts).
 */
export const tableBreakRemark = $remark(
    "tableCellBreaks",
    // Params widen to `unknown` to satisfy unified's `Transformer` signature
    // (contravariant); the concrete mdast shape is recovered by the cast below.
    () => () => (tree: unknown) => {
        // Rewrite `<br>` html children of a cell (recursing through phrasing
        // wrappers like strong/emphasis) into `break` nodes.
        const convertCell = (node: BreakMdastNode): void => {
            if (!node.children) return;
            node.children = node.children.map((child) => {
                if (
                    child.type === "html" &&
                    typeof child.value === "string" &&
                    BR_RE.test(child.value.trim())
                ) {
                    return { type: "break", data: { htmlVariant: child.value.trim() } };
                }
                convertCell(child);
                return child;
            });
        };

        const walk = (node: BreakMdastNode): void => {
            if (node.type === "tableCell") {
                convertCell(node);
                return;
            }
            node.children?.forEach(walk);
        };

        walk(tree as BreakMdastNode);
    },
);

/**
 * `hardbreak` schema extended with a `variant` attr recording the original
 * `<br>` byte spelling (`<br>` / `<br/>` / `<br />`) when the break came from
 * an html atom inside a table cell. Empty (`""`) means "created in the editor"
 * or "a plain hard break" — no recorded spelling, so the serializer default
 * applies. The stock `isInline` attr (soft breaks from `remarkLineBreak`) is
 * carried through unchanged.
 */
export const hardbreakTableBreakSchema = hardbreakSchema.extendSchema((prev) => (ctx) => {
    const base = prev(ctx);
    return {
        ...base,
        attrs: { ...base.attrs, variant: { default: "", validate: "string" } },
        parseMarkdown: {
            match: ({ type }: { type: string }) => type === "break",
            runner: (state: any, node: any, type: any) => {
                const variant =
                    typeof node.data?.htmlVariant === "string" ? node.data.htmlVariant : "";
                state.addNode(type, { isInline: Boolean(node.data?.isInline), variant });
            },
        },
        toMarkdown: {
            match: (node: any) => node.type.name === "hardbreak",
            runner: (state: any, node: any) => {
                if (node.attrs.isInline) {
                    state.addNode("text", undefined, "\n");
                    return;
                }
                const variant = node.attrs.variant;
                state.addNode(
                    "break",
                    undefined,
                    undefined,
                    variant ? { data: { htmlVariant: variant } } : undefined,
                );
            },
        },
    };
});

/**
 * The original preset plugins this module replaces. `pureCommonmark`
 * (../serialization.ts) filters these out of the commonmark preset before
 * adding `tableBreaksPlugin`, so only the extended `hardbreak` schema registers.
 */
export const tableBreakReplacedPlugins = new Set<unknown>([
    hardbreakSchema.ctx,
    hardbreakSchema.node,
]);

/** All table-break plugins, flattened for `Editor.use()`. */
export const tableBreaksPlugin = [
    ...tableBreakRemark,
    ...hardbreakTableBreakSchema,
].flat();
