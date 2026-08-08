/**
 * plugins/listNumbering.ts
 *
 * The LIFECYCLE of an ordered list's numbering style. The style itself is a
 * node attr (`numbering` on ordered_list, plugins/list.ts) and the browser draws
 * it from an inline `list-style-type`, so nothing here renders anything.
 *
 * WHY AN ATTR AND A BAG, when width and wrap need only a bag. A content anchor
 * cannot name a block that has no content yet, and a list is BORN empty: typing
 * `a. ` creates an ordered list whose first item is the empty string, so a bag
 * write at that moment would key on `list:` and collide with every other
 * just-created list. The attr is therefore the live truth — it survives editing,
 * undo and redo for free, because it rides the document — and the bag is only
 * the reload mirror.
 *
 * That split makes the sync one-directional and idempotent, which is what keeps
 * it small:
 *
 *   - ON LOAD, a list with no attr adopts the style stored under its content
 *     anchor. One pass, `addToHistory: false`, so it is not an edit the user can
 *     undo and it never dirties the document.
 *   - ON CHANGE, the bag is REBUILT from the document: every list carrying a
 *     non-default attr writes its current anchor, and any stored anchor no
 *     longer claimed by a list is dropped. Rebuilding rather than renaming is
 *     why editing a list's first item needs no migration path — the next
 *     reconcile simply states the new truth.
 *
 * COST WHEN UNUSED IS ZERO, the disabled-feature rule: the reconcile is gated on
 * `inUse`, which stays false for a document with an empty bag and no styled
 * list, so an ordinary document pays one boolean per transaction.
 */
import { Plugin, PluginKey } from "../pm";
import type { EditorState, EditorView, Node as PmNode, Transaction } from "../pm";
import { $prose } from "@milkdown/utils";
import {
    anchorAt,
    getListNumbering,
    listAnchorBase,
    listNumberingEntries,
    setListNumbering,
} from "../blockWidth";
import { isOrderedNumbering, type OrderedNumbering } from "../utils/orderedMarkers";

export const listNumberingPluginKey = new PluginKey("BIRTA_LIST_NUMBERING");

/**
 * False until this document has a reason to care: a stored preference to
 * hydrate, or a list the user has styled. Module scope rather than plugin state
 * because the store is module scope too, and a menu action's write has to be
 * able to arm it.
 */
let inUse = false;

/**
 * Arm the reconcile pass. Every path that puts a `numbering` attr into the
 * document MUST call this, and there are only two: `setListNumberingAt` below
 * (the door for a dispatching caller) and the typed-marker input rule, which
 * has to return its transaction rather than dispatch it and so arms by hand.
 *
 * Nothing else can introduce the attr — it is absent from ordered_list's
 * toMarkdown, so it is never parsed and never survives a copy to the clipboard,
 * and hydration arms itself. A future third caller that forgets this would
 * silently stop persisting, which is why the door exists.
 */
export function armListNumbering(): void {
    inUse = true;
}

/**
 * Set (or clear, with null) the numbering of the ordered list at `pos`. The one
 * door for a caller that dispatches: it arms the reconcile, validates the node,
 * and stores `decimal` as absence so an untouched list keeps the by-depth
 * cascade. Returns false when `pos` holds no ordered list.
 */
export function setListNumberingAt(
    view: EditorView,
    pos: number,
    style: OrderedNumbering | null,
): boolean {
    const node = view.state.doc.nodeAt(pos);
    if (node?.type.name !== "ordered_list") {
        return false;
    }
    armListNumbering();
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        numbering: style === "decimal" ? null : style,
    }));
    return true;
}

/** Every top-level-or-nested ordered_list with its position, in document order. */
function orderedLists(doc: PmNode): { pos: number; node: PmNode }[] {
    const found: { pos: number; node: PmNode }[] = [];
    doc.descendants((node: PmNode, pos: number) => {
        if (node.type.name === "ordered_list") {
            found.push({ pos, node });
        }
        // Numbering is a list-level fact; inline content can never hold one.
        return !node.isTextblock;
    });
    return found;
}

/** The style stored for the list at `pos`, or null. */
function storedFor(doc: PmNode, pos: number): OrderedNumbering | null {
    const anchor = anchorAt(doc, pos, listAnchorBase);
    return anchor === null ? null : getListNumbering(anchor);
}

/**
 * Hydrate attrs from the bag. Returns a transaction, or null when nothing
 * needed setting — a list that already carries an attr is left alone, so this
 * can run on any state without fighting the user's own choice.
 */
export function hydrateListNumbering(state: EditorState): Transaction | null {
    if (listNumberingEntries().length === 0) {
        return null;
    }
    let tr: Transaction | null = null;
    for (const { pos, node } of orderedLists(state.doc)) {
        if (isOrderedNumbering(node.attrs["numbering"])) {
            continue;
        }
        const stored = storedFor(state.doc, pos);
        if (stored === null || stored === "decimal") {
            continue;
        }
        tr ??= state.tr;
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, numbering: stored });
    }
    if (tr) {
        inUse = true;
        // Presentation restored from beside the document, not an edit to it.
        tr.setMeta("addToHistory", false);
        tr.setMeta(listNumberingPluginKey, { reconciled: true });
    }
    return tr;
}

/**
 * Restate the bag as the document currently has it. Idempotent, and cheap
 * enough to run on any doc change once `inUse`: one pass over the lists plus one
 * pass over the stored entries.
 */
export function reconcileListNumbering(doc: PmNode): void {
    const claimed = new Set<string>();
    for (const { pos, node } of orderedLists(doc)) {
        const style = node.attrs["numbering"];
        if (!isOrderedNumbering(style) || style === "decimal") {
            continue;
        }
        const anchor = anchorAt(doc, pos, listAnchorBase);
        if (anchor === null) {
            continue;
        }
        claimed.add(anchor);
        setListNumbering(anchor, style);
    }
    // Anything the document no longer claims: a styled list deleted, or one
    // whose first item was retyped so its anchor moved. Dropping it is what
    // keeps the bag from accumulating a key per keystroke of a first-item edit.
    for (const [anchor] of listNumberingEntries()) {
        if (!claimed.has(anchor)) {
            setListNumbering(anchor, null);
        }
    }
}

export const listNumberingPlugin = $prose(() =>
    new Plugin({
        key: listNumberingPluginKey,
        view: (view) => {
            // Hydration waits for the mount rather than riding init: dispatching
            // during plugin construction is not allowed, and the stored bag has
            // already arrived (the init message precedes editor creation).
            const tr = hydrateListNumbering(view.state);
            if (tr) {
                view.dispatch(tr);
            }
            return {
                // The reconcile is a write to a store BESIDE the document, so it
                // belongs here rather than in appendTransaction, which exists to
                // append document steps. Doc identity, not eq() — a value
                // comparison would be O(document) on every keystroke.
                update(updated, prevState) {
                    if (inUse && prevState.doc !== updated.state.doc) {
                        reconcileListNumbering(updated.state.doc);
                    }
                },
            };
        },
    }),
);

/** Test seam: the module flag is deliberately not exported for writing. */
export function __resetListNumberingArmForTests(): void {
    inUse = false;
}
