/**
 * Link mark boundary: `inclusive: false`.
 *
 * With ProseMirror's default (`inclusive: true`), the caret at a link's end
 * boundary extends the link with every typed character — and that boundary is
 * exactly where every insert flow parks the caret: the ⌘K palette, a
 * section-link pick, the `#` heading autocomplete, paste-link, the `[t](u)`
 * input rule. The user's next words silently join the href's text.
 *
 * `inclusive: false` makes typing at either boundary produce plain text.
 * Extending a link's text is the link editor's job (its text field), never a
 * typing side effect. Registered inside `pureCommonmark` AFTER the stock
 * preset so the extension overrides it (the listSpreadBooleanPlugins
 * pattern), and no construction site can wire an editor without it.
 */
import { linkSchema } from "@milkdown/preset-commonmark";

export const linkBoundaryPlugins = linkSchema.extendSchema((prev) => (ctx) => ({
    ...prev(ctx),
    inclusive: false,
}));
