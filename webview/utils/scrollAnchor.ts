/**
 * webview/utils/scrollAnchor.ts
 *
 * Keep the top visible content line stable across a layout mutation that
 * rewraps the document — a page width-mode flip (Full ⇄ Fixed) rewraps every
 * paragraph, and without anchoring whatever you were reading jumps to a
 * different scroll depth. (The font-size stepper has the same reflow shape
 * and can wrap this helper later.)
 *
 * Shape: capture the document position rendered at the top of the viewport
 * (just under the fixed topbar), run the mutation, then scroll by however far
 * that position moved. coordsAtPos forces layout, so the correction is
 * synchronous — no flash of the wrong scroll. The scroller is the window
 * (the editor is not its own scroller — scrollPersistence/visibleRange
 * precedent).
 *
 * Probe hardening copied from visibleRange.measureVisibleWindow: the X probe
 * sits a little inside the editor's text column (posAtCoords over the gutter
 * margin can miss), and every layout API is try/caught — a headless DOM or a
 * mid-teardown view degrades to running the mutation un-anchored, never to
 * throwing.
 */
import type { EditorView } from "../pm";
import { getTopbarBottom } from "./headingUtils";

/** The doc position at the top-of-viewport anchor line, or null. */
function topVisiblePos(view: EditorView, anchorY: number): number | null {
    try {
        const rect = view.dom.getBoundingClientRect();
        const left = rect.left + Math.min(rect.width / 2, 240);
        const found = view.posAtCoords({ left, top: anchorY });
        if (found) {
            return found.pos;
        }
        // A widget decoration under the probe (an embed card) can defeat
        // posAtCoords: map the element under the probe back to a position.
        const el = document.elementFromPoint(left, anchorY);
        if (el && view.dom.contains(el)) {
            return view.posAtDOM(el, 0);
        }
        return null;
    } catch {
        return null;
    }
}

function topOf(view: EditorView, pos: number): number | null {
    try {
        const coords = view.coordsAtPos(pos);
        // A real text line always has height; a degenerate (flat) rect means
        // the position lives inside hidden content — an embed paragraph's
        // display:none link — and is useless as an anchor measurement.
        if (coords.bottom - coords.top >= 1) {
            return coords.top;
        }
    } catch {
        /* fall through to the block box */
    }
    // Fall back to the enclosing top-level block's real DOM box — correct
    // for embed cards and any other block whose text is hidden chrome.
    try {
        const $pos = view.state.doc.resolve(pos);
        const blockPos = $pos.depth > 0 ? $pos.before(1) : pos;
        const dom = view.nodeDOM(blockPos);
        if (dom instanceof HTMLElement) {
            return dom.getBoundingClientRect().top;
        }
    } catch {
        /* unmeasurable */
    }
    return null;
}

/**
 * Run `mutate` (a reflow-causing DOM change) keeping the top visible line at
 * the same viewport height. With no view, no measurable anchor, or at the
 * very top of the document, it simply runs the mutation.
 */
export function withScrollAnchor(view: EditorView | null, mutate: () => void): void {
    if (!view || view.isDestroyed || window.scrollY <= 0) {
        mutate();
        return;
    }
    const anchorY = getTopbarBottom() + 2;
    const pos = topVisiblePos(view, anchorY);
    const before = pos === null ? null : topOf(view, pos);
    mutate();
    if (pos === null || before === null) {
        return;
    }
    const after = topOf(view, pos);
    if (after === null || after === before) {
        return;
    }
    window.scrollBy(0, after - before);
}
