/**
 * plugins/copyMarkdown.ts
 *
 * Native copy/cut → Markdown: `clipboardTextSerializer` replaces the
 * clipboard's PLAIN-TEXT flavor with the selection serialized back to Markdown
 * source, so pasting into any plain-text target (another markdown file, a chat
 * box, the raw editor) keeps the syntax instead of flattening it. Only the
 * plain flavor changes — ProseMirror still writes its rich HTML flavor
 * alongside, so pasting back into the editor (or into a rich-text app) keeps
 * full structure.
 *
 * Gated per copy on birta.copyFormat: "richText" returns "" (falsy), which
 * makes ProseMirror fall back to its default plain rendition. Read at copy
 * time from the __i18n bootstrap (the smartLinks pattern — no live update).
 */
import { schemaCtx, serializerCtx } from "@milkdown/core";
import { $prose } from "@milkdown/utils";
import { Fragment, Plugin } from "@/pm";
import type { Node as ProseNode, Schema, Slice } from "@/pm";

/**
 * Serializes a clipboard slice to Markdown by rebuilding a standalone document
 * around it. Slices are "open" at their ends (a mid-paragraph selection keeps
 * its partial paragraph wrapper), so the fragment's children are normally
 * valid doc content already; the two exceptions are wrapped back into a valid
 * parent first. Returns "" when the content can't form a document — the falsy
 * result defers to ProseMirror's plain-text default.
 */
export function markdownOfSlice(
    serialize: (doc: ProseNode) => string,
    schema: Schema,
    slice: Slice,
): string {
    try {
        let content = slice.content;
        // A selection strictly INSIDE one textblock (the slice is open at
        // both ends and holds a single-child chain down to one textblock)
        // copies as INLINE markdown, not a block: re-serializing the block
        // wrapper adds syntax the user never selected — "Hello" out of
        // "# Hello World" became "# Hello", "alpha" inside a list item
        // became "- alpha", and one line of a fenced code block gained
        // fences and a language tag (hostile to a terminal paste). Inline
        // marks still travel ("**bold**"); code blocks defer to the plain
        // rendition outright (nothing markdown-flavored inside a fence).
        // Whole-block copies (block selection, the block menu, cross-block
        // ranges) arrive closed or multi-child and keep full Markdown.
        if (slice.openStart > 0 && slice.openEnd > 0 && content.childCount === 1) {
            let only: ProseNode | null = content.firstChild;
            while (only && !only.isTextblock && only.childCount === 1) {
                only = only.firstChild;
            }
            if (only?.isTextblock) {
                if (only.type.name === "code_block") { return ""; }
                const para = schema.nodes["paragraph"]!.createChecked(null, only.content);
                const doc = schema.topNodeType.createChecked(null, Fragment.from(para));
                return serialize(doc).replace(/\n+$/, "");
            }
        }
        // A cell-selection slice's children are bare table rows; a
        // NodeSelection on an inline node (an image) yields bare inline
        // content. Both need a valid parent before the doc wrap.
        if (content.firstChild?.type.name === "table_row") {
            const table = schema.nodes["table"];
            if (!table) { return ""; }
            content = Fragment.from(table.createChecked(null, content));
        } else if (content.firstChild?.isInline) {
            content = Fragment.from(schema.nodes["paragraph"]!.createChecked(null, content));
        }
        const doc = schema.topNodeType.createChecked(null, content);
        // The serializer terminates the document with a newline; the clipboard
        // carries the selection, not a file, so trim it.
        return serialize(doc).replace(/\n+$/, "");
    } catch {
        return "";
    }
}

export const copyMarkdownPlugin = $prose((ctx) =>
    new Plugin({
        props: {
            clipboardTextSerializer(slice) {
                if (window.__i18n?.copyFormat === "richText") { return ""; }
                return markdownOfSlice(ctx.get(serializerCtx), ctx.get(schemaCtx), slice);
            },
        },
    }));
