/**
 * Ordered-list label sync without the whole-document walk on every keystroke.
 *
 * Milkdown's stock `syncListOrderPlugin` appendTransaction walks
 * `doc.descendants` — every node, inline text included — after every generic
 * transaction, re-deriving each ordered item's `label` ("1.", "2.", …) and
 * converting a bullet list whose first item claims `listType: "ordered"`. A
 * label is a function of item ORDER and list attrs only, so (MAR-137, the
 * keepTableAlign economy again):
 *
 *   - an edit confined to one textblock's inline content cannot change any
 *     label — skip entirely (`singleTextblockInlineEdit`);
 *   - a structural edit whose diff region touches no list node in either doc
 *     cannot either — skip (`changedRange` + a pruned scan of the region);
 *   - otherwise run the upstream fix-up, pruned at textblocks, visiting
 *     blocks rather than characters. The walk stays whole-document because a
 *     label's value depends on the item's index: inserting one item re-labels
 *     every later sibling, and those siblings sit OUTSIDE the diff region.
 *
 * Label semantics match upstream exactly, held to it by the differential
 * test in listOrderSync.test.ts. The CONVERSION branch deliberately
 * diverges, in two ways, each pinned by a tripwire test that fails the day
 * upstream fixes its side (drop the divergence then):
 *
 *   - upstream passes `node.descendants`' RELATIVE child positions to
 *     `tr.setNodeMarkup`, which is only correct for a list at position 0.
 *     Anywhere else the positions land in unrelated early-document nodes,
 *     and on a text position the append THROWS, killing the user's edit —
 *     reachable here by dragging an ordered item into a bullet list's first
 *     slot and then pressing Enter in any list (probe, 2026-08-06). Ours
 *     maps them to absolute positions.
 *   - upstream's `changed = handleNodeItem(...)` overwrite drops a pending
 *     `listType` correction whenever the label was already right. Ours ORs.
 *
 * `pureCommonmark` filters the stock plugin out via
 * `listOrderReplacedPlugins`.
 */
import { Plugin, PluginKey } from "../pm";
import type { Node as PmNode, NodeType } from "../pm";
import {
    bulletListSchema, listItemSchema, orderedListSchema, syncListOrderPlugin,
} from "@milkdown/preset-commonmark";
import { $prose } from "@milkdown/utils";
import { changedRange, singleTextblockInlineEdit } from "../utils/textblockEdit";

function rangeTouchesList(doc: PmNode, from: number, to: number, listTypes: NodeType[]): boolean {
    let found = false;
    const max = doc.content.size;
    doc.nodesBetween(Math.min(from, max), Math.min(to, max), (node) => {
        if (found) {
            return false;
        }
        if (listTypes.includes(node.type)) {
            found = true;
            return false;
        }
        return !node.isTextblock;
    });
    return found;
}

export const listOrderSyncPlugin = $prose((ctx) => {
    return new Plugin({
        key: new PluginKey("BIRTA_KEEP_LIST_ORDER"),
        appendTransaction: (transactions, oldState, newState) => {
            if (
                !newState.selection ||
                transactions.some((tr) => tr.getMeta("addToHistory") === false || !tr.isGeneric)
            ) {
                return null;
            }
            const edit = singleTextblockInlineEdit(oldState.doc, newState.doc);
            if (edit) {
                // Value-identical docs, or an inline-only edit: item structure
                // and attrs are untouched, so no label can have changed.
                return null;
            }
            const orderedListType = orderedListSchema.type(ctx);
            const bulletListType = bulletListSchema.type(ctx);
            const listItemType = listItemSchema.type(ctx);
            const range = changedRange(oldState.doc, newState.doc);
            if (!range) {
                return null;
            }
            const listTypes = [orderedListType, bulletListType, listItemType];
            if (
                !rangeTouchesList(oldState.doc, range.start, range.endA, listTypes) &&
                !rangeTouchesList(newState.doc, range.start, range.endB, listTypes)
            ) {
                return null;
            }
            // Upstream's fix-up, verbatim except the walk prunes inline
            // content: lists and items are containers, so descending into a
            // textblock can never find one.
            const handleNodeItem = (
                attrs: Record<string, unknown>, index: number, order = 1,
            ): boolean => {
                let changed = false;
                const expectedLabel = `${index + order}.`;
                if (attrs["label"] !== expectedLabel) {
                    attrs["label"] = expectedLabel;
                    changed = true;
                }
                return changed;
            };
            let tr = newState.tr;
            let needDispatch = false;
            newState.doc.nodesBetween(0, newState.doc.content.size, (node, pos, parent, index) => {
                if (node.type === bulletListType) {
                    const base = node.maybeChild(0);
                    if (base?.type === listItemType && base.attrs["listType"] === "ordered") {
                        needDispatch = true;
                        tr.setNodeMarkup(pos, orderedListType, { spread: true });
                        node.descendants((child, childPos, _parent, childIndex) => {
                            if (child.type === listItemType) {
                                const attrs = { ...child.attrs };
                                if (handleNodeItem(attrs, childIndex)) {
                                    // childPos is relative to the list's
                                    // content; map to a document position
                                    // (divergence 1 in the header).
                                    tr = tr.setNodeMarkup(pos + 1 + childPos, undefined, attrs);
                                }
                            }
                            return false;
                        });
                    }
                } else if (node.type === listItemType && parent?.type === orderedListType) {
                    const attrs = { ...node.attrs };
                    let changed = false;
                    if (attrs["listType"] !== "ordered") {
                        attrs["listType"] = "ordered";
                        changed = true;
                    }
                    if (parent.maybeChild(0)) {
                        // OR, not overwrite (divergence 2 in the header).
                        changed = handleNodeItem(attrs, index, (parent.attrs["order"] as number) ?? 1) || changed;
                    }
                    if (changed) {
                        tr = tr.setNodeMarkup(pos, undefined, attrs);
                        needDispatch = true;
                    }
                }
                return !node.isTextblock;
            });
            return needDispatch ? tr.setMeta("addToHistory", false) : null;
        },
    });
});

/** The stock preset plugin this module replaces. */
export const listOrderReplacedPlugins = new Set<unknown>([syncListOrderPlugin]);
