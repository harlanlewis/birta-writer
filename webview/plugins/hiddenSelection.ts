/**
 * webview/plugins/hiddenSelection.ts — scope the native-selection suppression
 * to the blocks that carry an invisible selection (MAR-258).
 *
 * ProseMirror stamps `.ProseMirror-hideselection` on its root element whenever
 * the active selection's `visible` flag is false — our `BlockRangeSelection`,
 * PM's own `NodeSelection`, `GapCursor`, and prosemirror-tables'
 * `CellSelection`. The suppression PM's own stylesheet hangs off that class
 * (`*::selection { background: transparent }` plus `caret-color: transparent`)
 * is a DOCUMENT-WIDE invalidation keyed to a class on the editor root: one is
 * an inherited property, the other a universal pseudo, so toggling the class
 * re-resolves style for every element in the document — a document-size-scaling
 * block of the main thread on every invisible-selection change. **Each rule
 * alone is enough to cost it**, so both have to stay off the root, not just the
 * dominant-looking one.
 *
 * They cannot simply be deleted — they are what keeps the native highlight from
 * double-painting under the block-range tint, and the caret from blinking
 * inside an invisible selection. So the suppression is expressed twice over,
 * neither one keyed to a class on the root:
 *
 *   1. This plugin puts a `pm-hidden-selection` node decoration on the
 *      top-level blocks the invisible selection touches. Style invalidation is
 *      then confined to those blocks' subtrees. Decorations (not a classList
 *      write) because mutating ProseMirror-managed DOM wakes its observer and
 *      redraws the node, destroying the gutter widgets inside it — see
 *      editing/rangeIndicator.ts.
 *   2. `webview/style.css` keeps a STATIC `caret-color: transparent` on the
 *      editor root, with `auto` restored on every child. Nothing toggles, so
 *      nothing invalidates. This is what covers a top-level gap cursor: its DOM
 *      selection is collapsed directly in the root, which no node decoration
 *      can reach, and a caret there would blink next to the gap-cursor widget.
 *
 * Nothing may key a style rule off `.ProseMirror-hideselection` again —
 * `hiddenSelection.test.ts` fails the suite if a rule reappears.
 */
import type { EditorState } from "../pm";
import { Decoration, DecorationSet, Plugin } from "../pm";
import { $prose } from "@milkdown/utils";

/** The class both suppression rules hang off. Kept in sync with style.css. */
export const HIDDEN_SELECTION_CLASS = "pm-hidden-selection";

/**
 * The top-level blocks an invisible selection touches, decorated so CSS can
 * suppress the native highlight and caret there:
 *
 *   - a block range or a top-level node selection covers whole blocks;
 *   - an inline node selection (image, wikilink) and a cell selection resolve
 *     to the one top-level block that contains them;
 *   - a gap cursor is empty, so it decorates the enclosing top-level block when
 *     it has one (a gap inside a blockquote) and nothing at all when the gap is
 *     between two top-level blocks — the static root rule covers that case.
 *
 * Empty for every visible selection, which is the common path (typing, caret
 * moves) and returns before touching the document.
 */
export function hiddenSelectionDecorations(state: EditorState): DecorationSet {
    const sel = state.selection;
    if (sel.visible) {
        return DecorationSet.empty;
    }
    const { doc } = state;
    const $from = doc.resolve(sel.from);
    const $to = doc.resolve(sel.to);
    // index(0) is the index of the top-level child AFTER the position when the
    // position sits at a depth-0 boundary, and of the containing child when it
    // sits inside one — so an end position at a boundary is already exclusive
    // and one inside a block has to be made so.
    const start = $from.index(0);
    const end = $to.depth === 0 ? $to.index(0) : $to.index(0) + 1;
    if (end <= start) {
        return DecorationSet.empty;
    }
    const decorations: Decoration[] = [];
    let pos = $from.posAtIndex(start, 0);
    for (let i = start; i < end && i < doc.childCount; i++) {
        const node = doc.child(i);
        decorations.push(
            Decoration.node(pos, pos + node.nodeSize, { class: HIDDEN_SELECTION_CLASS }),
        );
        pos += node.nodeSize;
    }
    return DecorationSet.create(doc, decorations);
}

export const hiddenSelectionPlugin = $prose(() =>
    new Plugin({
        props: {
            // Computed per update rather than cached in plugin state: the walk
            // is O(blocks in the selection) and only runs for the rare
            // invisible selection, while a cached set would have to be mapped
            // through every doc change to save nothing measurable.
            decorations: hiddenSelectionDecorations,
        },
    }),
);
