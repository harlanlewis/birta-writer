import { schemaCtx } from "@milkdown/core";
import { keymap } from "@milkdown/prose/keymap";
import { Plugin, TextSelection } from "@milkdown/prose/state";
import { liftListItem } from "@milkdown/prose/schema-list";
import { $prose } from "@milkdown/utils";

function isEmptyListItem(item: any): boolean {
    return (
        item.childCount === 1 &&
        item.firstChild?.type.name === "paragraph" &&
        item.firstChild.content.size === 0
    );
}

// List Backspace: an empty list item is deleted first; at the start of a
// non-empty item, lift it one level / turn it into a plain paragraph.
export const listLiftPlugin = $prose((ctx) => {
    const schema = ctx.get(schemaCtx);
    const listItemType = schema.nodes["list_item"];
    if (!listItemType) {
        return new Plugin({});
    }
    const doLift = liftListItem(listItemType);
    const deleteEmptyListItem = (state: any, dispatch: any): boolean => {
        const { selection } = state;
        if (!selection.empty) {
            return false;
        }
        const { $from } = selection;
        if ($from.parentOffset !== 0) {
            return false;
        }

        let listItemDepth = -1;
        for (let d = $from.depth; d >= 0; d--) {
            if ($from.node(d).type === listItemType) {
                listItemDepth = d;
                break;
            }
        }
        if (listItemDepth < 0) {
            return false;
        }
        const item = $from.node(listItemDepth);
        const list = $from.node(listItemDepth - 1);
        if (!isEmptyListItem(item) || list.childCount <= 1) {
            return false;
        }

        if (dispatch) {
            const from = $from.before(listItemDepth);
            const to = $from.after(listItemDepth);
            const itemIndex = $from.index(listItemDepth - 1);
            const tr = state.tr.delete(from, to);
            const targetPos = itemIndex > 0 ? Math.max(0, from - 1) : Math.min(from, tr.doc.content.size);
            tr.setSelection(TextSelection.near(tr.doc.resolve(targetPos), itemIndex > 0 ? -1 : 1));
            dispatch(tr);
        }
        return true;
    };

    return keymap({
        Backspace: (state, dispatch) => {
            const { selection } = state;
            if (!selection.empty) {
                return false;
            }
            const { $from } = selection;
            if ($from.parentOffset !== 0) {
                return false;
            }

            if (deleteEmptyListItem(state, dispatch)) {
                return true;
            }

            let listItemDepth = -1;
            for (let d = $from.depth; d >= 0; d--) {
                if ($from.node(d).type === listItemType) {
                    listItemDepth = d;
                    break;
                }
            }
            if (listItemDepth < 0) {
                return false;
            }

            return doLift(state, dispatch);
        },
        Delete: deleteEmptyListItem,
    });
});

// Enter on an EMPTY list item: never leave the empty item behind (Slack /
// Google Docs behavior). A nested empty item outdents exactly one level per
// press; a top-level empty item exits the list and becomes an empty paragraph
// after it (liftListItem splits the list when the item sits in the middle).
// Non-empty items fall through to the default split behavior. Task-list items
// are the same list_item node type (with a `checked` attr in preset-gfm), so
// they are covered too. "Empty" = a single empty paragraph and nothing else;
// an empty paragraph with a nested sublist below is NOT empty.
export const listEnterPlugin = $prose((ctx) => {
    const schema = ctx.get(schemaCtx);
    const listItemType = schema.nodes["list_item"];
    if (!listItemType) {
        return new Plugin({});
    }
    const doLift = liftListItem(listItemType);

    return keymap({
        Enter: (state, dispatch, view) => {
            // Never intercept while an IME composition is in progress.
            if (view?.composing) {
                return false;
            }
            const { selection } = state;
            if (!selection.empty) {
                return false;
            }
            const { $from } = selection;
            if ($from.parent.type.name !== "paragraph") {
                return false;
            }

            let listItemDepth = -1;
            for (let d = $from.depth; d >= 0; d--) {
                if ($from.node(d).type === listItemType) {
                    listItemDepth = d;
                    break;
                }
            }
            if (listItemDepth < 0) {
                return false;
            }
            if (!isEmptyListItem($from.node(listItemDepth))) {
                return false;
            }

            return doLift(state, dispatch);
        },
    });
});

// List spread normalization: after an edit, if a list item contains only a
// single block child, reset its spread to false. This prevents a stale
// spread:true (left over from a loose list after deleting a nested sublist)
// from inserting extra blank lines on serialization. Only list nodes inside
// the actually-changed range are normalized, so editing a table doesn't reset
// list spacing across the whole document.
export const listSpreadNormalizePlugin = $prose((ctx) => {
    const schema = ctx.get(schemaCtx);
    return new Plugin({
        appendTransaction(transactions, _oldState, newState) {
            if (!transactions.some((tr) => tr.docChanged)) return null;

            let minFrom = newState.doc.content.size;
            let maxTo = 0;
            for (const tr of transactions) {
                if (!tr.docChanged) continue;
                for (const step of tr.steps) {
                    step.getMap().forEach((_os, _oe, newStart, newEnd) => {
                        if (newStart < minFrom) minFrom = newStart;
                        if (newEnd > maxTo) maxTo = newEnd;
                    });
                }
            }
            // Per-step coordinates are NOT mapped through later steps, so a
            // multi-step transaction that shrinks the doc (a mark input rule
            // deleting its `**`/`==` markers near the end) can leave maxTo
            // past the final doc — clamp before nodesBetween or it throws.
            const docSize = newState.doc.content.size;
            minFrom = Math.max(0, Math.min(minFrom, docSize));
            maxTo = Math.min(maxTo, docSize);
            if (minFrom > maxTo) return null;

            const tr = newState.tr;
            let changed = false;

            newState.doc.nodesBetween(minFrom, maxTo, (node, pos) => {
                if (
                    node.type !== schema.nodes.bullet_list &&
                    node.type !== schema.nodes.ordered_list
                ) {
                    return;
                }
                let listNeedsSpread = false;
                let offset = 1;
                node.forEach((item) => {
                    const itemNeedsSpread = item.childCount > 1;
                    if (item.attrs.spread !== itemNeedsSpread) {
                        tr.setNodeMarkup(pos + offset, undefined, {
                            ...item.attrs,
                            spread: itemNeedsSpread,
                        });
                        changed = true;
                    }
                    if (itemNeedsSpread) listNeedsSpread = true;
                    offset += item.nodeSize;
                });
                if (node.attrs.spread !== listNeedsSpread) {
                    tr.setNodeMarkup(pos, undefined, {
                        ...node.attrs,
                        spread: listNeedsSpread,
                    });
                    changed = true;
                }
            });
            return changed ? tr : null;
        },
    });
});
