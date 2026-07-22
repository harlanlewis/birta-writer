/**
 * Shared "jump to a document range" for the review sidebar's Proofreading and
 * Notes tabs — the click-to-navigate the Contents tab does for headings, but
 * for an arbitrary span. Unfolds any collapsing ancestor, selects the range,
 * and scrolls it below the sticky topbar. Navigation only; mutates the
 * selection, never the document.
 *
 * Unlike a ToC heading jump — where the target heading BECOMES the sticky
 * title, so nothing overlays it — a note/finding sits inside a section, so the
 * active heading's sticky title floats OVER the content top. Reserve its height
 * (measureStickyHeadingHeight) on top of the topbar so the target lands below
 * the sticky, not hidden under it.
 */
import type { EditorView } from "@/pm";
import { TextSelection } from "@/pm";
import { revealPosition } from "@/editing/blockOps";
import { scrollElementBelowTopbar } from "@/utils/headingUtils";
import { measureStickyHeadingHeight } from "@/plugins/caretScrollMargin";

export function revealRange(view: EditorView, from: number, to: number): void {
    const size = view.state.doc.content.size;
    const f = Math.max(0, Math.min(from, size));
    const t = Math.max(f, Math.min(to, size));
    try {
        // A target hidden inside a collapsed fold is an explicit entry intent:
        // unfold everything containing it first (mirrors the Contents tab).
        revealPosition(view, f);
    } catch { /* unexpected structure — selection + scroll below still help */ }
    try {
        const sel = f === t
            ? TextSelection.near(view.state.doc.resolve(f))
            : TextSelection.create(view.state.doc, f, t);
        view.dispatch(view.state.tr.setSelection(sel));
    } catch { /* ignore — position may be non-selectable */ }
    try {
        const { node } = view.domAtPos(f);
        const el = node.nodeType === Node.TEXT_NODE
            ? (node.parentElement as HTMLElement | null)
            : (node as HTMLElement);
        if (el) { scrollElementBelowTopbar(el, measureStickyHeadingHeight() + 8); }
    } catch { /* ignore */ }
    view.focus();
}
