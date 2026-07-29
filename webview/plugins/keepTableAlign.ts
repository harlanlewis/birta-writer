/**
 * Replacement for preset-gfm's `keepTableAlignPlugin` — same behavior, without
 * the per-keystroke whole-document walk (MAR-137).
 *
 * What the behavior is: a table's body cells mirror their column's HEADER cell
 * `alignment`, so the serializer writes one consistent `:---` marker per column
 * (the attr is real fidelity, not decoration — see `tableAlignDefault.ts`).
 *
 * Why upstream's version is replaced rather than tolerated. Its
 * `appendTransaction` is:
 *
 *     const check = (node, pos) => {
 *         if (!tr) tr = state.tr;                      // before the type test
 *         if (node.type.name !== "table_cell") return;
 *         ...
 *     };
 *     if (oldState.doc !== state.doc) state.doc.descendants(check);
 *     return tr;
 *
 * — a full recursive `descendants` walk of the WHOLE document, down to every
 * text node, on every doc-changing transaction, and it allocates `tr` on the
 * first node visited rather than when it has an edit to make. So it always
 * returns a transaction, which makes ProseMirror run a second `applyInner`
 * (every plugin's state field, again) for every keystroke. Measured on the
 * 300 KB `xlarge` typing fixture — which contains **no tables at all** — the
 * two together were 16.1 ms of a 23.7 ms per-keystroke dispatch median: 68%,
 * removing which puts the fixture back under the 16 ms frame budget.
 *
 * The two corrections here:
 *
 *   1. `alignment` is a NODE ATTR, and an edit confined to one textblock's
 *      inline content cannot change a node attr anywhere — so there is nothing
 *      to reconcile and the walk is skipped outright. That is the typing case,
 *      and `singleTextblockInlineEdit` is the same observe-the-two-docs test
 *      the Contents outline and the Notes scanner already use. Anything it
 *      can't localize (Enter, paste, delete, an align command, a whole-document
 *      replacement) falls through to the walk, exactly as upstream.
 *   2. `tr` is allocated only when a cell actually needs re-marking, so a
 *      transaction is appended only when one is warranted.
 *
 * The fallback walk is deliberately left as a plain `descendants` pass. Not
 * descending into textblocks looks like an obvious further win and measured as
 * nothing (Enter × 40 on `xlarge`: 33.9 ms vs 34.0 ms median — noise), because
 * a structural edit's cost is dominated by the other plugins that recompute on
 * it, not by this walk. It was written, measured, and removed rather than
 * shipped as an unverified optimization.
 */
import type { Node as ProseNode, Transaction } from "../pm";
import { Plugin, PluginKey } from "../pm";
import { $prose } from "@milkdown/utils";
import { singleTextblockInlineEdit } from "../utils/textblockEdit";

const keepTableAlignKey = new PluginKey("keepTableAlign");

export const keepTableAlignPlugin = $prose(() =>
    new Plugin({
        key: keepTableAlignKey,
        appendTransaction(_trs, oldState, state) {
            if (oldState.doc === state.doc) {
                return null;
            }
            // Inline-content-only edit → no node attr changed → nothing to do.
            if (singleTextblockInlineEdit(oldState.doc, state.doc)) {
                return null;
            }
            let tr: Transaction | null = null;
            state.doc.descendants((node: ProseNode, pos: number) => {
                if (node.type.name !== "table_cell") {
                    return true;
                }
                const $pos = state.doc.resolve(pos);
                const headerRow = $pos.node($pos.depth - 1).firstChild;
                if (!headerRow) {
                    return false;
                }
                const headerCell = headerRow.maybeChild($pos.index($pos.depth));
                if (!headerCell) {
                    return false;
                }
                const alignment = headerCell.attrs["alignment"];
                if (alignment !== node.attrs["alignment"]) {
                    tr ??= state.tr;
                    tr.setNodeMarkup(pos, undefined, { ...node.attrs, alignment });
                }
                // A cell's own content holds no further cells.
                return false;
            });
            return tr;
        },
    }),
);
