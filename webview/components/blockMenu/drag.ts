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
import { selectInto } from "./turnInto";
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
 * The boundary to drop at for a pointer at `pointerY` — nearest-y wins — or
 * null when the NEAREST boundary sits inside (or at an edge of) the dragged
 * range: that's the "put it back" gesture, so the indicator hides and the
 * drop is a clean no-op. (Skipping own-range boundaries before choosing used
 * to snap the indicator away from the origin, making it impossible to drop a
 * block back where it was picked up.) Exported for unit testing.
 */
export function dropTargetFor(
    boundaries: readonly DropBoundary[],
    pointerY: number,
    range: { from: number; to: number },
): DropBoundary | null {
    let best: DropBoundary | null = null;
    let bestDist = Infinity;
    for (const boundary of boundaries) {
        const dist = Math.abs(boundary.y - pointerY);
        if (dist < bestDist) {
            bestDist = dist;
            best = boundary;
        }
    }
    if (best && best.pos >= range.from && best.pos <= range.to) {
        return null;
    }
    return best;
}

/**
 * The top-level block range covered by the ambient selection, when it spans
 * MORE THAN ONE top-level block — the Notion multi-drag contract: dragging
 * the marker of any block inside a multi-block selection drags them all.
 * Null for empty or single-block selections. Exported for unit testing.
 */
export function selectionCoverRange(view: EditorView): { from: number; to: number } | null {
    const sel = view.state.selection;
    if (sel.empty) {
        return null;
    }
    const doc = view.state.doc;
    const $from = doc.resolve(sel.from);
    const $to = doc.resolve(sel.to);
    const from = $from.depth >= 1 ? $from.before(1) : sel.from;
    const to = $to.depth >= 1 ? $to.after(1) : sel.to;
    let blocks = 0;
    doc.forEach((_node: ProseNode, offset: number) => {
        if (offset >= from && offset < to) {
            blocks++;
        }
    });
    return blocks > 1 ? { from, to } : null;
}

/** Pixels of pointer travel before a mousedown becomes a drag. */
const DRAG_THRESHOLD = 4;
/** Viewport margin (px) inside which the window auto-scrolls. */
const SCROLL_ZONE = 80;
/** Max auto-scroll speed (px per frame). */
const SCROLL_STEP = 24;

/** Current viewport geometry of every top-level block boundary
 * (blockBoundaryPositions supplies the positions; the DOM supplies the ys). */
function measureBoundaries(view: EditorView): DropBoundary[] {
    const { doc } = view.state;
    const boundaries: DropBoundary[] = [];
    let lastBottom: number | null = null;
    for (const pos of blockBoundaryPositions(doc)) {
        if (pos === doc.content.size) {
            if (lastBottom !== null) {
                boundaries.push({ pos, y: lastBottom });
            }
            continue;
        }
        const dom = view.nodeDOM(pos);
        if (dom instanceof HTMLElement) {
            const rect = dom.getBoundingClientRect();
            boundaries.push({ pos, y: rect.top });
            lastBottom = rect.bottom;
        }
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
    if (pillEl.textContent !== label) {
        pillEl.textContent = label; // fixed per session — skip per-move writes
    }
    pillEl.style.left = `${x + 14}px`;
    pillEl.style.top = `${y + 14}px`;
    pillEl.style.display = "block";
}

function hidePill(): void {
    if (pillEl) {
        pillEl.style.display = "none";
    }
}

// The veil dims everything the drag will move (the whole section for a
// heading) — a body-mounted translucent overlay in the editor's own
// background color. Deliberately NOT an opacity/class change on the block
// elements themselves: mutating ProseMirror-managed DOM wakes its observer
// and redraws the nodes, destroying the gutter widgets mid-drag.
let veilEl: HTMLElement | null = null;

function showVeil(view: EditorView, boundaries: readonly DropBoundary[], range: { from: number; to: number }): void {
    const top = boundaries.find((b) => b.pos === range.from)?.y;
    const bottom = boundaries.find((b) => b.pos === range.to)?.y;
    if (top === undefined || bottom === undefined || bottom <= top) {
        hideVeil();
        return;
    }
    if (!veilEl) {
        veilEl = document.createElement("div");
        veilEl.className = "block-drag-veil";
        document.body.appendChild(veilEl);
    }
    const editorRect = view.dom.getBoundingClientRect();
    veilEl.style.left = `${editorRect.left}px`;
    veilEl.style.width = `${editorRect.width}px`;
    veilEl.style.top = `${top}px`;
    veilEl.style.height = `${bottom - top}px`;
    veilEl.style.display = "block";
}

function hideVeil(): void {
    if (veilEl) {
        veilEl.style.display = "none";
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
        let wasMulti = false;
        // The doc the session's range/boundaries were measured against — an
        // inbound edit mid-drag (external file sync) invalidates them, and a
        // drop must then cancel rather than slice stale positions.
        let startDoc: ProseNode | null = null;

        const scrollLoop = (): void => {
            if (scrollDir !== 0) {
                window.scrollBy(0, scrollDir * SCROLL_STEP);
                // Geometry shifted under the pointer — remeasure and re-aim.
                boundaries = measureBoundaries(view);
                if (range) {
                    showVeil(view, boundaries, range);
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
            hideVeil();
            marker.classList.remove("heading-fold-marker--dragging");
            document.body.classList.remove("block-dragging");
            document.removeEventListener("mousemove", onMove, true);
            document.removeEventListener("mouseup", onUp, true);
            document.removeEventListener("keydown", onKey, true);
            window.removeEventListener("blur", onBlur);
            // The click-suppression flag must not outlive the interaction —
            // but it must survive until the mouse BUTTON is actually released
            // (an Escape-cancel leaves it held; the eventual release still
            // produces a click on the marker, which must stay suppressed).
            // A one-shot bubble-phase mouseup fires for the release — on the
            // commit path that's the very mouseup ending the drag — and its
            // zero-delay hop runs after the click that release produces.
            if (marker.dataset["dragged"]) {
                document.addEventListener(
                    "mouseup",
                    () => setTimeout(() => {
                        delete marker.dataset["dragged"];
                    }, 0),
                    { once: true },
                );
            }
        };

        const onMove = (move: MouseEvent): void => {
            lastPointerY = move.clientY;
            // The button was released outside the window (no mouseup reaches
            // us): end the session — armed or dragging — instead of leaking
            // listeners / dragging with no button down.
            if ((move.buttons & 1) === 0) {
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
                // Multi-block drag: a selection spanning several top-level
                // blocks, with this marker's block inside it, drags the whole
                // covered run (the selection is KEPT — history then restores
                // it on undo).
                const cover = selectionCoverRange(view);
                const multi = Boolean(
                    range && cover && range.from >= cover.from && range.from < cover.to,
                );
                wasMulti = multi;
                if (multi) {
                    range = cover;
                }
                if (!range) {
                    stop();
                    return;
                }
                boundaries = measureBoundaries(view);
                startDoc = view.state.doc;
                if (!multi) {
                    // Caret into the dragged block: history snapshots the
                    // selection before the drop's transaction, so undoing a
                    // drag scrolls back to where the block came FROM.
                    selectInto(view, range.from);
                }
                closeBlockMenu();
                hideTooltip();
                marker.classList.add("heading-fold-marker--dragging");
                document.body.classList.add("block-dragging");
                label = pillLabel(view, marker.textContent ?? "", range);
                showVeil(view, boundaries, range);
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
            // Doc changed mid-drag (external sync): the measured range and
            // boundaries describe a document that no longer exists — cancel.
            const commit = dragging && range && target && view.state.doc === startDoc;
            const commitRange = range;
            const commitTarget = target;
            const commitMulti = wasMulti;
            stop();
            if (commit) {
                moveBlockTo(view, commitRange!, commitTarget!.pos, { selectRun: commitMulti });
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
