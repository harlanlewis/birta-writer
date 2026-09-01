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
 *
 * TWO PARTS, and they are wired separately. `configureHeadingIds` seeds the
 * ids onto the parsed document before the state exists, and the plugin
 * maintains them afterwards. The seed is a `.config()` call in the editor's
 * composition root rather than something this plugin installs itself, because
 * a `$prose` factory runs after SchemaReady with no timer registered against
 * `editorState`, so setting `editorStateOptionsCtx` from in here would race the
 * read and lose silently. The failure mode of forgetting the seed is therefore
 * not a wrong id but a slow mount, which no assertion about ids can see; the
 * pair of doc-identity cases in the test file is what watches for it.
 */
import { Fragment, Plugin, PluginKey } from "../pm";
import type { EditorView, Node as ProseNode, NodeType } from "../pm";
import { editorStateOptionsCtx } from "@milkdown/core";
import { headingIdGenerator, headingSchema, syncHeadingIdPlugin } from "@milkdown/preset-commonmark";
import { $prose } from "@milkdown/utils";
import { changeTouchesHeading } from "../utils/headingUtils";
import type { EditorCtx } from "../format/types";

/**
 * Can a heading appear anywhere inside this node? Both walks prune on it, and
 * they must prune identically or the seed and the maintenance pass would visit
 * different sets. A heading is a textblock and cannot nest inside another, and
 * a leaf has no children to search.
 */
function canContainHeading(node: ProseNode): boolean {
    return !node.isTextblock && !node.isLeaf;
}

/** The id a heading takes, or null for one that gets none (empty headings). */
type AssignId = (node: ProseNode) => string | null;

/**
 * THE id vocabulary, in one place because two callers walk the document with
 * it: the seed below, which runs once before the state exists, and `updateId`,
 * which maintains ids afterwards. Both must spell an id the same way or the
 * seed's work is undone by the first maintenance pass, so the dedup counter and
 * the empty-heading skip live here rather than being written twice.
 *
 * Returned as a closure because the `-#N` suffixing is stateful across one
 * document-order walk. A fresh assigner per walk, never shared.
 */
function headingIdAssigner(getId: (node: ProseNode) => unknown): AssignId {
    const idMap: Record<string, number> = {};
    return (node) => {
        if (node.textContent.trim().length === 0) {
            return null;
        }
        let id = getId(node) as string;
        if (idMap[id]) {
            idMap[id] += 1;
            id += `-#${idMap[id]}`;
        } else {
            idMap[id] = 1;
        }
        return id;
    };
}

/**
 * The parsed document with every heading id already on it.
 *
 * Rebuilds only the branches that contain a heading: an unchanged subtree is
 * returned by identity, so a document of prose costs a walk and no allocation.
 * The recursion stops at textblocks and leaves, because a heading cannot sit
 * inside either, which is the same prune `updateId` applies.
 */
function withHeadingIds(doc: ProseNode, headingType: NodeType, assign: AssignId): ProseNode {
    const mapNode = (node: ProseNode): ProseNode => {
        if (node.type === headingType) {
            const id = assign(node);
            return id === null || node.attrs["id"] === id
                ? node
                : node.type.create({ ...node.attrs, id }, node.content, node.marks);
        }
        if (!canContainHeading(node)) {
            return node;
        }
        const kids: ProseNode[] = [];
        let changed = false;
        node.content.forEach((child) => {
            const mapped = mapNode(child);
            if (mapped !== child) {
                changed = true;
            }
            kids.push(mapped);
        });
        return changed ? node.copy(Fragment.fromArray(kids)) : node;
    };
    return mapNode(doc);
}

/**
 * Put the heading ids on the document BEFORE the editor state is built.
 *
 * Assigning them afterwards means a transaction carrying one `setNodeMarkup`
 * step per heading, and that is the expensive shape: the steps rebuild the
 * document, and the view, already mounted, then redraws every heading it
 * touched. So a document's headings cost a second render of the whole document
 * in front of first paint, for ids nothing has read yet.
 *
 * `editorStateOptionsCtx` is the seam that avoids it. Milkdown applies it to
 * `{ schema, doc, plugins }` immediately before `EditorState.create`, so the
 * document reaching the view already carries its ids: no transaction, no second
 * render, and the ids exist from the first frame rather than after it.
 *
 * This does NOT replace the plugin below, which still owns maintenance as
 * headings are edited. Its mount pass survives as a cheap backstop: over a
 * seeded document it walks, finds every id already correct, and dispatches
 * nothing.
 *
 * Deferring the pass past first paint was measured as the alternative and
 * rejected. It is not equivalent: it moves a whole-document transaction into a
 * window the user is already interacting in, and fold state does not survive it.
 */
export function configureHeadingIds(ctx: EditorCtx): void {
    ctx.update(editorStateOptionsCtx, (prev) => (options) => {
        const base = prev(options);
        if (!base.doc) {
            return base;
        }
        // Read late, inside the options call: this runs once the schema and the
        // preset's own ctx slices are ready, which config time cannot promise.
        const assign = headingIdAssigner(ctx.get(headingIdGenerator.key));
        return { ...base, doc: withHeadingIds(base.doc, headingSchema.type(ctx), assign) };
    });
}

export const headingIdSyncPlugin = $prose((ctx) => {
    const key = new PluginKey("BIRTA_HEADING_ID");
    const updateId = (view: EditorView) => {
        if (view.composing) {
            return;
        }
        const assign = headingIdAssigner(ctx.get(headingIdGenerator.key));
        const headingType = headingSchema.type(ctx);
        const tr = view.state.tr.setMeta("addToHistory", false);
        let found = false;
        const doc = view.state.doc;
        doc.nodesBetween(0, doc.content.size, (node, pos) => {
            if (node.type === headingType) {
                const id = assign(node);
                if (id === null) {
                    return false;
                }
                const attrs = node.attrs;
                if (attrs["id"] !== id) {
                    found = true;
                    tr.setMeta(key, true).setNodeMarkup(pos, undefined, { ...attrs, id });
                }
                return false;
            }
            return canContainHeading(node);
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
