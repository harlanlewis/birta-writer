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
 *   - gutter markers/chevrons keep their own mousedown (they stopPropagation
 *     before this listener sees anything);
 *   - Escape cancels; the rectangle needs ~4px of travel to appear, so a
 *     stray margin click doesn't flash chrome.
 */
import type { EditorView } from "@milkdown/prose/view";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { TextSelection } from "@milkdown/prose/state";
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
            document.removeEventListener("mousemove", onMove, true);
            document.removeEventListener("mouseup", onUp, true);
            document.removeEventListener("keydown", onKey, true);
            window.removeEventListener("blur", onBlur);
            // Let the selection-cover sync own the tint from here; a
            // canceled marquee leaves no residue.
            if (!range || range.blocks === 0) {
                hideRangeVeil();
            }
        };

        const onMove = (move: MouseEvent): void => {
            if ((move.buttons & 1) === 0) {
                range = null;
                stop();
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
            if (!commit) {
                return;
            }
            // A selection spanning the covered blocks — the cover machinery
            // (markers, multi-drag, tint) takes over from here.
            const { doc } = view.state;
            const $from = doc.resolve(Math.min(commitRange!.from + 1, doc.content.size));
            const $to = doc.resolve(Math.max(0, commitRange!.to - 1));
            view.dispatch(view.state.tr.setSelection(TextSelection.between($from, $to)));
            view.focus();
        };

        const onKey = (key: KeyboardEvent): void => {
            // Only a VISIBLY active marquee owns Escape — an armed-but-idle
            // session (mousedown, no travel yet) must not eat anyone's key.
            if (key.key === "Escape" && active) {
                key.preventDefault();
                key.stopPropagation();
                range = null;
                stop();
            }
        };
        const onBlur = (): void => {
            range = null;
            stop();
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
