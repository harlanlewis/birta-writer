/**
 * webview/diffView/decorations.ts — drawing a plan (MAR-55).
 *
 * Insertions are the easy half: the content is in the document being rendered,
 * so an inline decoration over its range is enough. Deletions are not in that
 * document at all, so they have to be carried in from the base as widgets —
 * which is why a hunk knows both where the run lives (the base doc) and where
 * to draw it (the working doc).
 *
 * Both kinds of deleted content are built from the SAME schema the working
 * document uses, via `DOMSerializer.fromSchema`, rather than from any markup
 * written here. That is what keeps a removed table looking like this editor's
 * table rather than like a second renderer's guess at one.
 */
import { Decoration, DecorationSet, DOMSerializer } from "../pm";
import type { Node as ProseNode } from "../pm";
import { hasDeletion, hasInsertion, type DiffHunk } from "./diffPlan";

/** Marks the run of working-document content the base did not have. */
export const INSERTED_CLASS = "diff-ins";
/** Wraps deleted content drawn back into the working document. */
export const DELETED_INLINE_CLASS = "diff-del";
export const DELETED_BLOCK_CLASS = "diff-del-block";

/**
 * The deleted run, as DOM to hang off a widget decoration.
 *
 * The context split is load-bearing rather than cosmetic. An inline widget's
 * DOM sits inside a textblock's inline content, where a `<div>` or a `<p>` is
 * invalid: the browser reparents it out of the widget, and ProseMirror then
 * tracks a node that is no longer where it drew it. So an inline deletion is
 * flattened to its text inside a `<del>`, and only a block-context deletion
 * gets the real nodes back.
 */
export function renderDeleted(base: ProseNode, hunk: DiffHunk): HTMLElement {
    const { from, to } = hunk.base;
    if (hunk.deletedContext === "inline") {
        const del = document.createElement("del");
        del.className = DELETED_INLINE_CLASS;
        del.textContent = base.textBetween(from, to, "\n", "\n");
        del.contentEditable = "false";
        return del;
    }
    const host = document.createElement("div");
    host.className = DELETED_BLOCK_CLASS;
    host.contentEditable = "false";
    const serializer = DOMSerializer.fromSchema(base.type.schema);
    host.appendChild(serializer.serializeFragment(base.slice(from, to).content));
    return host;
}

/**
 * The decoration set for one plan.
 *
 * Deleted content takes `side: -1` so it sorts before anything inserted at the
 * same position: a replacement then reads in the order it happened, the old
 * words then the new ones, rather than the other way round. `marks: []` keeps
 * a widget dropped inside emphasised text from inheriting that emphasis, which
 * would style deleted content as though it were part of the sentence that
 * replaced it.
 */
export function buildDiffDecorations(
    base: ProseNode,
    working: ProseNode,
    hunks: readonly DiffHunk[],
): DecorationSet {
    const decorations: Decoration[] = [];
    for (const hunk of hunks) {
        if (hasDeletion(hunk)) {
            decorations.push(
                Decoration.widget(hunk.working.from, () => renderDeleted(base, hunk), {
                    side: -1,
                    marks: [],
                }),
            );
        }
        if (hasInsertion(hunk)) {
            decorations.push(
                Decoration.inline(hunk.working.from, hunk.working.to, {
                    class: INSERTED_CLASS,
                }),
            );
        }
    }
    return DecorationSet.create(working, decorations);
}
