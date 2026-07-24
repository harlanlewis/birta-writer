import { schemaCtx } from "@milkdown/core";
import {
    bulletListSchema,
    orderedListSchema,
} from "@milkdown/preset-commonmark";
import { extendListItemSchemaForTask } from "@milkdown/preset-gfm";
import { canJoin, keymap, Mapping } from "../pm";
import { Plugin, PluginKey, Selection, TextSelection } from "../pm";
import { joinTextblockBackward, liftListItem } from "../pm";
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
            // The stock default is `spread: true`, so every item created via
            // default attrs (turn-into, the `- ` input rule's wrap) was born
            // LOOSE. Parse runners always set spread explicitly, so the
            // default only ever governs editor-created items — and a fresh
            // item should be TIGHT, the overwhelming convention (the old
            // aggressive normalizer masked this; force-only normalization
            // would preserve the wrong default forever).
            attrs: {
                ...base.attrs,
                spread: { default: false, validate: "boolean" },
            },
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

/**
 * After joinTextblockBackward merges a nested item's first paragraph into the
 * previous line, the joined item can survive as a paragraph-less SHELL
 * holding only its old sublist — one level deeper than the user's mental
 * model of "the children follow the line up":
 *
 *   item[ p("bazjuj"), ul[ item[ ul[rex…] ] ] ]   ←  `- bazjuj / - / - rex`
 *
 * Unwrap it in the same transaction (one undo step): the shell's inner list
 * items replace the shell, so the subtree sits directly under the merged
 * line. A no-op whenever the join left no shell.
 */
function spliceJoinShell(tr: any, listItemType: any): void {
    const { $from } = tr.selection;
    const itemDepth = $from.depth - 1;
    if (itemDepth < 1 || $from.node(itemDepth).type !== listItemType) {
        return;
    }
    const item = $from.node(itemDepth);
    if (item.childCount < 2) {
        return;
    }
    const sublist = item.child(1);
    if (!isListNode(sublist)) {
        return;
    }
    const shell = sublist.firstChild;
    if (!shell || shell.type !== listItemType) {
        return;
    }
    // The shell survives in one of two forms: only its old sublist, or an
    // EMPTY leftover paragraph followed by the sublist.
    let inner = null;
    if (shell.childCount === 1 && isListNode(shell.firstChild)) {
        inner = shell.firstChild;
    } else if (
        shell.childCount === 2 &&
        shell.firstChild?.isTextblock &&
        shell.firstChild.content.size === 0 &&
        isListNode(shell.child(1))
    ) {
        inner = shell.child(1);
    }
    if (!inner) {
        return;
    }
    const shellPos = $from.start(itemDepth) + item.child(0).nodeSize + 1;
    tr.replaceWith(shellPos, shellPos + shell.nodeSize, inner.content);
}

function isEmptyListItem(item: any): boolean {
    return (
        item.childCount === 1 &&
        item.firstChild?.type.name === "paragraph" &&
        item.firstChild.content.size === 0
    );
}

// List Backspace: a NESTED item's start joins onto the previous visible line
// — the item break is deleted like a text editor joining lines, and the
// item's own sublist re-parents one level up (maintainer ruling 2026-07-23:
// outdent-per-press dragged whole subtrees through every level and read as
// unpredictable). A TOP-LEVEL item keeps the classic behavior: an empty item
// is deleted, a non-empty one lifts out of the list as a paragraph
// (Backspace "removes the bullet"). Cmd+Backspace shares the handler, so
// delete-to-line-start on an already-empty item falls through to the same
// join/delete instead of doing nothing.
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

    const backspaceAtItemStart = (state: any, dispatch: any): boolean => {
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

        // A nested item (its list's parent is itself a list item) joins onto
        // the previous visible line: the item break is deleted, like a text
        // editor joining lines, and the item's own subtree moves one level up
        // with it. Top-level items skip this (a join would fuse two sibling
        // bullets' text; lifting to a paragraph is the established "remove
        // the bullet" gesture there).
        const nested =
            listItemDepth >= 2 && $from.node(listItemDepth - 2).type === listItemType;
        if (nested) {
            // The join target is the deepest textblock ending before this
            // item. Joining is only predictable into a PARAGRAPH: into a
            // code block it would pour the item's prose verbatim INTO the
            // code (one keystroke silently converting content — a fidelity
            // hazard), so any other target falls through to the lift below.
            const $beforeItem = state.doc.resolve($from.before(listItemDepth));
            const target = Selection.near($beforeItem, -1).$from.parent;
            if (
                target !== $from.parent &&
                target.type.name === "paragraph" &&
                joinTextblockBackward(state, dispatch && ((tr: any) => {
                    spliceJoinShell(tr, listItemType);
                    dispatch(tr);
                }))
            ) {
                return true;
            }
        }

        if (deleteEmptyListItem(state, dispatch)) {
            return true;
        }

        return doLift(state, dispatch);
    };

    return keymap({
        Backspace: backspaceAtItemStart,
        // Delete-to-line-start with nothing left to delete: same join/delete
        // as Backspace (the handler only ever acts at parentOffset 0, so a
        // mid-line Cmd+Backspace still reaches the DOM's own deletion).
        "Mod-Backspace": backspaceAtItemStart,
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

/**
 * Whether Markdown REQUIRES this item loose: a paragraph following another
 * block inside the item would lazy-merge into it if serialized tight (byte
 * loss on reparse). A trailing nested list — or any non-paragraph block —
 * is legal tight markdown. The one spread rule every surface shares: the
 * normalizer's force floor and the Tighten command's keep-list.
 */
function itemRequiresSpread(item: any): boolean {
    let needs = false;
    item.forEach((child: any, _offset: number, index: number) => {
        if (index >= 1 && child.type.name === "paragraph") {
            needs = true;
        }
    });
    return needs;
}

/** Whether the list tree at `listPos` serializes loose anywhere — any list
 * or item in it carrying spread. The Tighten/Loosen row's state probe. */
export function listTreeIsLoose(doc: any, listPos: number): boolean {
    const list = doc.nodeAt(listPos);
    if (!list || !isListNode(list)) {
        return false;
    }
    let loose = attrSpreadBool(list.attrs.spread);
    list.descendants((n: any) => {
        if (
            (isListNode(n) || n.type.name === "list_item") &&
            attrSpreadBool(n.attrs.spread)
        ) {
            loose = true;
        }
        return !loose;
    });
    return loose;
}

/**
 * Sets the tight/loose CHARACTER of the whole list tree at `listPos` — the
 * one sanctioned way the editor changes it (the normalizer below is
 * force-only, so it never will). Tightening keeps any item Markdown
 * requires loose (see itemRequiresSpread); loosening marks every list and
 * item spread. Nested sublists follow the same setting; attr-only steps, so
 * original-doc positions stay valid and it's one undo step. Returns false
 * when `listPos` is not a list or nothing needed changing.
 */
export function setListTreeSpread(view: any, listPos: number, loose: boolean): boolean {
    const { state } = view;
    const list = state.doc.nodeAt(listPos);
    if (!list || !isListNode(list)) {
        return false;
    }
    const tr = state.tr;
    const apply = (node: any, pos: number): void => {
        let anyItemLoose = false;
        let offset = pos + 1;
        node.forEach((item: any) => {
            const itemLoose = loose || itemRequiresSpread(item);
            if (item.attrs.spread !== itemLoose) {
                tr.setNodeMarkup(offset, undefined, { ...item.attrs, spread: itemLoose });
            }
            if (itemLoose) {
                anyItemLoose = true;
            }
            let childOffset = offset + 1;
            item.forEach((child: any) => {
                if (isListNode(child)) {
                    apply(child, childOffset);
                }
                childOffset += child.nodeSize;
            });
            offset += item.nodeSize;
        });
        const listLoose = loose || anyItemLoose;
        if (node.attrs.spread !== listLoose) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, spread: listLoose });
        }
    };
    apply(list, listPos);
    if (tr.steps.length === 0) {
        return false;
    }
    view.dispatch(tr);
    return true;
}

// List spread normalization — FORCE-ONLY, by maintainer ruling (2026-07-24,
// "the editor never changes a list's tight/loose character"): spread is
// raised to true where Markdown REQUIRES a blank line (a paragraph following
// another block inside an item would lazy-merge on reparse — byte loss), and
// never lowered. Tight/loose is the author's call — it changes the RENDERED
// output (loose items get <p> wrapping downstream), so auto-"cleanup" both
// rewrote diffs and silently altered published pages. Deliberate cleanup is
// the explicit Tighten/Loosen List command (setListSpread below).
// Only list nodes inside the actually-changed range are examined, so editing
// a table doesn't touch list spacing across the whole document.
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
                    // Force-only: raise to true when required, otherwise keep
                    // the author's character (coercing a legacy string form).
                    const target = itemRequiresSpread(item) || attrSpreadBool(item.attrs.spread);
                    if (item.attrs.spread !== target) {
                        tr.setNodeMarkup(pos + offset, undefined, {
                            ...item.attrs,
                            spread: target,
                        });
                        changed = true;
                    }
                    if (target) listNeedsSpread = true;
                    offset += item.nodeSize;
                });
                const listTarget = listNeedsSpread || attrSpreadBool(node.attrs.spread);
                if (node.attrs.spread !== listTarget) {
                    tr.setNodeMarkup(pos, undefined, {
                        ...node.attrs,
                        spread: listTarget,
                    });
                    changed = true;
                }
            });
            return changed ? tr : null;
        },
    });
});
