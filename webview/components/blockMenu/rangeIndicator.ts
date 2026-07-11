/**
 * components/blockMenu/rangeIndicator.ts
 *
 * The ONE visual language for "these blocks are included" (MAR-85): a
 * body-mounted translucent veil in the editor's own background color dims
 * the covered block range. Every block-selection state shares it — a text
 * selection spanning blocks, a drag in flight (single block, heading
 * section, or multi-block run), and the future marquee (MAR-82).
 *
 * Also home to the landing flash (MAR-84): a brief accent tint over a moved
 * run at its destination, answering "where did it go" after auto-scroll.
 *
 * Everything here is overlay DOM. Deliberately NEVER a class/opacity change
 * on the block elements themselves: mutating ProseMirror-managed DOM wakes
 * its observer and redraws the nodes, destroying the gutter widgets.
 */
import type { EditorView } from "@milkdown/prose/view";
import type { Node as ProseNode } from "@milkdown/prose/model";

/** Viewport rect of the top-level blocks in [from, to), or null offscreen. */
function measureRange(
    view: EditorView,
    range: { from: number; to: number },
): { top: number; bottom: number; left: number; width: number } | null {
    let top: number | null = null;
    let bottom: number | null = null;
    view.state.doc.forEach((_node: ProseNode, offset: number) => {
        if (offset < range.from || offset >= range.to) {
            return;
        }
        const dom = view.nodeDOM(offset);
        if (dom instanceof HTMLElement) {
            const rect = dom.getBoundingClientRect();
            if (top === null) {
                top = rect.top;
            }
            bottom = rect.bottom;
        }
    });
    // Ranges that don't align to top-level children (a list ITEM) measure
    // from the range's own node directly.
    if (top === null) {
        const dom = view.nodeDOM(range.from);
        if (dom instanceof HTMLElement) {
            const rect = dom.getBoundingClientRect();
            top = rect.top;
            bottom = rect.bottom;
        }
    }
    if (top === null || bottom === null || bottom <= top) {
        return null;
    }
    const editorRect = view.dom.getBoundingClientRect();
    return { top, bottom, left: editorRect.left, width: editorRect.width };
}

/**
 * Two visual modes, one machinery:
 *   - "drag": the dimming veil — this content is IN MOTION;
 *   - "select": the selection tint (the editor's own selection color at
 *     block scope) — this content is INCLUDED. Selection must read as
 *     selection, not as dimming (dimming over colorful blocks like callouts
 *     washed the document out and implied "disabled").
 */
export type RangeIndicatorMode = "drag" | "select";

let veilEl: HTMLElement | null = null;
let veilArgs: {
    view: EditorView;
    range: { from: number; to: number };
    mode: RangeIndicatorMode;
} | null = null;

const repositionVeil = (): void => {
    if (!veilArgs) {
        return;
    }
    const rect = measureRange(veilArgs.view, veilArgs.range);
    if (!rect || !veilEl) {
        veilEl && (veilEl.style.display = "none");
        return;
    }
    veilEl.className = veilArgs.mode === "drag" ? "block-drag-veil" : "block-range-tint";
    veilEl.style.left = `${rect.left}px`;
    veilEl.style.width = `${rect.width}px`;
    veilEl.style.top = `${rect.top}px`;
    veilEl.style.height = `${rect.bottom - rect.top}px`;
    veilEl.style.display = "block";
};

/**
 * Mark the block range (dim for drags, selection-tint for selections).
 * Stays glued through scrolling/resizing (own capture listeners) until
 * hideRangeVeil. Re-calling replaces the tracked range/mode.
 */
export function showRangeVeil(
    view: EditorView,
    range: { from: number; to: number },
    mode: RangeIndicatorMode = "drag",
): void {
    // isConnected guard: an editor teardown (revert/reload) or a test's body
    // wipe can detach the singleton — re-append rather than paint nowhere.
    if (!veilEl || !veilEl.isConnected) {
        veilEl = document.createElement("div");
        document.body.appendChild(veilEl);
    }
    if (!veilArgs) {
        window.addEventListener("scroll", repositionVeil, { capture: true, passive: true });
        window.addEventListener("resize", repositionVeil);
    }
    veilArgs = { view, range, mode };
    repositionVeil();
}

export function hideRangeVeil(): void {
    if (veilArgs) {
        window.removeEventListener("scroll", repositionVeil, true);
        window.removeEventListener("resize", repositionVeil);
        veilArgs = null;
    }
    if (veilEl) {
        veilEl.style.display = "none";
    }
}

/**
 * Landing flash (MAR-84): a short accent-tinted fade over the blocks in
 * [from, to) — call right after a move lands. No-op when the range has no
 * measurable geometry (jsdom, offscreen).
 */
export function flashRange(view: EditorView, from: number, to: number): void {
    const rect = measureRange(view, { from, to });
    if (!rect) {
        return;
    }
    const flash = document.createElement("div");
    flash.className = "block-drop-flash";
    flash.style.left = `${rect.left}px`;
    flash.style.width = `${rect.width}px`;
    flash.style.top = `${rect.top}px`;
    flash.style.height = `${rect.bottom - rect.top}px`;
    document.body.appendChild(flash);
    // Double rAF so the initial opacity paints before the fade class lands.
    requestAnimationFrame(() =>
        requestAnimationFrame(() => flash.classList.add("block-drop-flash--fade")),
    );
    setTimeout(() => flash.remove(), 700);
}
