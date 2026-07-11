/**
 * components/blockMenu/drag.ts
 *
 * Drag-to-reorder for the gutter block markers (MAR-19). Pointer-event based
 * — native HTML5 DnD is deliberately avoided (it leaked drag payloads into
 * the document and fought ProseMirror's own drop handler; see MAR-36).
 *
 * A mousedown on a marker arms a potential drag; crossing a small movement
 * threshold starts the session (and suppresses the click that would open the
 * block menu). The dragged unit is moveRangeAt's answer — a heading brings
 * its whole section, everything else moves alone. While dragging:
 *   - a drop indicator line (theme accent) snaps to the nearest top-level
 *     block boundary under the pointer — any boundary outside the dragged
 *     range is a legal target (unlike the menu's Move rows, which hop whole
 *     units, a drag is a free-form refile: markdown is text, and dropping a
 *     section inside another section is a legitimate outline edit);
 *   - the window auto-scrolls when the pointer nears the viewport edges;
 *   - Escape cancels, mouseup commits (one transaction, one undo step).
 */
import type { EditorView } from "@milkdown/prose/view";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { closeBlockMenu, moveBlockTo, moveRangeAt } from "./index";
import { hideTooltip } from "../../ui/tooltip";

/** A droppable boundary between top-level blocks. */
export interface DropBoundary {
    /** Document position of the boundary (before the block starting here). */
    pos: number;
    /** Viewport y of the boundary line. */
    y: number;
}

/**
 * Every top-level block boundary as a document position: before each block,
 * plus the end of the document. Pure on the doc; the caller pairs positions
 * with viewport geometry. Exported for unit testing.
 */
export function blockBoundaryPositions(doc: ProseNode): number[] {
    const positions: number[] = [];
    doc.forEach((_node: ProseNode, offset: number) => {
        positions.push(offset);
    });
    positions.push(doc.content.size);
    return positions;
}

/**
 * The boundary to drop at for a pointer at `pointerY`, or null when every
 * candidate is inside (or equal to an edge of) the dragged range — dropping
 * there would be a no-op. Nearest-y wins. Exported for unit testing.
 */
export function dropTargetFor(
    boundaries: readonly DropBoundary[],
    pointerY: number,
    range: { from: number; to: number },
): DropBoundary | null {
    let best: DropBoundary | null = null;
    let bestDist = Infinity;
    for (const boundary of boundaries) {
        // Boundaries inside the dragged range — including its own edges —
        // are all no-op drops; skip them so the indicator never suggests one.
        if (boundary.pos >= range.from && boundary.pos <= range.to) {
            continue;
        }
        const dist = Math.abs(boundary.y - pointerY);
        if (dist < bestDist) {
            bestDist = dist;
            best = boundary;
        }
    }
    return best;
}

/** Pixels of pointer travel before a mousedown becomes a drag. */
const DRAG_THRESHOLD = 4;
/** Viewport margin (px) inside which the window auto-scrolls. */
const SCROLL_ZONE = 80;
/** Max auto-scroll speed (px per frame). */
const SCROLL_STEP = 24;

/** Current viewport geometry of every top-level block boundary. */
function measureBoundaries(view: EditorView): DropBoundary[] {
    const { doc } = view.state;
    const boundaries: DropBoundary[] = [];
    let lastBottom: number | null = null;
    doc.forEach((_node: ProseNode, offset: number) => {
        const dom = view.nodeDOM(offset);
        if (dom instanceof HTMLElement) {
            const rect = dom.getBoundingClientRect();
            boundaries.push({ pos: offset, y: rect.top });
            lastBottom = rect.bottom;
        }
    });
    if (lastBottom !== null) {
        boundaries.push({ pos: doc.content.size, y: lastBottom });
    }
    return boundaries;
}

let indicatorEl: HTMLElement | null = null;

function indicator(): HTMLElement {
    if (!indicatorEl) {
        indicatorEl = document.createElement("div");
        indicatorEl.className = "block-drag-indicator";
        document.body.appendChild(indicatorEl);
    }
    return indicatorEl;
}

// The cursor-riding pill naming what's being dragged ("##  3 blocks" for a
// section) — the honest version of a drag ghost for a source-mirroring
// gutter: the glyph, not a rendered preview.
let pillEl: HTMLElement | null = null;

function showPill(x: number, y: number, label: string): void {
    if (!pillEl) {
        pillEl = document.createElement("div");
        pillEl.className = "block-drag-pill";
        document.body.appendChild(pillEl);
    }
    pillEl.textContent = label;
    pillEl.style.left = `${x + 14}px`;
    pillEl.style.top = `${y + 14}px`;
    pillEl.style.display = "block";
}

function hidePill(): void {
    if (pillEl) {
        pillEl.style.display = "none";
    }
}

/** Pill label: the marker glyph, plus a count when a section drags along. */
function pillLabel(view: EditorView, glyph: string, range: { from: number; to: number }): string {
    let blocks = 0;
    view.state.doc.forEach((node: ProseNode, offset: number) => {
        if (offset >= range.from && offset < range.to) {
            blocks++;
        }
    });
    return blocks > 1 ? `${glyph}  ${blocks} blocks` : glyph;
}

function showIndicator(view: EditorView, y: number): void {
    const el = indicator();
    const editorRect = view.dom.getBoundingClientRect();
    el.style.left = `${editorRect.left}px`;
    el.style.width = `${editorRect.width}px`;
    el.style.top = `${y - 1}px`;
    el.style.display = "block";
}

function hideIndicator(): void {
    if (indicatorEl) {
        indicatorEl.style.display = "none";
    }
}

/**
 * Arm a gutter marker for drag-to-reorder. Call once per marker; the handler
 * coexists with the marker's click-for-menu (a drag past the threshold sets
 * `data-dragged`, which the click handler consumes to skip opening the menu).
 */
export function wireMarkerDrag(
    view: EditorView,
    marker: HTMLElement,
    blockPos: () => number | null,
): void {
    marker.addEventListener("mousedown", (event: MouseEvent) => {
        if (event.button !== 0) {
            return;
        }
        const startX = event.clientX;
        const startY = event.clientY;
        let dragging = false;
        let target: DropBoundary | null = null;
        let range: { from: number; to: number } | null = null;
        let boundaries: DropBoundary[] = [];
        let scrollDir = 0;
        let scrollRaf = 0;
        let lastPointerY = startY;
        let label = "";

        const scrollLoop = (): void => {
            if (scrollDir !== 0) {
                window.scrollBy(0, scrollDir * SCROLL_STEP);
                // Geometry shifted under the pointer — remeasure and re-aim.
                boundaries = measureBoundaries(view);
                if (range) {
                    target = dropTargetFor(boundaries, lastPointerY, range);
                    if (target) {
                        showIndicator(view, target.y);
                    } else {
                        hideIndicator();
                    }
                }
                scrollRaf = requestAnimationFrame(scrollLoop);
            } else {
                scrollRaf = 0;
            }
        };

        const stop = (): void => {
            dragging = false;
            scrollDir = 0;
            if (scrollRaf) {
                cancelAnimationFrame(scrollRaf);
                scrollRaf = 0;
            }
            hideIndicator();
            hidePill();
            marker.classList.remove("heading-fold-marker--dragging");
            document.body.classList.remove("block-dragging");
            document.removeEventListener("mousemove", onMove, true);
            document.removeEventListener("mouseup", onUp, true);
            document.removeEventListener("keydown", onKey, true);
            window.removeEventListener("blur", onBlur);
            // The click-suppression flag must not outlive the session: the
            // click (if any) fires synchronously right after mouseup, so a
            // zero-delay cleanup runs after it — an Escape-canceled or
            // outside-released drag can't eat the marker's NEXT real click.
            setTimeout(() => {
                delete marker.dataset["dragged"];
            }, 0);
        };

        const onMove = (move: MouseEvent): void => {
            lastPointerY = move.clientY;
            // The button was released outside the window (no mouseup reaches
            // us): end the session instead of dragging with no button down.
            if (dragging && (move.buttons & 1) === 0) {
                stop();
                return;
            }
            if (!dragging) {
                if (
                    Math.abs(move.clientX - startX) < DRAG_THRESHOLD &&
                    Math.abs(move.clientY - startY) < DRAG_THRESHOLD
                ) {
                    return;
                }
                // Threshold crossed — the session starts now.
                dragging = true;
                marker.dataset["dragged"] = "1";
                const pos = blockPos();
                range = pos === null ? null : moveRangeAt(view, pos);
                if (!range) {
                    stop();
                    return;
                }
                boundaries = measureBoundaries(view);
                closeBlockMenu();
                hideTooltip();
                marker.classList.add("heading-fold-marker--dragging");
                document.body.classList.add("block-dragging");
                label = pillLabel(view, marker.textContent ?? "", range);
            }
            move.preventDefault();
            showPill(move.clientX, move.clientY, label);
            target = dropTargetFor(boundaries, move.clientY, range!);
            if (target) {
                showIndicator(view, target.y);
            } else {
                hideIndicator();
            }
            const nextDir =
                move.clientY < SCROLL_ZONE ? -1 :
                move.clientY > window.innerHeight - SCROLL_ZONE ? 1 : 0;
            if (nextDir !== scrollDir) {
                scrollDir = nextDir;
                if (scrollDir !== 0 && !scrollRaf) {
                    scrollRaf = requestAnimationFrame(scrollLoop);
                }
            }
        };

        const onUp = (): void => {
            const commit = dragging && range && target;
            const commitRange = range;
            const commitTarget = target;
            stop();
            if (commit) {
                moveBlockTo(view, commitRange!, commitTarget!.pos);
            }
        };

        const onKey = (key: KeyboardEvent): void => {
            if (key.key === "Escape" && dragging) {
                key.preventDefault();
                key.stopPropagation();
                stop();
            }
        };
        // Window blur (webview lost focus mid-drag): cancel, don't linger.
        const onBlur = (): void => {
            stop();
        };

        document.addEventListener("mousemove", onMove, true);
        document.addEventListener("mouseup", onUp, true);
        document.addEventListener("keydown", onKey, true);
        window.addEventListener("blur", onBlur);
    });
}
