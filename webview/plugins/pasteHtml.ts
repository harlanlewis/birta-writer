/**
 * plugins/pasteHtml.ts — HTML-paste fidelity gaps (MAR-21 item 2).
 *
 * Pasting rich HTML already converts to Markdown well: ProseMirror parses the
 * clipboard's `text/html` against this schema, so headings, lists, tables,
 * links, code, quotes, nested lists — and even Google Docs' `<span
 * style="font-weight:700">` soup and Word's `MsoNormal` styling — all arrive
 * as real nodes. What was missing were narrow gaps in the upstream Milkdown
 * schemas' `parseDOM` rules, each of which silently DROPPED marked-up content:
 *
 *   - `<s>` and `<strike>` were not recognised as strikethrough. Milkdown's
 *     strike_through mark lists only `<del>` plus a `text-decoration:
 *     line-through` style rule, so `<s>gone</s>` — which is what many editors
 *     and every `~~…~~` renderer emits — pasted as ordinary text.
 *
 * (The image-title gap has its own home in plugins/image.ts, alongside the
 * existing attr coercion for the same schema; the task-list checkbox gap is in
 * plugins/list.ts, which already owns the layered list_item schema.)
 *
 * Parse-only additions: `toDOM`, `parseMarkdown` and `toMarkdown` are
 * untouched, so nothing about how the document serializes changes. A pasted
 * `<s>` becomes the same `~~…~~` a typed one does.
 */
import { strikethroughSchema } from "@milkdown/preset-gfm";

export const strikethroughHtmlSchema = strikethroughSchema.extendSchema((prev) => (ctx) => {
    const base = prev(ctx);
    return {
        ...base,
        parseDOM: [
            ...(base.parseDOM ?? []),
            { tag: "s" },
            { tag: "strike" },
        ],
    };
});

/** Flattened for the gfmFidelity bundle, mirroring imageStringAttrPlugins. */
export const strikethroughHtmlPlugins = [strikethroughHtmlSchema].flat();

/**
 * The stock gfm strikethrough schema this replaces — filtered out so only the
 * extended one registers (last-wins per mark id).
 */
export const strikethroughHtmlReplacedPlugins = new Set<unknown>([
    strikethroughSchema.ctx,
    strikethroughSchema.mark,
]);
