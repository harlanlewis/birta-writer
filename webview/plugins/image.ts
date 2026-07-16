/**
 * Parse-time image attr coercion.
 *
 * mdast types `image.alt` and `image.title` as `string | null` (null when the
 * source has no title: `![alt](src)`), but Milkdown's stock image runner
 * passes them through as-is into a node whose attrs declare
 * `validate: "string"`. ProseMirror only applies an attr default when the key
 * is ABSENT — an explicit null is kept — so every title-less image in a
 * document carries attrs that fail the node's own validation. Nothing on the
 * mount path calls `doc.check()`, which is why this stayed latent; the
 * corpus move-sampling gate (which checks the doc after every sampled move)
 * caught it the moment a fixture contained a title-less image.
 *
 * The runner below is the stock one (RE-DIFF ON EVERY MILKDOWN UPGRADE) with
 * the sole change that null/undefined coerce to "" — matching both the attr
 * defaults and the schema's own parseDOM path (`getAttribute(...) || ""`).
 * Serialization is unaffected: remark-stringify omits a falsy title/alt, so
 * "" round-trips exactly like null. Same replace-the-stock-schema pattern as
 * plugins/list.ts (MAR-124).
 */
import { imageSchema } from "@milkdown/preset-commonmark";

interface ImageMdastNode {
    url?: string | null;
    alt?: string | null;
    title?: string | null;
}

export const imageStringAttrSchema = imageSchema.extendSchema((prev) => (ctx) => {
    const base = prev(ctx);
    return {
        ...base,
        parseMarkdown: {
            match: base.parseMarkdown.match,
            runner: (state, node, type) => {
                const n = node as ImageMdastNode;
                state.addNode(type, {
                    src: n.url ?? "",
                    alt: n.alt ?? "",
                    title: n.title ?? "",
                });
            },
        },
    };
});

/** Flattened for pureCommonmark, mirroring listSpreadBooleanPlugins. */
export const imageStringAttrPlugins = [imageStringAttrSchema].flat();

/**
 * The stock commonmark image schema the override replaces — filtered out of
 * `pureCommonmark` so only the coercing schema registers (last-wins per node
 * id, and the parser reads one parseMarkdown runner per node). Same pattern
 * as listSpreadReplacedPlugins.
 */
export const imageStringAttrReplacedPlugins = new Set<unknown>([
    imageSchema.ctx,
    imageSchema.node,
]);
