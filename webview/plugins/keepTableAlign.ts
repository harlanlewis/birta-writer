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
 *   1. The walk is bounded by the range that actually differs between the two
 *      docs (`changedRange`, the reference-equality diff scan). Each table
 *      overlapping that range is then checked in full, because re-aligning a
 *      header cell has to reach body cells outside the changed range.
 *   2. `tr` is allocated only when a cell actually needs re-marking, so a
 *      transaction is appended only when one is warranted.
 *
 * The first cut skipped the walk only when the edit was a single-textblock
 * inline edit, which covered typing and nothing else. Narrowing by range
 * instead covers the structural edits too — Enter on the 300 KB fixture went
 * 33.3 ms → 18.6 ms once this landed, a case the earlier shape could not help
 * because it fell straight through to a whole-document walk.
 *
 * This mirrors the fix proposed upstream (Milkdown `perf(preset-gfm)`), so the
 * two can be diffed line for line — and this file deleted outright — once that
 * lands and ships.
 */
import type { Node as ProseNode, Transaction } from "../pm";
import { Plugin, PluginKey } from "../pm";
import { $prose } from "@milkdown/utils";
import { changedRange } from "../utils/textblockEdit";

const keepTableAlignKey = new PluginKey("keepTableAlign");

export const keepTableAlignPlugin = $prose(() =>
    new Plugin({
        key: keepTableAlignKey,
        appendTransaction(_trs, oldState, state) {
            if (oldState.doc === state.doc) {
                return null;
            }
            const range = changedRange(oldState.doc, state.doc);
            if (!range) {
                return null;
            }

            let tr: Transaction | null = null;
            const check = (node: ProseNode, pos: number) => {
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
            };

            // Only a table that took part in the change can have fallen out of
            // step with its header row. `nodesBetween` reports the ancestors of
            // the range too, so a table is reached even when the edit sits deep
            // inside one of its cells — and each match is then checked IN FULL,
            // because re-aligning a header cell has to reach body cells far
            // outside the changed range.
            state.doc.nodesBetween(range.from, range.to, (node: ProseNode, pos: number) => {
                if (node.type.name !== "table") {
                    return true;
                }
                state.doc.nodesBetween(pos, pos + node.nodeSize, check);
                // Tables do not nest.
                return false;
            });
            return tr;
        },
    }),
);
