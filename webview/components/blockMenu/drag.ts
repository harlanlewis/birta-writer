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
import { BlockRangeSelection } from "../../plugins/blockRange";
import { selectInto } from "./turnInto";
import { hideRangeVeil, showRangeVeil } from "./rangeIndicator";
import { hideTooltip } from "../../ui/tooltip";
import { t } from "../../i18n";

/** A droppable boundary between sibling blocks or sibling list items. */
export interface DropBoundary {
    /** Document position of the boundary (before the unit starting here). */
    pos: number;
    /** Viewport y of the boundary line. */
    y: number;
    /** Whether this slot takes top-level blocks or list items — a dragged
     * unit only sees boundaries of its own kind (schema legality). */
    kind: "block" | "item";
    /** Indicator geometry for item slots: the item column's left/width, so
     * the drop line indents to the target nesting depth. */
    left?: number;
    width?: number;
}

/**
 * Every droppable boundary as a document position: before each top-level
 * block plus the doc's end (kind "block"), and before each list item at any
 * nesting depth plus each list's end (kind "item"). Pure on the doc; the
 * caller pairs positions with viewport geometry. Exported for unit testing.
 */
export function blockBoundaryPositions(
    doc: ProseNode,
): { pos: number; kind: "block" | "item"; listPos?: number }[] {
    const positions: { pos: number; kind: "block" | "item"; listPos?: number }[] = [];
    const walkList = (list: ProseNode, listPos: number): void => {
        let lastEnd = listPos + 1;
        list.forEach((item: ProseNode, offset: number) => {
            const itemPos = listPos + 1 + offset;
            positions.push({ pos: itemPos, kind: "item", listPos });
            lastEnd = itemPos + item.nodeSize;
            item.forEach((child: ProseNode, childOffset: number) => {
                if (child.type.name === "bullet_list" || child.type.name === "ordered_list") {
                    walkList(child, itemPos + 1 + childOffset);
                }
            });
        });
        // End-of-list slot; carries its OWNING list so geometry is measured
        // per list, not from whatever item happened to be walked last (a
        // nested last item would otherwise shadow the outer list's slot).
        positions.push({ pos: lastEnd, kind: "item", listPos });
    };
    doc.forEach((node: ProseNode, offset: number) => {
        positions.push({ pos: offset, kind: "block" });
        if (node.type.name === "bullet_list" || node.type.name === "ordered_list") {
            walkList(node, offset);
        }
    });
    positions.push({ pos: doc.content.size, kind: "block" });
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
        // Ties break toward the LARGER position: coincident end-of-list
        // slots (a nested list ending flush with its parent) resolve to the
        // shallower slot, whose position is the greater.
        if (dist < bestDist || (dist === bestDist && best !== null && boundary.pos > best.pos)) {
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
    // An explicit block range IS its own cover — including a single block
    // (Escape's block selection paints and drags like any covered run).
    if (sel instanceof BlockRangeSelection) {
        return { from: sel.from, to: sel.to };
    }
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
/** Viewport margin (px) inside which the window auto-scrolls.
 * Shared with the marquee so both pointer sessions scroll identically. */
export const SCROLL_ZONE = 80;
/** Auto-scroll speed range (px per frame). */
const SCROLL_MIN = 2;
const SCROLL_MAX = 40;
/** How far past the viewport edge keeps accelerating (as a zone multiple). */
const SCROLL_OVERSHOOT = 1.5;

/**
 * Signed auto-scroll velocity (px per frame) for a pointer at `clientY`:
 * zero outside the edge zones, then a quadratic ramp with depth — barely
 * inside the zone creeps at SCROLL_MIN, the viewport edge is already brisk,
 * and dragging PAST the edge keeps accelerating up to SCROLL_MAX (the
 * dnd-kit/Figma convention: distance is the throttle, so 1px into the zone
 * never sprints). Shared by the drag and marquee sessions.
 */
export function scrollVelocityFor(clientY: number): number {
    const topDepth = SCROLL_ZONE - clientY;
    const bottomDepth = clientY - (window.innerHeight - SCROLL_ZONE);
    const depth = Math.max(topDepth, bottomDepth);
    if (depth <= 0) {
        return 0;
    }
    const t = Math.min(depth / SCROLL_ZONE, SCROLL_OVERSHOOT) / SCROLL_OVERSHOOT;
    const speed = SCROLL_MIN + (SCROLL_MAX - SCROLL_MIN) * t * t;
    return topDepth > bottomDepth ? -speed : speed;
}

/** Current viewport geometry of every droppable boundary
 * (blockBoundaryPositions supplies positions/kinds; the DOM supplies ys —
 * item slots also carry their column's left/width for the indented line). */
function measureBoundaries(view: EditorView): DropBoundary[] {
    const { doc } = view.state;
    const boundaries: DropBoundary[] = [];
    let lastBlockBottom: number | null = null;
    for (const { pos, kind, listPos } of blockBoundaryPositions(doc)) {
        if (kind === "block" && pos === doc.content.size) {
            if (lastBlockBottom !== null) {
                boundaries.push({ pos, y: lastBlockBottom, kind });
            }
            continue;
        }
        const dom = view.nodeDOM(pos);
        if (dom instanceof HTMLElement) {
            const rect = dom.getBoundingClientRect();
            if (kind === "item") {
                boundaries.push({ pos, y: rect.top, kind, left: rect.left, width: rect.width });
            } else {
                boundaries.push({ pos, y: rect.top, kind });
                lastBlockBottom = rect.bottom;
            }
        } else if (kind === "item" && listPos !== undefined) {
            // End-of-list slot: the OWNING list's bottom edge, at its own
            // items' column (its last DIRECT child supplies the indent —
            // deriving from the last WALKED item let a nested list's column
            // shadow the outer slot's geometry entirely).
            const listDom = view.nodeDOM(listPos);
            const listNode = doc.nodeAt(listPos);
            if (listDom instanceof HTMLElement && listNode && listNode.childCount > 0) {
                let lastChildOffset = 0;
                listNode.forEach((_child: ProseNode, childOffset: number) => {
                    lastChildOffset = childOffset;
                });
                const lastItemDom = view.nodeDOM(listPos + 1 + lastChildOffset);
                const column = lastItemDom instanceof HTMLElement
                    ? lastItemDom.getBoundingClientRect()
                    : listDom.getBoundingClientRect();
                boundaries.push({
                    pos,
                    y: listDom.getBoundingClientRect().bottom,
                    kind,
                    left: column.left,
                    width: column.width,
                });
            }
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
        const text = document.createElement("span");
        text.className = "block-drag-pill-label";
        const hint = document.createElement("span");
        hint.className = "block-drag-pill-hint";
        hint.textContent = t("esc to cancel");
        pillEl.append(text, hint);
        document.body.appendChild(pillEl);
    }
    const text = pillEl.querySelector<HTMLElement>(".block-drag-pill-label")!;
    if (text.textContent !== label) {
        text.textContent = label; // fixed per session — skip per-move writes
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

/** Pill label: the marker glyph, plus a count when a section drags along. */
function pillLabel(view: EditorView, name: string, range: { from: number; to: number }): string {
    let blocks = 0;
    view.state.doc.forEach((node: ProseNode, offset: number) => {
        if (offset >= range.from && offset < range.to) {
            blocks++;
        }
    });
    return blocks > 1 ? `${blocks} blocks` : name;
}

function showIndicator(view: EditorView, target: DropBoundary): void {
    const el = indicator();
    // Item slots indent the line to the target column (nesting depth is
    // visible at a glance); block slots span the editor.
    const editorRect = view.dom.getBoundingClientRect();
    el.style.left = `${target.left ?? editorRect.left}px`;
    el.style.width = `${target.width ?? editorRect.width}px`;
    el.style.top = `${target.y - 1}px`;
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
        let draggedKind: "block" | "item" = "block";
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
            const velocity = scrollDir === 0 ? 0 : scrollVelocityFor(lastPointerY);
            if (velocity !== 0) {
                window.scrollBy(0, velocity);
                // Geometry shifted under the pointer — remeasure and re-aim.
                boundaries = measureBoundaries(view).filter((b) => b.kind === draggedKind);
                if (range) {
                    target = dropTargetFor(boundaries, lastPointerY, range);
                    if (target) {
                        showIndicator(view, target);
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
            // A multi-block selection that outlives the session (e.g. an
            // Escape-canceled multi-drag) keeps its veil — one visual
            // language for the covered range, dragging or not.
            const survivingCover = selectionCoverRange(view);
            if (survivingCover) {
                showRangeVeil(view, survivingCover, "select");
            } else {
                hideRangeVeil();
            }
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
                // A dragged unit only sees slots of its own kind: items drop
                // at item boundaries (any list), blocks at block boundaries.
                draggedKind = !multi && view.state.doc.nodeAt(range.from)?.type.name === "list_item"
                    ? "item"
                    : "block";
                boundaries = measureBoundaries(view).filter((b) => b.kind === draggedKind);
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
                label = pillLabel(view, marker.dataset["pill"] ?? marker.textContent ?? "", range);
                showRangeVeil(view, range);
            }
            move.preventDefault();
            showPill(move.clientX, move.clientY, label);
            target = dropTargetFor(boundaries, move.clientY, range!);
            if (target) {
                showIndicator(view, target);
            } else {
                hideIndicator();
            }
            const nextDir = Math.sign(scrollVelocityFor(move.clientY));
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
