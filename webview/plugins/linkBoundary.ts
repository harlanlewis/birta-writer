/**
 * Two overrides on the stock link mark's spec.
 *
 * **`inclusive: false` — the caret boundary.** With ProseMirror's default
 * (`inclusive: true`), the caret at a link's end boundary extends the link with
 * every typed character — and that boundary is exactly where every insert flow
 * parks the caret: the ⌘K palette, a section-link pick, the `#` heading
 * autocomplete, paste-link, the `[t](u)` input rule. The user's next words
 * silently join the href's text. `inclusive: false` makes typing at either
 * boundary produce plain text; extending a link's text is the link editor's
 * job (its text field), never a typing side effect.
 *
 * **`priority: 25` — links open outermost when serializing (MAR-33).** The
 * serializer orders a node's marks by `spec.priority ?? 50` and opens them in
 * that order, so at the default a `strong` mark ties with `link` and wins on
 * mark rank: a bold span inside a link serializes as `**[bold](url)**`, and
 * adjacent segments of one link then differ in shape and never merge back into
 * a single link. At 25 the link opens first, every segment of a formatted link
 * serializes as `link{...formatting...}`, and the merge sees one link.
 *
 * `link_ref` carries the same priority for the same reason (plugins/
 * referenceLinks.ts). Keep the two in step: a formatted reference link splits
 * exactly like an inline one.
 *
 * This is all that survives of the vendored serializer fork. Until Milkdown
 * 7.22.0 the same outcome needed a patched copy of upstream's `SerializerState`
 * that hard-coded link mark types to priority 25, because the stock serializer
 * also closed and re-merged marks per node and could not rejoin the segments
 * anyway. #2405 made keeping marks open across adjacent nodes the upstream
 * behavior, which left the priority as the only thing to say — and a schema
 * field says it. `webview/__tests__/formattedLinks.test.ts` is the pin.
 *
 * Both are registered inside `pureCommonmark` AFTER the stock preset so the
 * extension overrides it, and no construction site can wire an editor without
 * them.
 */
import { linkSchema } from "@milkdown/preset-commonmark";

export const linkBoundaryPlugins = linkSchema.extendSchema((prev) => (ctx) => ({
    ...prev(ctx),
    inclusive: false,
    priority: 25,
}));
