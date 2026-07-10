/**
 * Null out the gfm cell schemas' `alignment` default (MAR-75 cleanup).
 *
 * preset-gfm defaults every table cell to `alignment: "left"`, and the
 * serializer distinguishes explicit left (`:---`) from the unmarked default
 * (`---`) — so a column INSERTED in the editor was born "left" and silently
 * wrote a `:---` marker the user never chose. With a null default, new cells
 * serialize as the unmarked `---`; explicit alignment (loaded from `:---` /
 * set via the Align Column commands) is untouched, since parse and the
 * commands always set the attr explicitly.
 *
 * Must be registered AFTER the gfm preset (editor.ts) so the extension wins.
 */
import { tableCellSchema, tableHeaderSchema } from "@milkdown/preset-gfm";

const nullAlignmentDefault = (
    base: { attrs?: Record<string, { default?: unknown }> },
): Record<string, { default?: unknown }> => ({
    ...base.attrs,
    alignment: { ...base.attrs?.["alignment"], default: null },
});

export const tableCellAlignDefaultSchema = tableCellSchema.extendSchema((prev) => (ctx) => {
    const base = prev(ctx);
    return { ...base, attrs: nullAlignmentDefault(base) };
});

export const tableHeaderAlignDefaultSchema = tableHeaderSchema.extendSchema((prev) => (ctx) => {
    const base = prev(ctx);
    return { ...base, attrs: nullAlignmentDefault(base) };
});

/** Both cell types, flattened for `Editor.use()`. */
export const tableAlignDefaultPlugin = [
    tableCellAlignDefaultSchema,
    tableHeaderAlignDefaultSchema,
].flat();
