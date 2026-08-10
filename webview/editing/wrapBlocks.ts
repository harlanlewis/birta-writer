/**
 * editing/wrapBlocks.ts
 *
 * The two halves of a quote-family gesture: put the blocks the selection
 * covers INSIDE a container (blockquote, callout), and take them back OUT.
 * One mechanism, shared by the toolbar Quote dropdown, the slash menu, and
 * the block menu's Turn-into, so all three agree.
 *
 * Why this exists rather than prosemirror-commands' `wrapIn`: `wrapIn` wraps
 * the INNERMOST block range and gives up when the schema forbids the wrapper
 * there. A caret in a list item is exactly that case — `list_item` content is
 * `paragraph block*`, so its first child cannot be a blockquote — and the
 * whole gesture silently did nothing. `table_cell` content is `paragraph`,
 * so a caret in a table did nothing either.
 *
 * `wrapBlocksIn` instead offers the range at each ancestor depth to the
 * schema and takes the innermost one the schema accepts. The block the caret
 * is in is quoted where that is legal (a list item's SECOND paragraph, a
 * paragraph in a callout); where it is not, the search climbs to the whole
 * list or the whole table, which is both the only legal reading and the one
 * a user means by "quote this list". The result is always markdown a
 * commonmark/GFM parser round-trips, because the schema is the markdown
 * grammar here.
 *
 * `liftBlocksOutOf` is the inverse and is named by node type, not by "the
 * nearest lift target": plain `lift` on a quoted list lifts the paragraph out
 * of its list item, which is a list edit rather than an unquote. A selection
 * running past the container's end is clamped to it, so the gesture never
 * reaches blocks that were never inside.
 */
import { findWrapping, liftTarget, NodeRange } from "../pm";
import type { Attrs, Command, EditorState, Node as ProseNode, NodeType } from "../pm";

export interface WrapTarget {
    /** The sibling run that goes inside the wrapper. */
    range: NodeRange;
    /** The node types to build around it (`findWrapping`'s answer). */
    wrapping: NonNullable<ReturnType<typeof findWrapping>>;
    /** The first block that ends up inside — what the wrapper leads with. */
    first: ProseNode;
}

/**
 * The blocks a wrap in `type` would cover: the innermost ancestor depth whose
 * schema accepts the wrapper. Null when no depth does. Exported so a caller
 * can look at what it is about to wrap (a callout's `attached` attr describes
 * its first body block) without duplicating the search.
 */
export function wrapTarget(
    state: EditorState,
    type: NodeType,
    attrs: Attrs | null = null,
): WrapTarget | null {
    const { $from, $to } = state.selection;
    const innermost = $from.blockRange($to);
    if (!innermost) {
        return null;
    }
    // Depth counts the range's PARENT, so descending it widens the range:
    // paragraph-in-item, then the item, then the whole list, then the
    // top-level block. `blockRange` has already proved $to sits inside the
    // innermost parent, and an ancestor only ever holds more.
    for (let depth = innermost.depth; depth >= 0; depth--) {
        const range = new NodeRange($from, $to, depth);
        const wrapping = findWrapping(range, type, attrs);
        if (wrapping) {
            return { range, wrapping, first: range.parent.child(range.startIndex) };
        }
    }
    return null;
}

/**
 * Wrap the blocks the selection covers in `type`, at the innermost depth the
 * schema allows it. False when no depth allows it at all (nothing is
 * dispatched), so a caller can fall back.
 */
export function wrapBlocksIn(type: NodeType, attrs: Attrs | null = null): Command {
    return (state, dispatch) => {
        const target = wrapTarget(state, type, attrs);
        if (!target) {
            return false;
        }
        dispatch?.(state.tr.wrap(target.range, target.wrapping).scrollIntoView());
        return true;
    };
}

/**
 * Lift the blocks the selection covers out of the enclosing `typeName`
 * container. Lifts only part of a container when the selection covers only
 * part of it (the container splits, as it does everywhere else in
 * ProseMirror); false when the selection is in no such container.
 */
export function liftBlocksOutOf(typeName: string): Command {
    return (state, dispatch) => {
        const { $from, $to } = state.selection;
        for (let depth = $from.depth; depth > 0; depth--) {
            if ($from.node(depth).type.name !== typeName) {
                continue;
            }
            // A selection that starts inside the container and ends past it
            // still means "unquote", so the end is clamped to the container
            // rather than the gesture refusing.
            const end = Math.min($to.pos, $from.end(depth));
            const $end = state.doc.resolve(Math.max(end, $from.pos));
            const range = new NodeRange($from, $end, depth);
            const target = liftTarget(range);
            if (target === null) {
                return false;
            }
            dispatch?.(state.tr.lift(range, target).scrollIntoView());
            return true;
        }
        return false;
    };
}
