/**
 * webview/plugins/imageBlocks.ts
 *
 * Marks TOP-LEVEL image-only paragraphs (one `image` child, nothing else)
 * with an `img-block` node decoration — the CSS hook that horizontally
 * centers standalone images and scopes the per-block width breakout
 * (blockWidth.ts) to blocks whose containing block is the content column.
 *
 * Why a decoration and not CSS or a DOM mutation:
 *   - CSS cannot express "no sibling content": bare text nodes are invisible
 *     to :has()/:only-child, so `p:has(> .image-wrapper:only-child)` would
 *     center a paragraph that mixes prose and an image.
 *   - A NodeView mutating its parent <p>'s classList is exactly the
 *     "unexpected mutation → ProseMirror redraws the node" trap the block
 *     menu documents; decoration classes are the sanctioned channel.
 *
 * Perf contract (the embed plugin's): the walk is a top-level doc.forEach —
 * O(top-level blocks), no descent — re-run only on doc changes, and the
 * first pass is armed on idle after first paint so an image-heavy document
 * never pays decoration work on the mount path.
 */
import type { EditorState, Node as ProseNode, Transaction } from "../pm";
import { Decoration, DecorationSet, Plugin, PluginKey } from "../pm";
import { countWork } from "../perf";
import { forEachTouchedTopLevel, touchedRanges } from "./editRanges";
import { $prose } from "@milkdown/utils";
import { requestIdle } from "../utils/idle";

/** Upper bound on how long after first paint the first pass may wait. */
const FIRST_PASS_IDLE_TIMEOUT_MS = 1000;

/** The visual-block class for a top-level paragraph, or null: `img-block`
 * (a single image, nothing else) or `html-block` (only html nodes — a
 * rendered raw-HTML preview). Both get block rhythm; img-block also centers
 * and scopes the width breakout. */
function visualBlockClass(node: ProseNode): string | null {
    if (node.type.name !== "paragraph" || node.childCount === 0) {
        return null;
    }
    if (node.childCount === 1 && node.firstChild?.type.name === "image") {
        return "img-block";
    }
    let allHtml = true;
    node.forEach((child) => {
        if (child.type.name !== "html") {
            allHtml = false;
        }
    });
    return allHtml ? "html-block" : null;
}

/** Exported for unit testing; the plugin runs it once, on the idle arm. */
export function computeImageBlockDecorations(state: EditorState): DecorationSet {
    const decorations: Decoration[] = [];
    state.doc.forEach((node, pos) => {
        const cls = visualBlockClass(node);
        if (cls) {
            decorations.push(
                Decoration.node(pos, pos + node.nodeSize, { class: cls }),
            );
        }
    });
    countWork("image-blocks", { blocks: state.doc.childCount });
    return decorations.length > 0
        ? DecorationSet.create(state.doc, decorations)
        : DecorationSet.empty;
}

/**
 * The set after a doc-changing transaction: every untouched block's class
 * mapped to where the edit put it, and only the touched top-level blocks
 * decided again. A class depends on one block's own children, so this is the
 * whole of what an edit owes (MAR-431). Exported for unit testing.
 */
export function updateImageBlockDecorations(deco: DecorationSet, tr: Transaction): DecorationSet {
    let mapped = deco.map(tr.mapping, tr.doc);
    const blocks = forEachTouchedTopLevel(tr.doc, touchedRanges(tr), (node, pos) => {
        const end = pos + node.nodeSize;
        // Inset by one so a neighbour's decoration, which ends where this
        // block starts, is not swept up with it.
        mapped = mapped.remove(mapped.find(pos + 1, end - 1));
        const cls = visualBlockClass(node);
        if (cls) {
            mapped = mapped.add(tr.doc, [Decoration.node(pos, end, { class: cls })]);
        }
    });
    countWork("image-blocks", { blocks });
    return mapped;
}

type ImageBlocksState = { armed: boolean; deco: DecorationSet };
type ImageBlocksMeta = { type: "arm" };

const imageBlocksPluginKey = new PluginKey<ImageBlocksState>("imageBlocks");

export const imageBlocksPlugin = $prose(() =>
    new Plugin<ImageBlocksState>({
        key: imageBlocksPluginKey,
        state: {
            init: () => ({ armed: false, deco: DecorationSet.empty }),
            apply(tr, value, _oldState, newState) {
                let { armed, deco } = value;
                const meta = tr.getMeta(imageBlocksPluginKey) as ImageBlocksMeta | undefined;
                if (meta?.type === "arm") {
                    armed = true;
                }
                if (!armed) {
                    return { armed, deco: DecorationSet.empty };
                }
                if (meta?.type === "arm") {
                    deco = computeImageBlockDecorations(newState);
                } else if (tr.docChanged) {
                    deco = updateImageBlockDecorations(deco, tr);
                } else {
                    // Selection-only transactions can't change which
                    // paragraphs are image-only; the class is selection-free.
                    deco = deco.map(tr.mapping, tr.doc);
                }
                return { armed, deco };
            },
        },
        props: {
            decorations(state) {
                return imageBlocksPluginKey.getState(state)?.deco ?? DecorationSet.empty;
            },
        },
        view(view) {
            const idle = requestIdle(() => {
                if (!view.isDestroyed) {
                    view.dispatch(
                        view.state.tr.setMeta(imageBlocksPluginKey, { type: "arm" } satisfies ImageBlocksMeta),
                    );
                }
            }, FIRST_PASS_IDLE_TIMEOUT_MS);
            return {
                destroy() {
                    idle.cancel();
                },
            };
        },
    }),
);
