/**
 * components/blockMenu/marquee.ts
 *
 * Marquee block selection (MAR-82 v1): a mousedown in the editor's MARGINS —
 * the gutter column left of the content, or the space right of it — arms a
 * rubber-band. Crossing a small threshold draws the rectangle and live-tints
 * the covered top-level blocks; mouseup sets a TextSelection spanning them,
 * which plugs straight into everything the selection cover already powers:
 * covered-marker reveal, drag-any-covered-marker multi-move, the selection
 * tint, and undo's selection restore.
 *
 * Field rules honored (Notion / Editor.js / Plate consensus):
 *   - a pointer-down inside text content NEVER becomes a marquee (Notion
 *     explicitly reverted stealing text selection in 2022);
 *   - gutter markers/chevrons keep their own mousedown (the containment
 *     test filters everything inside ProseMirror's content — this capture
 *     listener fires before any target-phase stopPropagation could);
 *   - Escape cancels; the rectangle needs ~4px of travel to appear, so a
 *     stray margin click doesn't flash chrome.
 */
import type { EditorView } from "@milkdown/prose/view";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { TextSelection } from "@milkdown/prose/state";
import { selectionCoverRange } from "./drag";
import { hideRangeVeil, showRangeVeil } from "./rangeIndicator";

const MARQUEE_THRESHOLD = 4;

let marqueeEl: HTMLElement | null = null;

function drawRect(x1: number, y1: number, x2: number, y2: number): void {
    if (!marqueeEl || !marqueeEl.isConnected) {
        marqueeEl = document.createElement("div");
        marqueeEl.className = "block-marquee";
        document.body.appendChild(marqueeEl);
    }
    marqueeEl.style.left = `${Math.min(x1, x2)}px`;
    marqueeEl.style.top = `${Math.min(y1, y2)}px`;
    marqueeEl.style.width = `${Math.abs(x2 - x1)}px`;
    marqueeEl.style.height = `${Math.abs(y2 - y1)}px`;
    marqueeEl.style.display = "block";
}

function hideRect(): void {
    if (marqueeEl) {
        marqueeEl.style.display = "none";
    }
}

/** The horizontal band the document's blocks occupy (content column). */
function contentBounds(view: EditorView): { left: number; right: number } | null {
    let left = Infinity;
    let right = -Infinity;
    view.state.doc.forEach((_node: ProseNode, offset: number) => {
        const dom = view.nodeDOM(offset);
        if (dom instanceof HTMLElement) {
            const rect = dom.getBoundingClientRect();
            // Folded-away blocks (display:none) report all-zero rects — one
            // collapsed section anywhere would drag `left` to 0 and kill
            // left-margin arming for the whole document.
            if (rect.width === 0 && rect.height === 0) {
                return;
            }
            left = Math.min(left, rect.left);
            right = Math.max(right, rect.right);
        }
    });
    return Number.isFinite(left) ? { left, right } : null;
}

/** Top-level blocks whose vertical extent intersects [yTop, yBottom]. */
function coveredRange(
    view: EditorView,
    yTop: number,
    yBottom: number,
): { from: number; to: number; blocks: number } | null {
    let from: number | null = null;
    let to: number | null = null;
    let blocks = 0;
    view.state.doc.forEach((node: ProseNode, offset: number) => {
        const dom = view.nodeDOM(offset);
        if (!(dom instanceof HTMLElement)) {
            return;
        }
        const rect = dom.getBoundingClientRect();
        // Zero-rect (folded-hidden) blocks would count as "covered" whenever
        // the marquee reaches the viewport top (yTop <= 0) — exploding the
        // range across every hidden block in the document.
        if (rect.width === 0 && rect.height === 0) {
            return;
        }
        if (rect.bottom >= yTop && rect.top <= yBottom) {
            if (from === null) {
                from = offset;
            }
            to = offset + node.nodeSize;
            blocks++;
        }
    });
    return from === null || to === null ? null : { from, to, blocks };
}

/**
 * Commit the marquee's covered range as a document selection. TextSelection
 * snaps to valid TEXT positions, so leaf-edged runs (an HR at either end)
 * shrink to the text they contain — a known v1 limit until a block-range
 * Selection type lands (MAR-82 remainder); the caller reconciles the tint
 * with the real cover afterward so the UI never lies. Returns false (and
 * dispatches nothing) when the run contains no selectable text at all.
 * Exported for unit testing.
 */
export function commitMarqueeSelection(
    view: EditorView,
    range: { from: number; to: number },
): boolean {
    const { doc } = view.state;
    const $from = doc.resolve(Math.min(range.from + 1, doc.content.size));
    const $to = doc.resolve(Math.max(0, range.to - 1));
    const selection = TextSelection.between($from, $to);
    // A leaf-only run (just an HR) snaps to an empty caret OUTSIDE the run —
    // committing that would be a surprise caret teleport, not a selection.
    if (selection.empty) {
        return false;
    }
    view.dispatch(view.state.tr.setSelection(selection));
    view.focus();
    return true;
}

/**
 * Arm marquee selection on the view. Returns a dispose function (called from
 * the plugin view's destroy).
 */
export function wireMarquee(view: EditorView): () => void {
    const onMouseDown = (event: MouseEvent): void => {
        if (event.button !== 0) {
            return;
        }
        // Only true container-margin pointer-downs arm a marquee: anything
        // INSIDE ProseMirror's content (gutter chrome, NodeView panels,
        // synthetic events bubbling from buttons with clientX=0) belongs to
        // its own handler. The PM root itself still qualifies — its padding
        // is margin space.
        if (
            event.target instanceof Element &&
            event.target !== view.dom &&
            view.dom.contains(event.target)
        ) {
            return;
        }
        const bounds = contentBounds(view);
        if (!bounds) {
            return;
        }
        // Only the margins arm a marquee — inside the content column the
        // pointer belongs to ProseMirror's own text selection.
        const inMargin = event.clientX < bounds.left - 2 || event.clientX > bounds.right + 2;
        if (!inMargin) {
            return;
        }
        // NO preventDefault here: margin mousedowns land on the CONTAINER,
        // outside ProseMirror's element, so PM never sees them anyway — and
        // swallowing them broke unrelated click-through behavior (panels
        // dismissing on outside clicks). The session only takes over the
        // pointer once the threshold is crossed.

        const startX = event.clientX;
        const startY = event.clientY;
        let active = false;
        let range: { from: number; to: number; blocks: number } | null = null;

        const stop = (): void => {
            hideRect();
            document.body.classList.remove("block-marqueeing");
            document.removeEventListener("mousemove", onMove, true);
            document.removeEventListener("mouseup", onUp, true);
            document.removeEventListener("keydown", onKey, true);
            window.removeEventListener("blur", onBlur);
        };

        const onMove = (move: MouseEvent): void => {
            if ((move.buttons & 1) === 0) {
                cancel();
                return;
            }
            if (!active) {
                if (
                    Math.abs(move.clientX - startX) < MARQUEE_THRESHOLD &&
                    Math.abs(move.clientY - startY) < MARQUEE_THRESHOLD
                ) {
                    return;
                }
                active = true;
                // Same suppression as drags: no tooltips/link popups/marker
                // reveals popping under an active rubber-band, and no native
                // text selection painting alongside it.
                document.body.classList.add("block-marqueeing");
            }
            move.preventDefault();
            drawRect(startX, startY, move.clientX, move.clientY);
            const yTop = Math.min(startY, move.clientY);
            const yBottom = Math.max(startY, move.clientY);
            range = coveredRange(view, yTop, yBottom);
            if (range) {
                showRangeVeil(view, range, "select");
            } else {
                hideRangeVeil();
            }
        };

        const onUp = (): void => {
            const commit = active && range && range.blocks > 0;
            const commitRange = range;
            stop();
            if (commit) {
                commitMarqueeSelection(view, commitRange!);
            }
            // Reconcile the tint with the REAL post-commit cover (the sync's
            // coverKey bookkeeping was bypassed by the live preview, so its
            // early-return would leave a stale tint painted — e.g. after a
            // single-block marquee, whose selection has no multi-block
            // cover). Same reconciliation the drag handle uses.
            const cover = selectionCoverRange(view);
            if (cover) {
                showRangeVeil(view, cover, "select");
            } else {
                hideRangeVeil();
            }
        };

        const cancel = (): void => {
            range = null;
            stop();
            const cover = selectionCoverRange(view);
            if (cover) {
                showRangeVeil(view, cover, "select");
            } else {
                hideRangeVeil();
            }
        };
        const onKey = (key: KeyboardEvent): void => {
            // Only a VISIBLY active marquee owns Escape — an armed-but-idle
            // session (mousedown, no travel yet) must not eat anyone's key.
            if (key.key === "Escape" && active) {
                key.preventDefault();
                key.stopPropagation();
                cancel();
            }
        };
        const onBlur = (): void => {
            cancel();
        };

        document.addEventListener("mousemove", onMove, true);
        document.addEventListener("mouseup", onUp, true);
        document.addEventListener("keydown", onKey, true);
        window.addEventListener("blur", onBlur);
    };

    // The visual margins belong to the editor's CONTAINER (#editor) — the
    // ProseMirror element starts at the content column, so margin clicks
    // never reach view.dom. Capture phase: this must win against
    // ProseMirror's own mousedown handling for margin clicks (and ONLY
    // margin clicks — content-column pointer-downs fall through untouched).
    const host = view.dom.closest("#editor") ?? view.dom.parentElement ?? view.dom;
    host.addEventListener("mousedown", onMouseDown as EventListener, true);
    return () => {
        host.removeEventListener("mousedown", onMouseDown as EventListener, true);
    };
}
