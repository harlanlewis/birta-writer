import { schemaCtx } from "@milkdown/core";
import {
    bulletListSchema,
    orderedListSchema,
} from "@milkdown/preset-commonmark";
import { extendListItemSchemaForTask } from "@milkdown/preset-gfm";
import { canJoin, keymap, Mapping } from "../pm";
import { Plugin, PluginKey, TextSelection } from "../pm";
import { liftListItem } from "../pm";
import { $prose } from "@milkdown/utils";
import { isListNode, isSameTypeListBoundary } from "../editing/listMerge";

// ── Parse-time spread coercion (MAR-124) ────────────────────────────────────
//
// The mdast `spread` prop is a real boolean from remark, but Milkdown's stock
// list runners stringify it (`${node.spread}`) before storing it as the PM
// attr, leaving `"true"`/`"false"` on every freshly parsed list. That string
// fails the schema's own `validate: "boolean"` (so `doc.check()` throws on any
// parsed list before a single edit) and skips mdast-util-to-markdown's
// tight-list join on a raw round trip, loosening tight lists. The fidelity
// serializer re-coerces on the way out and `listSpreadNormalizePlugin` fixes
// it on the first edit, but the parsed doc itself was never valid. These
// extended schemas override the parse runner to store a real boolean.
//
// Because that makes the PM `spread` attr a genuine boolean, the ordered_list
// and list_item TOMARKDOWN runners — which hardcode `node.attrs.spread ===
// "true"` — must be overridden too, or they compute `false` for every list
// (`true === "true"` is false) and tighten loose lists on save. bullet_list's
// stock toMarkdown passes the attr through untouched, so it needs no override.
// `attrSpreadBool` accepts either form, so a doc still carrying a string
// `spread` (e.g. from Milkdown's ordered-list-detection plugin, which writes
// "true" on edit) also serializes correctly.
//
// Registered AFTER the preset so they override the stock definitions (the same
// override-by-registration-order pattern math.ts uses for `code_block`);
// list_item registers after gfm — see its schema doc below.

interface ListMdastNode {
    spread?: unknown;
    start?: number;
    label?: unknown;
    children?: unknown;
}

/** The mdast boolean spread, or the schema's null-fallback, as a real boolean. */
function spreadBool(node: ListMdastNode, fallback: boolean): boolean {
    return node.spread != null ? Boolean(node.spread) : fallback;
}

/** A PM `spread` attr as a real boolean, tolerating the legacy string form. */
function attrSpreadBool(spread: unknown): boolean {
    return spread === true || spread === "true";
}

export const bulletListSpreadBoolSchema = bulletListSchema.extendSchema((prev) => (ctx) => {
    const base = prev(ctx);
    return {
        ...base,
        parseMarkdown: {
            match: base.parseMarkdown.match,
            runner: (state, node, type) => {
                state
                    .openNode(type, { spread: spreadBool(node as ListMdastNode, false) })
                    .next(node.children)
                    .closeNode();
            },
        },
    };
});

export const orderedListSpreadBoolSchema = orderedListSchema.extendSchema((prev) => (ctx) => {
    const base = prev(ctx);
    return {
        ...base,
        parseMarkdown: {
            match: base.parseMarkdown.match,
            runner: (state, node, type) => {
                const n = node as ListMdastNode;
                state
                    .openNode(type, { spread: spreadBool(n, true), order: n.start ?? 1 })
                    .next(node.children)
                    .closeNode();
            },
        },
        toMarkdown: {
            match: base.toMarkdown.match,
            runner: (state, node) => {
                state
                    .openNode("list", undefined, {
                        ordered: true,
                        start: node.attrs["order"] ?? 1,
                        spread: attrSpreadBool(node.attrs["spread"]),
                    })
                    .next(node.content)
                    .closeNode();
            },
        },
    };
});

/**
 * `list_item` is owned by preset-gfm, not commonmark: gfm's
 * `extendListItemSchemaForTask` re-registers it (adding the task-list `checked`
 * attr) AFTER commonmark, and both its parse and serialize runners stringify /
 * string-compare `spread`. So the coercion for list_item must layer on top of
 * GFM's task schema — preserving `checked` and the task parseDOM/toDOM — and
 * register AFTER gfm to win (schema registration is last-wins per node id). The
 * runners below mirror GFM's own (RE-DIFF ON EVERY MILKDOWN UPGRADE) with the
 * sole change that `spread` is a real boolean on both sides.
 */
export const listItemSpreadBoolSchema = extendListItemSchemaForTask.extendSchema(
    (prev) => (ctx) => {
        const base = prev(ctx);
        return {
            ...base,
            parseMarkdown: {
                match: base.parseMarkdown.match,
                runner: (state, node, type) => {
                    const n = node as ListMdastNode & { checked?: unknown };
                    const label = n.label != null ? `${n.label}.` : "•";
                    const listType = n.label != null ? "ordered" : "bullet";
                    const spread = spreadBool(n, true);
                    const attrs =
                        n.checked == null
                            ? { label, listType, spread }
                            : { label, listType, spread, checked: Boolean(n.checked) };
                    state.openNode(type, attrs).next(node.children).closeNode();
                },
            },
            toMarkdown: {
                match: base.toMarkdown.match,
                runner: (state, node) => {
                    const spread = attrSpreadBool(node.attrs["spread"]);
                    if (node.attrs["checked"] == null) {
                        state.openNode("listItem", undefined, { spread })
                            .next(node.content)
                            .closeNode();
                    } else {
                        state
                            .openNode("listItem", undefined, {
                                label: node.attrs["label"],
                                listType: node.attrs["listType"],
                                spread,
                                checked: node.attrs["checked"],
                            })
                            .next(node.content)
                            .closeNode();
                    }
                },
            },
        };
    },
);

/**
 * bullet_list / ordered_list overrides, flattened for pureCommonmark (they
 * replace the stock commonmark schemas — see listSpreadReplacedPlugins). The
 * list_item override ships separately (listItemSpreadBoolPlugins) because it
 * must register after gfm.
 */
export const listSpreadBooleanPlugins = [
    bulletListSpreadBoolSchema,
    orderedListSpreadBoolSchema,
].flat();

/** The list_item override, registered AFTER gfm (see the schema doc above). */
export const listItemSpreadBoolPlugins = [listItemSpreadBoolSchema].flat();

/**
 * The stock commonmark list schemas the bullet/ordered overrides replace.
 * `pureCommonmark` filters these out before adding `listSpreadBooleanPlugins`
 * so only the coercing schemas register — the ProseMirror parser reads one
 * parseMarkdown runner per node id from the winning schema, so a stock schema
 * left in place would keep emitting string `spread`. (list_item is not here:
 * gfm re-registers it after commonmark, so the list_item override wins by
 * registering after gfm instead of by filtering.) Same pattern as
 * sourceStyle/tableBreaks.
 */
export const listSpreadReplacedPlugins = new Set<unknown>([
    bulletListSchema.ctx,
    bulletListSchema.node,
    orderedListSchema.ctx,
    orderedListSchema.node,
]);

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

// ── Auto-join of edit-created adjacent lists ────────────────────────────────
//
// Two sibling lists of the same type only exist when the SOURCE split them
// deliberately (a `-`→`*` marker change — markdown merges blank-line-separated
// same-marker lists at parse time) or when an EDIT made them adjacent:
// deleting the paragraph between two lists, moving a list next to another,
// converting the block between them. Left split, the pair reads as two blocks
// (double flow gap, two gutter handles) and the serializer makes the split
// PERMANENT by alternating the second list's bullet marker (`bulletOther`).
//
// Policy: adjacency the user's own edit created is merged automatically — the
// user deleted the separator, so one list is the natural reading — while a
// split already present in the source is the author's syntax and is NEVER
// auto-merged (the block menu's Merge rows and the caret advisory offer that
// merge explicitly instead). The old-doc boundary probe below is what tells
// the two apart. Undo/redo and external file syncs are exempt: both restore
// document states and must not be "corrected".
export const listAutoJoinPlugin = $prose(() => {
    return new Plugin({
        key: new PluginKey("MD_LIST_AUTO_JOIN"),
        appendTransaction(transactions, oldState, newState) {
            if (!transactions.some((tr) => tr.docChanged)) return null;
            for (const tr of transactions) {
                // Undo/redo must restore the split it recorded; addToHistory:
                // false marks state restoration too (external sync rewrites,
                // unfurl swaps) — none of it is a user edit to interpret.
                if (tr.getMeta("history$") || tr.getMeta("addToHistory") === false) {
                    return null;
                }
            }

            // The changed range in final-doc coordinates (the
            // listSpreadNormalizePlugin pattern, including its clamp note).
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
            const docSize = newState.doc.content.size;
            minFrom = Math.max(0, Math.min(minFrom, docSize));
            maxTo = Math.min(maxTo, docSize);
            if (minFrom > maxTo) return null;

            // Candidate boundaries: a list in (or straddling) the changed
            // range whose NEXT sibling is a list of the same type. The ±1
            // widening matters for the pure-deletion case, where the changed
            // range collapses to a point exactly on the boundary — an
            // edge-exclusive nodesBetween would visit neither list.
            const boundaries: number[] = [];
            newState.doc.nodesBetween(
                Math.max(0, minFrom - 1),
                Math.min(docSize, maxTo + 1),
                (node, pos, parent, index) => {
                    if (node.isTextblock) return false; // lists never nest in textblocks
                    if (!isListNode(node)) return true;
                    if (parent?.maybeChild(index + 1)?.type === node.type) {
                        boundaries.push(pos + node.nodeSize);
                    }
                    return true; // descend: nested sublists can be adjacent too
                },
            );
            if (boundaries.length === 0) return null;

            // Fidelity gate: keep only adjacency the edit CREATED. A boundary
            // that maps back onto a same-type list boundary in the old doc was
            // already split there — the file's own structure.
            const mapping = new Mapping();
            for (const tr of transactions) mapping.appendMapping(tr.mapping);
            const inverted = mapping.invert();
            const fresh = [...new Set(boundaries)].filter(
                (b) => !isSameTypeListBoundary(oldState.doc, inverted.map(b)),
            );
            if (fresh.length === 0) return null;

            // Descending order: a join removes tokens at its boundary, which
            // only shifts positions ABOVE it — lower boundaries stay valid.
            const tr = newState.tr;
            let joined = false;
            for (const b of fresh.sort((x, y) => y - x)) {
                if (canJoin(tr.doc, b)) {
                    tr.join(b);
                    joined = true;
                }
            }
            return joined ? tr : null;
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
