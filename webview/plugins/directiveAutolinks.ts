/**
 * webview/plugins/directiveAutolinks.ts — a template directive stays text at
 * parse time, even where it holds a bare URL or email (MAR-507).
 *
 * GFM reads `https://…`, `www.…` and `a@b.c` in running text as links, with
 * nothing in the source to mark them. Inside `{{ "https://x" | absolute_url }}`
 * that splits the directive across a link mark, so the serializer no longer
 * sees one directive to write as it reads, and on save the URL comes back as
 * `<https://x>` inside the template, which the template engine then reads as
 * part of its string.
 *
 * So a LITERAL autolink, one the source spells as the bare address, becomes
 * plain text again where it lies inside a directive span. "Literal" is read
 * off the source byte at the link's start, or off the link having no source
 * position at all: a `<…>` autolink and a `[…](…)` or reference link were
 * written as links by somebody and are left alone, because turning those into
 * text would drop their brackets. Directive spans come from
 * `findDirectives`, the one grammar the drawing and the serializer also use.
 *
 * A plain recursive walk, as ./tableBreaks.ts and ./sourceStyle.ts do, because
 * `unist-util-visit` is transitive-only under pnpm's strict layout.
 */
import { $remark } from "@milkdown/utils";
import { findDirectives } from "../utils/templateDirectives";

interface MdastNode {
    type: string;
    value?: string;
    children?: MdastNode[];
    position?: { start: { offset?: number }; end: { offset?: number } };
}

/** What stands in for an inline the directive grammar must not cross. */
const PLACEHOLDER = "￼";

/** The text a literal autolink shows, or null when `node` is not one. */
function literalAutolinkText(node: MdastNode, source: string): string | null {
    if (node.type !== "link" || node.children?.length !== 1) return null;
    const [child] = node.children;
    if (child.type !== "text" || typeof child.value !== "string") return null;
    // GFM finds literal addresses by a transform over the DECODED text, after
    // parsing, so an escaped `https\://` is still found, and a link it makes
    // carries no source position. Links written with syntax always have one.
    const offset = node.position?.start.offset;
    if (offset === undefined) return child.value;
    const first = source.charAt(offset);
    return first === "<" || first === "[" ? null : child.value;
}

/** Unwrap the literal autolinks inside a directive among `parent`'s children. */
function unwrapInDirectives(parent: MdastNode, source: string): void {
    const children = parent.children!;
    let text = "";
    const links: Array<{ index: number; from: number; to: number; value: string }> = [];
    children.forEach((child, index) => {
        if (child.type === "text") {
            text += child.value ?? "";
            return;
        }
        const value = literalAutolinkText(child, source);
        if (value !== null) {
            links.push({ index, from: text.length, to: text.length + value.length, value });
            text += value;
            return;
        }
        text += PLACEHOLDER;
    });
    if (links.length === 0) return;
    const spans = findDirectives(text);
    for (const link of links) {
        if (spans.some((span) => span.from <= link.from && link.to <= span.to)) {
            const node = children[link.index];
            children[link.index] = { type: "text", value: link.value, position: node.position };
        }
    }
}

export const directiveAutolinkRemark = $remark(
    "directiveAutolinks",
    // Params widen to `unknown` to satisfy unified's `Transformer` signature.
    () => () => (tree: unknown, file: unknown) => {
        const raw = (file as { value?: unknown }).value;
        if (raw === undefined || raw === null) return;
        const source = String(raw);
        if (source.indexOf("{") < 0) return;
        const walk = (node: MdastNode): void => {
            const children = node.children;
            if (!children) return;
            if (children.some((c) => c.type === "link") && children.some((c) => c.type === "text" && (c.value ?? "").includes("{"))) {
                unwrapInDirectives(node, source);
            }
            children.forEach(walk);
        };
        walk(tree as MdastNode);
    },
);

/** Flattened for `Editor.use()`. */
export const directiveAutolinksPlugin = [directiveAutolinkRemark].flat();
