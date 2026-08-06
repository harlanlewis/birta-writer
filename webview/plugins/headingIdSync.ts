/**
 * Heading-id sync without the whole-document walk on every keystroke.
 *
 * Milkdown's stock `syncHeadingIdPlugin` re-derives every heading's `id` attr
 * by walking `doc.descendants` — every node, inline text included — after
 * every doc-changing transaction. On the 300 KB fixture that walk is ~1 ms of
 * every keystroke's dispatch, none of which can change an id when the edit
 * never touched a heading (MAR-137, the keepTableAlign economy applied again):
 *
 *   - a change whose diff region contains no heading in either doc cannot
 *     change any id — skip entirely (`changeTouchesHeading`);
 *   - when a heading did change, re-derive with a walk pruned at textblocks
 *     (a heading can never sit inside another textblock), visiting blocks
 *     rather than characters.
 *
 * Id assignment matches upstream exactly — same generator ctx, same `-#N`
 * duplicate suffixing in document order, same skip of empty headings, same
 * history-exempt dispatch — held to it by the differential test in
 * headingIdSync.test.ts. `pureCommonmark` filters the stock plugin out via
 * `headingIdReplacedPlugins` (the headingInput replaced-plugins pattern).
 */
import { Plugin, PluginKey } from "../pm";
import type { EditorView } from "../pm";
import { headingIdGenerator, headingSchema, syncHeadingIdPlugin } from "@milkdown/preset-commonmark";
import { $prose } from "@milkdown/utils";
import { changeTouchesHeading } from "../utils/headingUtils";

export const headingIdSyncPlugin = $prose((ctx) => {
    const key = new PluginKey("BIRTA_HEADING_ID");
    const updateId = (view: EditorView) => {
        if (view.composing) {
            return;
        }
        const getId = ctx.get(headingIdGenerator.key);
        const headingType = headingSchema.type(ctx);
        const tr = view.state.tr.setMeta("addToHistory", false);
        let found = false;
        const idMap: Record<string, number> = {};
        const doc = view.state.doc;
        doc.nodesBetween(0, doc.content.size, (node, pos) => {
            if (node.type === headingType) {
                if (node.textContent.trim().length === 0) {
                    return false;
                }
                const attrs = node.attrs;
                let id = getId(node) as string;
                if (idMap[id]) {
                    idMap[id] += 1;
                    id += `-#${idMap[id]}`;
                } else {
                    idMap[id] = 1;
                }
                if (attrs["id"] !== id) {
                    found = true;
                    tr.setMeta(key, true).setNodeMarkup(pos, undefined, { ...attrs, id });
                }
                return false;
            }
            return !node.isTextblock;
        });
        if (found) {
            view.dispatch(tr);
        }
    };
    return new Plugin({
        key,
        view: (view) => {
            updateId(view);
            return {
                update: (view, prevState) => {
                    if (!changeTouchesHeading(prevState.doc, view.state.doc)) {
                        return;
                    }
                    updateId(view);
                },
            };
        },
    });
});

/** The stock preset plugin this module replaces. */
export const headingIdReplacedPlugins = new Set<unknown>([syncHeadingIdPlugin]);
