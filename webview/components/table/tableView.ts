/**
 * Google-Docs-style table affordances, implemented as a ProseMirror NodeView
 * for the gfm `table` node.
 *
 * DOM structure (see createTableView):
 *
 *   div.mw-table            (position: relative — the affordance frame)
 *   ├─ table
 *   │  └─ tbody             ← contentDOM: PM renders <tr> rows into it, so
 *   │                         editing + serialization are completely unchanged
 *   └─ div.mw-table-overlay (absolute, inset 0, pointer-events: none)
 *      ├─ .mw-row-grip …    (one per row — click selects, drag reorders)
 *      ├─ .mw-col-grip …    (one per column)
 *      ├─ .mw-row-insert …  (one per row gap — generous, sticky "+" zone)
 *      ├─ .mw-col-insert …  (one per column gap)
 *      ├─ .mw-drop-line     (drag drop indicator)
 *      └─ .mw-drag-ghost    (translucent row/column preview during drag)
 *
 * A future column-resize layer would live in the overlay too: add a
 * <colgroup> to the <table> and a row of `.mw-col-resize` handles positioned on
 * the vertical gridlines (the same measurement path reposition() already uses).
 * The overlay is intentionally the single home for all non-content chrome so
 * that adding it needs no restructuring here.
 *
 * All affordance ACTIONS are index-based (row/column indices from TableMap),
 * never geometry-based, so they work headlessly (jsdom, tests). Only the
 * POSITIONING of the affordances measures the live DOM, and that is the part
 * that needs a real layout engine (GUI verification).
 */
import "./table.css";
import {
    TableMap,
    CellSelection,
    selectedRect,
    addRowBefore,
    addRowAfter,
    addColumnBefore,
    addColumnAfter,
} from "@milkdown/prose/tables";
import { TextSelection } from "@milkdown/prose/state";
import type { Node as PMNode } from "@milkdown/prose/model";
import type { EditorView, NodeView } from "@milkdown/prose/view";
import {
    resolveDropIndexRange,
    reorderRowRange,
    reorderColumnRange,
} from "./reorder";
import { IconPlus } from "@/ui/icons";
import { applyTooltip, hideTooltip } from "@/ui/tooltip";
import { t } from "@/i18n";
import { tagContentGuard } from "@/plugins/contentGuard";
import { createFoldEllipsis } from "@/ui/foldEllipsis";
import { foldPluginKey, type FoldMeta } from "@/plugins/foldState";

type GetPos = () => number | undefined;

/** Viewport bounds of a row along the vertical axis. */
export interface RowBound {
    top: number;
    bottom: number;
}
/** Viewport bounds of a column along the horizontal axis. */
export interface ColBound {
    left: number;
    right: number;
}
/** Indices of the affordances nearest the pointer (see nearestTargets). */
export interface NearestTargets {
    /** Hovered row index (clamped to the table range), or -1 if no rows. */
    row: number;
    /** Hovered column index (clamped to the table range), or -1 if no cols. */
    col: number;
    /** Nearest horizontal gap: 0..height (a row-insert index), or -1. */
    rowGap: number;
    /** Nearest vertical gap: 0..width (a column-insert index), or -1. */
    colGap: number;
}

/** Index of the bound containing `p`, else the nearest edge bound. */
function clampIndex(
    p: number,
    bounds: readonly { lo: number; hi: number }[],
): number {
    if (!bounds.length) {
        return -1;
    }
    for (let i = 0; i < bounds.length; i++) {
        if (p >= bounds[i]!.lo && p <= bounds[i]!.hi) {
            return i;
        }
    }
    return p < bounds[0]!.lo ? 0 : bounds.length - 1;
}

/** Nearest gap index (0..n) given gap positions at each start plus a trailing edge. */
function nearestGap(
    p: number,
    bounds: readonly { lo: number; hi: number }[],
): number {
    if (!bounds.length) {
        return -1;
    }
    let best = 0;
    let bestDist = Math.abs(p - bounds[0]!.lo);
    for (let g = 1; g < bounds.length; g++) {
        const d = Math.abs(p - bounds[g]!.lo);
        if (d < bestDist) {
            bestDist = d;
            best = g;
        }
    }
    const trailing = Math.abs(p - bounds[bounds.length - 1]!.hi);
    if (trailing < bestDist) {
        best = bounds.length; // gap after the last line
    }
    return best;
}

/**
 * Pure "which affordances are nearest the pointer" computation for the
 * Google-Docs-style contextual reveal. Takes cached viewport bounds (no DOM
 * reads) so it is fully unit-testable without a layout engine.
 *
 * @param px          pointer X in viewport coords
 * @param py          pointer Y in viewport coords
 * @param rowBounds   per-row {top,bottom} viewport bounds (row order)
 * @param colBounds   per-column {left,right} viewport bounds (column order)
 */
export function nearestTargets(
    px: number,
    py: number,
    rowBounds: readonly RowBound[],
    colBounds: readonly ColBound[],
): NearestTargets {
    const rows = rowBounds.map((b) => ({ lo: b.top, hi: b.bottom }));
    const cols = colBounds.map((b) => ({ lo: b.left, hi: b.right }));
    return {
        row: clampIndex(py, rows),
        col: clampIndex(px, cols),
        rowGap: nearestGap(py, rows),
        colGap: nearestGap(px, cols),
    };
}

// Thickness (px) of the grip strips that sit just outside the table edges.
const GRIP = 12;
// Height/width (px) of the generous insert hit zone straddling each gridline.
// Deliberately fat (Google-Docs-like): the whole zone is hoverable, so moving
// the pointer toward the "+" never loses the target — no hide timer needed.
const INSERT_ZONE = 18;
// Pointer travel (px) before a grip press turns from a click into a drag.
const DRAG_THRESHOLD = 6;

// Grace period (ms) after the pointer leaves the wrapper before hidden
// affordances actually fade out — long enough to cross the gutter gap onto a
// grip that renders OUTSIDE the wrapper box. Mirrors the old handles.ts timer.
const NEAR_HIDE_GRACE = 140;

interface DragState {
    kind: "row" | "col";
    /** The grip the gesture started on. */
    fromIdx: number;
    /** First index of the block being moved (== fromIdx for a single line). */
    from0: number;
    /** Last index of the block being moved (inclusive). */
    from1: number;
    tablePos: number;
    startX: number;
    startY: number;
    dragging: boolean;
}

/**
 * Owns everything that is NOT ProseMirror content for a single table: the
 * overlay affordance DOM, the geometry measurement (ResizeObserver + capture
 * scroll listener), the hover/active state, and the drag-to-reorder gesture.
 */
class TableController {
    private node: PMNode;
    private readonly rowGrips: HTMLElement[] = [];
    private readonly colGrips: HTMLElement[] = [];
    private readonly rowInserts: HTMLElement[] = [];
    private readonly colInserts: HTMLElement[] = [];
    private readonly dropLine: HTMLElement;
    private readonly ghost: HTMLElement;

    private cachedWidth = -1;
    private cachedHeight = -1;
    private rafId: number | null = null;
    private readonly resizeObs: ResizeObserver | null = null;
    private drag: DragState | null = null;

    // ── Cached geometry (Task A) ────────────────────────────────────────────
    // reposition() is the ONLY place that reads live layout; it stores these
    // viewport bounds so the pointermove reveal can hit-test with zero rect
    // reads. Coords are in viewport space (clientX/clientY) to match events.
    private rowBounds: RowBound[] = [];
    private colBounds: ColBound[] = [];

    // ── Contextual reveal state ─────────────────────────────────────────────
    private lastRow = -2;
    private lastCol = -2;
    private lastRowGap = -2;
    private lastColGap = -2;
    // The (up to 4) affordances currently carrying `.mw-near`, so reveal changes
    // only touch those elements instead of iterating every grip/insert.
    private nearEls: HTMLElement[] = [];
    private revealRafId: number | null = null;
    private pendingX = 0;
    private pendingY = 0;
    private hideTimer: ReturnType<typeof setTimeout> | null = null;

    // Bound so add/removeEventListener target the same reference.
    private readonly onScroll = () => this.scheduleReposition();
    private readonly onDocMove = (e: MouseEvent) => this.onDragMove(e);
    private readonly onDocUp = (e: MouseEvent) => this.onDragEnd(e);
    private readonly onPointerMove = (e: PointerEvent) => this.onWrapperMove(e);
    private readonly onPointerLeave = () => this.scheduleHideNear();
    private readonly onAffordanceEnter = () => this.cancelHideNear();

    constructor(
        node: PMNode,
        private readonly view: EditorView,
        private readonly getPos: GetPos,
        private readonly wrapper: HTMLElement,
        private readonly table: HTMLElement,
        private readonly tbody: HTMLElement,
        private readonly overlay: HTMLElement,
    ) {
        this.node = node;

        this.dropLine = document.createElement("div");
        this.dropLine.className = "mw-drop-line";
        this.dropLine.style.display = "none";
        this.overlay.appendChild(this.dropLine);

        this.ghost = document.createElement("div");
        this.ghost.className = "mw-drag-ghost";
        this.ghost.style.display = "none";
        this.overlay.appendChild(this.ghost);

        // Re-measure when the table resizes (typing, wrapping, column growth).
        // Guarded: ResizeObserver is absent in some headless test environments.
        if (typeof ResizeObserver === "function") {
            this.resizeObs = new ResizeObserver(() => this.scheduleReposition());
            this.resizeObs.observe(this.table);
        }
        // Capture-phase catches scrolls from ANY ancestor, including the
        // table's own horizontal scroll container (display:block; overflow-x).
        window.addEventListener("scroll", this.onScroll, { capture: true });

        // Contextual reveal: track the pointer over the wrapper (cheap, cached
        // hit-test — no layout reads) and grant a grace period on leave so the
        // pointer can reach grips that live outside the wrapper box.
        this.wrapper.addEventListener("pointermove", this.onPointerMove);
        this.wrapper.addEventListener("pointerleave", this.onPointerLeave);

        this.syncStructure();
    }

    /** Called from NodeView.update when PM hands us a (possibly new) node. */
    setNode(node: PMNode): void {
        this.node = node;
        this.syncStructure();
    }

    private mapDims(): { width: number; height: number } {
        try {
            const map = TableMap.get(this.node);
            return { width: map.width, height: map.height };
        } catch {
            return { width: 0, height: 0 };
        }
    }

    /**
     * Rebuild the affordance elements only when the row/column count actually
     * changed (structural edit); otherwise just re-measure and refresh the
     * active highlight. Keeps per-keystroke updates cheap.
     */
    private syncStructure(): void {
        const { width, height } = this.mapDims();
        if (width !== this.cachedWidth || height !== this.cachedHeight) {
            this.cachedWidth = width;
            this.cachedHeight = height;
            this.rebuild(width, height);
        }
        this.scheduleReposition();
        this.updateActive();
    }

    private rebuild(width: number, height: number): void {
        for (const el of [
            ...this.rowGrips,
            ...this.colGrips,
            ...this.rowInserts,
            ...this.colInserts,
        ]) {
            el.remove();
        }
        this.rowGrips.length = 0;
        this.colGrips.length = 0;
        this.rowInserts.length = 0;
        this.colInserts.length = 0;

        for (let r = 0; r < height; r++) {
            this.rowGrips.push(this.makeGrip("row", r));
        }
        for (let c = 0; c < width; c++) {
            this.colGrips.push(this.makeGrip("col", c));
        }
        // One insert gap before each line and one after the last.
        for (let g = 0; g <= height; g++) {
            this.rowInserts.push(this.makeInsert("row", g));
        }
        for (let g = 0; g <= width; g++) {
            this.colInserts.push(this.makeInsert("col", g));
        }
    }

    private makeGrip(kind: "row" | "col", idx: number): HTMLElement {
        const grip = document.createElement("div");
        grip.className = `mw-grip mw-grip--${kind}`;
        grip.dataset[kind] = String(idx);
        const handle = document.createElement("span");
        handle.className = "mw-grip-handle";
        grip.appendChild(handle);
        applyTooltip(
            grip,
            kind === "row"
                ? t("Click to select row · drag to reorder")
                : t("Click to select column · drag to reorder"),
            { placement: "above" },
        );
        // The header row (index 0) may not be dragged, but it can still be
        // click-selected — the drag path itself guards the header.
        grip.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            hideTooltip();
            this.beginDrag(e, kind, idx);
        });
        // Reaching a grip across the gutter gap keeps the reveal alive.
        grip.addEventListener("pointerenter", this.onAffordanceEnter);
        this.overlay.appendChild(grip);
        return grip;
    }

    private makeInsert(kind: "row" | "col", gap: number): HTMLElement {
        const bar = document.createElement("div");
        bar.className = `mw-insert mw-insert--${kind}`;
        bar.dataset.gap = String(gap);
        const line = document.createElement("div");
        line.className = "mw-insert-line";
        const btn = document.createElement("button");
        btn.className = "mw-insert-btn";
        btn.type = "button";
        btn.innerHTML = IconPlus;
        applyTooltip(
            btn,
            kind === "row" ? t("Insert row") : t("Insert column"),
            { placement: "above" },
        );
        bar.append(line, btn);
        const insert = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            kind === "row"
                ? this.insertRowAtGap(gap)
                : this.insertColAtGap(gap);
        };
        // Fire on mousedown so the button never steals focus from the editor
        // mid-gesture; click is a harmless fallback.
        btn.addEventListener("mousedown", insert);
        // Reaching the "+" across the gutter gap keeps the reveal alive.
        btn.addEventListener("pointerenter", this.onAffordanceEnter);
        this.overlay.appendChild(bar);
        return bar;
    }

    // ── Geometry ────────────────────────────────────────────────────────────

    private rowEls(): HTMLElement[] {
        return Array.from(this.tbody.children).filter(
            (el): el is HTMLElement => el.tagName === "TR",
        );
    }

    private scheduleReposition(): void {
        if (this.rafId !== null) {
            return;
        }
        const raf =
            typeof requestAnimationFrame === "function"
                ? requestAnimationFrame
                : (cb: FrameRequestCallback) =>
                      setTimeout(() => cb(0), 16) as unknown as number;
        this.rafId = raf(() => {
            this.rafId = null;
            this.reposition();
        });
    }

    /**
     * Position every affordance by measuring live cell rects RELATIVE to the
     * wrapper's own rect (never global hit-testing). No-op without layout
     * (jsdom), which is fine — actions never depend on these coordinates.
     *
     * SPIKE — CSS Anchor Positioning (rejected, keep manual measurement):
     * VS Code is Chromium ≥125 so `anchor-name`/`position-anchor` are
     * available, and in principle each grip/insert could anchor to its row/
     * column cell for zero-JS tracking on scroll/resize. It was NOT adopted:
     *  1. The anchor must live on a PM-managed <td>/<th>. Setting `anchor-name`
     *     as an inline style there is a contentDOM mutation that this NodeView's
     *     ignoreMutation() does NOT ignore (tbody.contains(td) === true), so PM
     *     treats it as a content edit and can re-render the cell, dropping the
     *     style. Making PM ignore it would weaken the content/chrome boundary.
     *  2. Injecting generated `tr:nth-child(n){anchor-name:--mw-r-n}` CSS avoids
     *     the DOM mutation but needs a per-table id + a dynamically rebuilt
     *     stylesheet on every structural edit — more moving parts than this one
     *     measurement pass, which is already rAF-throttled and cache-backed.
     *  3. The grips sit in the OUTER gutter at `relLeft - GRIP - 2`; expressing
     *     that offset purely via inset-area/margin against a cell anchor is
     *     fiddlier than the explicit arithmetic here, with no accuracy win.
     * Task A's pointermove reveal needs cached bounds for its hit-test anyway,
     * so this pass earns its keep regardless.
     */
    private reposition(): void {
        const rows = this.rowEls();
        if (!rows.length) {
            return;
        }
        const wrap = this.wrapper.getBoundingClientRect();
        const tableRect = this.table.getBoundingClientRect();
        const relTop = tableRect.top - wrap.top;
        const relLeft = tableRect.left - wrap.left;
        const firstCells = Array.from(rows[0]!.children) as HTMLElement[];

        // Cache viewport bounds for the pointermove reveal hit-test (Task A).
        // This is the single place that reads layout for the whole controller.
        this.rowBounds = rows.map((r) => {
            const b = r.getBoundingClientRect();
            return { top: b.top, bottom: b.bottom };
        });
        this.colBounds = firstCells.map((c) => {
            const b = c.getBoundingClientRect();
            return { left: b.left, right: b.right };
        });

        this.rowGrips.forEach((g, r) => {
            const rr = rows[r]?.getBoundingClientRect();
            if (!rr) {
                return;
            }
            g.style.top = `${rr.top - wrap.top}px`;
            g.style.height = `${rr.height}px`;
            g.style.left = `${relLeft - GRIP - 2}px`;
            g.style.width = `${GRIP}px`;
        });

        this.colGrips.forEach((g, c) => {
            const cc = firstCells[c]?.getBoundingClientRect();
            if (!cc) {
                return;
            }
            g.style.left = `${cc.left - wrap.left}px`;
            g.style.width = `${cc.width}px`;
            g.style.top = `${relTop - GRIP - 2}px`;
            g.style.height = `${GRIP}px`;
        });

        this.rowInserts.forEach((bar, g) => {
            const y =
                g < rows.length
                    ? rows[g]!.getBoundingClientRect().top - wrap.top
                    : rows[rows.length - 1]!.getBoundingClientRect().bottom -
                      wrap.top;
            bar.style.top = `${y - INSERT_ZONE / 2}px`;
            bar.style.left = `${relLeft}px`;
            bar.style.width = `${tableRect.width}px`;
            bar.style.height = `${INSERT_ZONE}px`;
        });

        this.colInserts.forEach((bar, g) => {
            const x =
                g < firstCells.length
                    ? firstCells[g]!.getBoundingClientRect().left - wrap.left
                    : firstCells[firstCells.length - 1]!.getBoundingClientRect()
                          .right - wrap.left;
            bar.style.left = `${x - INSERT_ZONE / 2}px`;
            bar.style.top = `${relTop}px`;
            bar.style.height = `${tableRect.height}px`;
            bar.style.width = `${INSERT_ZONE}px`;
        });

        // Folded `…` chip: every other kind seats the chip on the collapsed
        // block's visible line, so the table's must read as part of the
        // header row — just past its right edge, vertically centered on it
        // (table.css absolutely positions it; this is the one layout
        // reader). Collapsing hides the body rows, which resizes the table
        // and re-runs this pass, so the measurement is always fresh.
        if (this.wrapper.classList.contains("collapsed")) {
            const chip = this.wrapper.querySelector<HTMLElement>(
                ":scope > .mw-table-fold-ellipsis",
            );
            const header = rows[0]!.getBoundingClientRect();
            if (chip && header.height > 0) {
                // Clamp to the wrapper: a header wider than the editor would
                // otherwise push the chip out of view.
                const right = Math.min(header.right, wrap.right);
                chip.style.left = `${right - wrap.left + 8}px`;
                chip.style.top = `${header.top - wrap.top + header.height / 2}px`;
            }
        }
    }

    // ── Contextual reveal (Task A) ──────────────────────────────────────────

    /**
     * Wrapper pointermove: reveal only the affordances nearest the pointer.
     * Uses ONLY cached bounds (no getBoundingClientRect here); rAF-coalesced so
     * at most one hit-test + class write happens per frame, and that write is
     * skipped entirely when the nearest indices are unchanged.
     */
    private onWrapperMove(e: PointerEvent): void {
        this.cancelHideNear();
        if (this.drag) {
            return; // no reveal churn mid-reorder (Task B)
        }
        this.pendingX = e.clientX;
        this.pendingY = e.clientY;
        if (this.revealRafId !== null) {
            return;
        }
        const raf =
            typeof requestAnimationFrame === "function"
                ? requestAnimationFrame
                : (cb: FrameRequestCallback) =>
                      setTimeout(() => cb(0), 16) as unknown as number;
        this.revealRafId = raf(() => {
            this.revealRafId = null;
            this.applyReveal(this.pendingX, this.pendingY);
        });
    }

    private applyReveal(px: number, py: number): void {
        const near = nearestTargets(px, py, this.rowBounds, this.colBounds);
        // Early-out: only touch the DOM when the nearest set actually changes.
        if (
            near.row === this.lastRow &&
            near.col === this.lastCol &&
            near.rowGap === this.lastRowGap &&
            near.colGap === this.lastColGap
        ) {
            return;
        }
        this.lastRow = near.row;
        this.lastCol = near.col;
        this.lastRowGap = near.rowGap;
        this.lastColGap = near.colGap;
        // Surgical: unset only the previously-near elements, then set the new 4.
        for (const el of this.nearEls) {
            el.classList.remove("mw-near");
        }
        this.nearEls = [
            this.rowGrips[near.row],
            this.colGrips[near.col],
            this.rowInserts[near.rowGap],
            this.colInserts[near.colGap],
        ].filter((el): el is HTMLElement => el != null);
        for (const el of this.nearEls) {
            el.classList.add("mw-near");
        }
    }

    /** Hide all revealed affordances AND reset the early-out state, so the next
     *  pointer move re-reveals even over the same row/column (e.g. after a drag
     *  or the grace-timeout — where a plain class clear would leave the early-out
     *  believing nothing changed). */
    private hideNear(): void {
        for (const el of this.nearEls) {
            el.classList.remove("mw-near");
        }
        this.nearEls = [];
        this.lastRow = this.lastCol = this.lastRowGap = this.lastColGap = -2;
    }

    private scheduleHideNear(): void {
        if (this.hideTimer) {
            return;
        }
        this.hideTimer = setTimeout(() => {
            this.hideTimer = null;
            this.hideNear();
        }, NEAR_HIDE_GRACE);
    }

    private cancelHideNear(): void {
        if (this.hideTimer) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
    }

    // ── Active (selected) highlight ─────────────────────────────────────────

    private updateActive(): void {
        for (const g of this.rowGrips) {
            g.classList.remove("mw-grip--active");
        }
        for (const g of this.colGrips) {
            g.classList.remove("mw-grip--active");
        }
        const sel = this.view.state.selection;
        if (!(sel instanceof CellSelection)) {
            return;
        }
        const pos = this.getPos();
        if (pos == null) {
            return;
        }
        // Only react to a selection inside THIS table.
        const anchor = sel.$anchorCell.pos;
        if (anchor < pos || anchor > pos + this.node.nodeSize) {
            return;
        }
        try {
            const rect = selectedRect(this.view.state);
            if (sel.isRowSelection()) {
                for (let r = rect.top; r < rect.bottom; r++) {
                    this.rowGrips[r]?.classList.add("mw-grip--active");
                }
            }
            if (sel.isColSelection()) {
                for (let c = rect.left; c < rect.right; c++) {
                    this.colGrips[c]?.classList.add("mw-grip--active");
                }
            }
        } catch {
            /* selection not resolvable in this table — ignore */
        }
    }

    // ── Selection commands (index-based, layout-independent) ────────────────

    private liveTable(): { node: PMNode; pos: number } | null {
        const pos = this.getPos();
        if (pos == null) {
            return null;
        }
        // An inbound external sync can change the doc between gesture start and
        // dispatch; re-verify the node is still a table before touching it.
        const node = this.view.state.doc.nodeAt(pos);
        if (!node || node.type.name !== "table") {
            return null;
        }
        return { node, pos };
    }

    /** Select rows [top..bottom] inclusive (single row when top === bottom). */
    private selectRowRange(top: number, bottom: number): void {
        const live = this.liveTable();
        if (!live) {
            return;
        }
        try {
            const map = TableMap.get(live.node);
            const start = live.pos + 1;
            const $anchor = this.view.state.doc.resolve(
                start + map.positionAt(top, 0, live.node),
            );
            const $head = this.view.state.doc.resolve(
                start + map.positionAt(bottom, map.width - 1, live.node),
            );
            this.view.dispatch(
                this.view.state.tr.setSelection(
                    new CellSelection($anchor, $head),
                ),
            );
            this.view.focus();
        } catch {
            /* ignore */
        }
    }

    /** Select columns [left..right] inclusive (single column when equal). */
    private selectColRange(left: number, right: number): void {
        const live = this.liveTable();
        if (!live) {
            return;
        }
        try {
            const map = TableMap.get(live.node);
            const start = live.pos + 1;
            const $anchor = this.view.state.doc.resolve(
                start + map.positionAt(0, left, live.node),
            );
            const $head = this.view.state.doc.resolve(
                start + map.positionAt(map.height - 1, right, live.node),
            );
            this.view.dispatch(
                this.view.state.tr.setSelection(
                    new CellSelection($anchor, $head),
                ),
            );
            this.view.focus();
        } catch {
            /* ignore */
        }
    }

    /** Put the text cursor inside the cell at (row, col) of the live table. */
    private cursorInCell(row: number, col: number): boolean {
        const live = this.liveTable();
        if (!live) {
            return false;
        }
        try {
            const map = TableMap.get(live.node);
            const start = live.pos + 1;
            const cellPos = start + map.positionAt(row, col, live.node);
            const $pos = this.view.state.doc.resolve(
                Math.min(cellPos + 1, this.view.state.doc.content.size),
            );
            this.view.dispatch(
                this.view.state.tr.setSelection(TextSelection.near($pos)),
            );
            return true;
        } catch {
            return false;
        }
    }

    private insertRowAtGap(gap: number): void {
        const live = this.liveTable();
        if (!live) {
            return;
        }
        const height = TableMap.get(live.node).height;
        if (gap >= height) {
            if (!this.cursorInCell(height - 1, 0)) {
                return;
            }
            addRowAfter(this.view.state, this.view.dispatch);
        } else {
            if (!this.cursorInCell(gap, 0)) {
                return;
            }
            addRowBefore(this.view.state, this.view.dispatch);
        }
        this.view.focus();
    }

    private insertColAtGap(gap: number): void {
        const live = this.liveTable();
        if (!live) {
            return;
        }
        const width = TableMap.get(live.node).width;
        if (gap >= width) {
            if (!this.cursorInCell(0, width - 1)) {
                return;
            }
            addColumnAfter(this.view.state, this.view.dispatch);
        } else {
            if (!this.cursorInCell(0, gap)) {
                return;
            }
            addColumnBefore(this.view.state, this.view.dispatch);
        }
        this.view.focus();
    }

    // ── Drag-to-reorder ─────────────────────────────────────────────────────

    private beginDrag(e: MouseEvent, kind: "row" | "col", fromIdx: number): void {
        const pos = this.getPos();
        if (pos == null) {
            return;
        }
        // If the grip lies inside the current CellSelection block, drag the
        // whole contiguous selection; otherwise drag just this one line.
        let from0 = fromIdx;
        let from1 = fromIdx;
        const range = this.selectedBlock(pos);
        if (range) {
            if (
                kind === "row" &&
                range.kind === "row" &&
                fromIdx >= range.from0 &&
                fromIdx <= range.from1
            ) {
                from0 = range.from0;
                from1 = range.from1;
            } else if (
                kind === "col" &&
                range.kind === "col" &&
                fromIdx >= range.from0 &&
                fromIdx <= range.from1
            ) {
                from0 = range.from0;
                from1 = range.from1;
            }
        }
        this.drag = {
            kind,
            fromIdx,
            from0,
            from1,
            tablePos: pos,
            startX: e.clientX,
            startY: e.clientY,
            dragging: false,
        };
        document.addEventListener("mousemove", this.onDocMove);
        document.addEventListener("mouseup", this.onDocUp);
    }

    /**
     * If a row- or column-CellSelection is active INSIDE this table, return its
     * contiguous index range; otherwise null. Used to decide whether a grip
     * drag moves the whole selection or just one line.
     */
    private selectedBlock(
        pos: number,
    ): { kind: "row" | "col"; from0: number; from1: number } | null {
        const sel = this.view.state.selection;
        if (!(sel instanceof CellSelection)) {
            return null;
        }
        const anchor = sel.$anchorCell.pos;
        if (anchor < pos || anchor > pos + this.node.nodeSize) {
            return null; // selection is in a different table
        }
        try {
            const rect = selectedRect(this.view.state);
            if (sel.isRowSelection()) {
                return { kind: "row", from0: rect.top, from1: rect.bottom - 1 };
            }
            if (sel.isColSelection()) {
                return { kind: "col", from0: rect.left, from1: rect.right - 1 };
            }
        } catch {
            /* not resolvable — ignore */
        }
        return null;
    }

    private onDragMove(e: MouseEvent): void {
        const d = this.drag;
        if (!d) {
            return;
        }
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (!d.dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
            // Header row cannot be reordered — do not begin a row drag from a
            // block that includes it.
            if (d.kind === "row" && d.from0 === 0) {
                return;
            }
            d.dragging = true;
            // Suppress any lingering tooltip and lock out insert/grip tooltips
            // for the duration of the reorder (Task B).
            hideTooltip();
            this.hideNear();
            this.wrapper.classList.add("mw-table--dragging");
            this.markDraggedGrips(d, true);
            this.showGhost(d);
        }
        if (!d.dragging) {
            return;
        }
        this.updateDropIndicator(e, d);
    }

    private onDragEnd(e: MouseEvent): void {
        document.removeEventListener("mousemove", this.onDocMove);
        document.removeEventListener("mouseup", this.onDocUp);
        const d = this.drag;
        this.drag = null;
        this.dropLine.style.display = "none";
        this.ghost.style.display = "none";
        this.wrapper.classList.remove("mw-table--dragging");
        if (d) {
            this.markDraggedGrips(d, false);
        }
        if (!d) {
            return;
        }

        if (!d.dragging) {
            // A press without travel is a click → select the whole row/column.
            d.kind === "row"
                ? this.selectRowRange(d.fromIdx, d.fromIdx)
                : this.selectColRange(d.fromIdx, d.fromIdx);
            return;
        }

        const target = this.findTarget(e, d);
        if (target < 0 || target === d.from0) {
            return; // dropped back onto itself
        }
        const live = this.liveTable();
        if (!live || live.pos !== d.tablePos) {
            return;
        }
        const span = d.from1 - d.from0; // 0 for a single line
        if (d.kind === "row") {
            if (d.from0 === 0 || target === 0) {
                return; // header stays first
            }
            const newTable = reorderRowRange(
                live.node,
                d.from0,
                d.from1,
                target,
            );
            // Conservation by construction (reorder rebuilds the table from
            // the same node objects) — tagged anyway so the content guard
            // (MAR-108) covers this mover for free.
            const docBefore = this.view.state.doc;
            this.view.dispatch(
                tagContentGuard(
                    this.view.state.tr.replaceWith(
                        live.pos,
                        live.pos + live.node.nodeSize,
                        newTable,
                    ),
                    { kind: "move" },
                ),
            );
            if (this.view.state.doc === docBefore) {
                // Guard veto — dispatch returns nothing, so this doc-identity
                // check (the moveBlocks pattern) is how we learn the reorder
                // never applied; the selection would describe the
                // never-created table.
                return;
            }
            this.selectRowRange(target, target + span);
        } else {
            const newTable = reorderColumnRange(
                live.node,
                d.from0,
                d.from1,
                target,
            );
            const docBefore = this.view.state.doc;
            this.view.dispatch(
                tagContentGuard(
                    this.view.state.tr.replaceWith(
                        live.pos,
                        live.pos + live.node.nodeSize,
                        newTable,
                    ),
                    { kind: "move" },
                ),
            );
            if (this.view.state.doc === docBefore) {
                return; // guard veto — see the row branch above
            }
            this.selectColRange(target, target + span);
        }
    }

    /** Add/remove the `.mw-grip--dragging` marker on every grip in the block. */
    private markDraggedGrips(d: DragState, on: boolean): void {
        const grips = d.kind === "row" ? this.rowGrips : this.colGrips;
        for (let i = d.from0; i <= d.from1; i++) {
            grips[i]?.classList.toggle("mw-grip--dragging", on);
        }
    }

    /** Destination index (post-splice) under the pointer, or -1. */
    private findTarget(e: MouseEvent, d: DragState): number {
        const rows = this.rowEls();
        if (d.kind === "row") {
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i]!.getBoundingClientRect();
                if (e.clientY >= r.top && e.clientY <= r.bottom) {
                    const before = e.clientY < r.top + r.height / 2;
                    return resolveDropIndexRange(d.from0, d.from1, i, before);
                }
            }
            if (rows.length && e.clientY > rows[rows.length - 1]!.getBoundingClientRect().bottom) {
                return resolveDropIndexRange(d.from0, d.from1, rows.length - 1, false);
            }
            return -1;
        }
        const cells = Array.from(rows[0]?.children ?? []) as HTMLElement[];
        for (let i = 0; i < cells.length; i++) {
            const c = cells[i]!.getBoundingClientRect();
            if (e.clientX >= c.left && e.clientX <= c.right) {
                const before = e.clientX < c.left + c.width / 2;
                return resolveDropIndexRange(d.from0, d.from1, i, before);
            }
        }
        if (cells.length && e.clientX > cells[cells.length - 1]!.getBoundingClientRect().right) {
            return resolveDropIndexRange(d.from0, d.from1, cells.length - 1, false);
        }
        if (cells.length && e.clientX < cells[0]!.getBoundingClientRect().left) {
            return resolveDropIndexRange(d.from0, d.from1, 0, true);
        }
        return -1;
    }

    private showGhost(d: DragState): void {
        const rows = this.rowEls();
        const wrap = this.wrapper.getBoundingClientRect();
        if (d.kind === "row") {
            // Span every row in the dragged block.
            const first = rows[d.from0];
            const last = rows[d.from1];
            if (!first || !last) {
                return;
            }
            const fr = first.getBoundingClientRect();
            const lr = last.getBoundingClientRect();
            this.ghost.style.left = `${fr.left - wrap.left}px`;
            this.ghost.style.top = `${fr.top - wrap.top}px`;
            this.ghost.style.width = `${fr.width}px`;
            this.ghost.style.height = `${lr.bottom - fr.top}px`;
        } else {
            // Span every column in the block across the full table height.
            const topLeft = rows[0]?.children[d.from0] as HTMLElement | undefined;
            const topRight = rows[0]?.children[d.from1] as HTMLElement | undefined;
            const bottomLeft = rows[rows.length - 1]?.children[d.from0] as
                | HTMLElement
                | undefined;
            if (!topLeft || !topRight || !bottomLeft) {
                return;
            }
            const tl = topLeft.getBoundingClientRect();
            const tr = topRight.getBoundingClientRect();
            const bl = bottomLeft.getBoundingClientRect();
            this.ghost.style.left = `${tl.left - wrap.left}px`;
            this.ghost.style.top = `${tl.top - wrap.top}px`;
            this.ghost.style.width = `${tr.right - tl.left}px`;
            this.ghost.style.height = `${bl.bottom - tl.top}px`;
        }
        this.ghost.style.display = "block";
    }

    private updateDropIndicator(e: MouseEvent, d: DragState): void {
        const rows = this.rowEls();
        const wrap = this.wrapper.getBoundingClientRect();
        const tableRect = this.table.getBoundingClientRect();
        if (d.kind === "row") {
            const y = this.rowDropEdge(e.clientY, rows);
            if (y === null) {
                this.dropLine.style.display = "none";
                return;
            }
            this.dropLine.className = "mw-drop-line mw-drop-line--h";
            this.dropLine.style.left = `${tableRect.left - wrap.left}px`;
            this.dropLine.style.width = `${tableRect.width}px`;
            this.dropLine.style.top = `${y - wrap.top - 1}px`;
            this.dropLine.style.height = "";
            this.dropLine.style.display = "block";
            return;
        }
        const cells = Array.from(rows[0]?.children ?? []) as HTMLElement[];
        const x = this.colDropEdge(e.clientX, cells);
        if (x === null) {
            this.dropLine.style.display = "none";
            return;
        }
        this.dropLine.className = "mw-drop-line mw-drop-line--v";
        this.dropLine.style.top = `${tableRect.top - wrap.top}px`;
        this.dropLine.style.height = `${tableRect.height}px`;
        this.dropLine.style.left = `${x - wrap.left - 1}px`;
        this.dropLine.style.width = "";
        this.dropLine.style.display = "block";
    }

    /**
     * Viewport Y of the row drop line for the pointer, or null if there is no
     * valid drop. Mirrors findTarget's fallbacks so the indicator is shown at
     * exactly the positions a release would act on: inside a row -> its nearer
     * edge; below the last row -> the last row's bottom (append). The header
     * row is not a target, so there is no "above the first row" case.
     */
    private rowDropEdge(clientY: number, rows: HTMLElement[]): number | null {
        for (const row of rows) {
            const r = row.getBoundingClientRect();
            if (clientY >= r.top && clientY <= r.bottom) {
                return clientY < r.top + r.height / 2 ? r.top : r.bottom;
            }
        }
        if (rows.length && clientY > rows[rows.length - 1]!.getBoundingClientRect().bottom) {
            return rows[rows.length - 1]!.getBoundingClientRect().bottom;
        }
        return null;
    }

    /**
     * Viewport X of the column drop line for the pointer, or null. Mirrors
     * findTarget: inside a cell -> its nearer edge; past the last cell -> its
     * right (append); before the first cell -> its left (prepend).
     */
    private colDropEdge(clientX: number, cells: HTMLElement[]): number | null {
        for (const cell of cells) {
            const c = cell.getBoundingClientRect();
            if (clientX >= c.left && clientX <= c.right) {
                return clientX < c.left + c.width / 2 ? c.left : c.right;
            }
        }
        if (cells.length && clientX > cells[cells.length - 1]!.getBoundingClientRect().right) {
            return cells[cells.length - 1]!.getBoundingClientRect().right;
        }
        if (cells.length && clientX < cells[0]!.getBoundingClientRect().left) {
            return cells[0]!.getBoundingClientRect().left;
        }
        return null;
    }

    destroy(): void {
        this.resizeObs?.disconnect();
        window.removeEventListener("scroll", this.onScroll, { capture: true });
        this.wrapper.removeEventListener("pointermove", this.onPointerMove);
        this.wrapper.removeEventListener("pointerleave", this.onPointerLeave);
        document.removeEventListener("mousemove", this.onDocMove);
        document.removeEventListener("mouseup", this.onDocUp);
        this.cancelHideNear();
        if (typeof cancelAnimationFrame === "function") {
            if (this.rafId !== null) {
                cancelAnimationFrame(this.rafId);
            }
            if (this.revealRafId !== null) {
                cancelAnimationFrame(this.revealRafId);
            }
        }
    }
}

/**
 * NodeView factory registered as `["table", createTableView]` in editor.ts.
 * The contentDOM is the <tbody>, so ProseMirror renders rows into it and
 * editing/serialization are untouched.
 */
export function createTableView(
    node: PMNode,
    view: EditorView,
    getPos: GetPos,
): NodeView {
    const wrapper = document.createElement("div");
    wrapper.className = "mw-table";

    const table = document.createElement("table");
    const tbody = document.createElement("tbody");
    table.appendChild(tbody);

    const overlay = document.createElement("div");
    overlay.className = "mw-table-overlay";

    // Collapsed `…` (MAR-125): the shared fold-ellipsis mounted in the
    // wrapper, shown only while the fold plugin's decoration marks the
    // table `collapsed` (the callout-NodeView protocol — fold state arrives
    // as a class, this view only renders the chip and dispatches the meta).
    const foldEllipsis = createFoldEllipsis(
        Math.max(0, node.childCount - 1),
        () => {
            const pos = getPos();
            if (pos === undefined) return;
            view.dispatch(
                view.state.tr
                    .setMeta(foldPluginKey, { type: "set", pos, folded: false } satisfies FoldMeta)
                    .setMeta("addToHistory", false),
            );
            view.focus();
        },
        "rows",
    );
    foldEllipsis.dom.classList.add("mw-table-fold-ellipsis");

    wrapper.append(table, overlay, foldEllipsis.dom);

    const controller = new TableController(
        node,
        view,
        getPos,
        wrapper,
        table,
        tbody,
        overlay,
    );

    return {
        dom: wrapper,
        contentDOM: tbody,

        update(newNode: PMNode): boolean {
            if (newNode.type !== node.type) {
                return false;
            }
            node = newNode;
            controller.setNode(newNode);
            foldEllipsis.setCount(Math.max(0, newNode.childCount - 1));
            return true;
        },

        // Overlay changes must never be read as content edits; contentDOM
        // (tbody) mutations and selection always pass through to ProseMirror.
        ignoreMutation(m: MutationRecord | { type: "selection" }): boolean {
            if (m.type === "selection") {
                return false;
            }
            const target = (m as MutationRecord).target as Node;
            return !tbody.contains(target);
        },

        // Keep ProseMirror out of interactions that originate in the overlay
        // (or the fold chip — chrome, never content).
        stopEvent(e: Event): boolean {
            return (
                overlay.contains(e.target as Node) ||
                foldEllipsis.dom.contains(e.target as Node)
            );
        },

        destroy(): void {
            controller.destroy();
        },
    };
}
