/**
 * plugins/pasteMarkdown.ts
 *
 * Plain-text paste → Markdown: `clipboardTextParser` runs the clipboard's text
 * through the document's OWN Markdown parser, so pasted source that carries
 * syntax ("# Heading", "- item", "**bold**") lands as real nodes instead of
 * literal text the serializer then escapes back out as "\# Heading". This
 * closes a copy/paste asymmetry — copyMarkdown already WRITES Markdown to the
 * clipboard's plain-text flavor, so until now the editor could not read back
 * what it had itself just copied (via `vscode.env.clipboard`, or any hop that
 * drops the rich flavor).
 *
 * The scope is narrow because ProseMirror only consults this prop once it has
 * decided to treat the clipboard AS text (`parseFromClipboard`):
 *   - a rich `text/html` flavor wins outright, so pasting from a browser, from
 *     Word, or from another ProseMirror still takes the DOM path;
 *   - inside a code block PM returns the raw text before reaching us, so a
 *     fenced block never reinterprets its own payload.
 *
 * It also covers DROPPING text in from outside the editor, which PM routes
 * through the same `parseFromClipboard` — deliberately, so a dragged-in
 * Markdown snippet and a pasted one land the same way. Dragging WITHIN the
 * document carries a real slice and never reaches here.
 *
 * Two hatches, mirroring the copy side:
 *   - `plain` (Shift+Cmd+V) declines for that one paste, giving PM's literal
 *     one-paragraph-per-line default;
 *   - birta.pasteFormat: "plainText" declines every time. Read at paste time
 *     from the __i18n bootstrap (the copyFormat pattern — no live rebuild).
 *
 * Declining means returning a FALSY value: `someProp` keeps looking and then
 * PM falls back to its own text handling. The prop's declared return type is a
 * bare `Slice` with no null in it, hence the single cast at the boundary.
 */
import { parserCtx } from "@milkdown/core";
import { $prose } from "@milkdown/utils";
import { Plugin, Slice } from "@/pm";
import type { Node as ProseNode } from "@/pm";

/**
 * Parses clipboard text as a Markdown document and returns it as a slice, or
 * null to defer to ProseMirror's literal-text default.
 *
 * A paste landing inside a table cell needs no special case HERE: whatever
 * blocks this produces, plugins/pasteTableCell.ts flattens to inline content
 * afterwards in `transformPasted` (MAR-274), which is also what keeps the
 * literal path from widening the table.
 */
export function markdownSliceFromText(
    parse: (markdown: string) => ProseNode | null,
    text: string,
): Slice | null {
    // Whitespace-only clipboards carry no syntax to recover and parse to an
    // empty document; let the default insert the characters as they are.
    if (!text.trim()) { return null; }
    try {
        const doc = parse(text);
        if (!doc || doc.content.size === 0) { return null; }
        // The open depths here are advisory: parseFromClipboard discards them
        // and re-derives its own with Slice.maxOpen + normalizeSiblings against
        // the paste context. That is what lets a single pasted paragraph merge
        // inline into the caret's textblock while a pasted heading stays a
        // heading — so this must NOT try to pre-empt the decision.
        return new Slice(doc.content, 0, 0);
    } catch {
        // A parser throw must never eat the user's paste — fall back to text.
        return null;
    }
}

export const pasteMarkdownPlugin = $prose((ctx) =>
    new Plugin({
        props: {
            clipboardTextParser(text, _$context, plain) {
                // Falsy return = "not handled"; the prop type has no null.
                const declined = null as unknown as Slice;
                if (plain || window.__i18n?.pasteFormat === "plainText") { return declined; }
                return markdownSliceFromText(ctx.get(parserCtx), text) ?? declined;
            },
        },
    }));
