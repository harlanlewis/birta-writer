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
 *
 * The session machinery is source-agnostic (startPointerDragSession) — the
 * gutter marker is one DragSessionSource; other handles (e.g. TOC items)
 * supply their own. Registered DropZoneProviders (the TOC panel) take over
 * targeting while the pointer is inside them; the commit path stays the one
 * moveBlocks call regardless of zone.
 */
import type { EditorView } from "@milkdown/prose/view";
import type { EditorState } from "@milkdown/prose/state";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { closeBlockMenu, moveRangeAt } from "./index";
import { moveBlocks } from "../../editing/moveBlocks";
import { BlockRangeSelection } from "../../plugins/blockRange";
import {
    foldedHiddenRanges,
    foldedSectionEnds,
    hiddenRangeCoversTarget,
    isContainerNode,
    isListNode,
} from "../../plugins/headingFold";
import { selectInto } from "./turnInto";
import { hideRangeVeil, showRangeVeil } from "./rangeIndicator";
import { hideTooltip } from "../../ui/tooltip";
import { scrollElementBelowTopbar } from "../../utils/headingUtils";
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
): { pos: number; kind: "block" | "item"; ownerPos?: number }[] {
    const positions: { pos: number; kind: "block" | "item"; ownerPos?: number }[] = [];
    const walkList = (list: ProseNode, listPos: number): void => {
        let lastEnd = listPos + 1;
        list.forEach((item: ProseNode, offset: number) => {
            const itemPos = listPos + 1 + offset;
            positions.push({ pos: itemPos, kind: "item", ownerPos: listPos });
            lastEnd = itemPos + item.nodeSize;
            item.forEach((child: ProseNode, childOffset: number) => {
                if (isListNode(child)) {
                    walkList(child, itemPos + 1 + childOffset);
                }
            });
        });
        // End-of-list slot; carries its OWNING list so geometry is measured
        // per list, not from whatever item happened to be walked last (a
        // nested last item would otherwise shadow the outer list's slot).
        positions.push({ pos: lastEnd, kind: "item", ownerPos: listPos });
    };
    // Containers (blockquote/callout/directive/aside — all `block+`): every
    // slot between their children takes a BLOCK, so nested blocks can be
    // reordered in place, dragged out, and top-level blocks dropped in.
    const walkContainer = (container: ProseNode, containerPos: number): void => {
        let lastEnd = containerPos + 1;
        container.forEach((child: ProseNode, offset: number) => {
            const childPos = containerPos + 1 + offset;
            positions.push({ pos: childPos, kind: "block", ownerPos: containerPos });
            lastEnd = childPos + child.nodeSize;
            if (isListNode(child)) {
                walkList(child, childPos);
            } else if (isContainerNode(child)) {
                walkContainer(child, childPos);
            }
        });
        positions.push({ pos: lastEnd, kind: "block", ownerPos: containerPos });
    };
    doc.forEach((node: ProseNode, offset: number) => {
        positions.push({ pos: offset, kind: "block" });
        if (isListNode(node)) {
            walkList(node, offset);
        } else if (isContainerNode(node)) {
            walkContainer(node, offset);
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
        return expandCoverOverFolds(view.state, { from: sel.from, to: sel.to });
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
    return blocks > 1 ? expandCoverOverFolds(view.state, { from, to }) : null;
}

/**
 * A cover that includes a COLLAPSED heading must also carry its hidden
 * section — the fold decoration hides those sibling blocks, but they are
 * real content: moving the heading without them would strand invisible
 * blocks under a new owner (and the fold would swallow whatever happens to
 * follow the drop). Offsets ascend, so growing `to` mid-walk is safe.
 */
function expandCoverOverFolds(
    state: EditorState,
    range: { from: number; to: number },
): { from: number; to: number } {
    const sectionEnds = foldedSectionEnds(state); // one doc pass, not one per fold
    if (sectionEnds.size === 0) {
        return range;
    }
    let to = range.to;
    for (const [pos, end] of sectionEnds) {
        if (pos >= range.from && pos < to && end > to) {
            to = end;
        }
    }
    return to === range.to ? range : { from: range.from, to };
}

/** Pixels of pointer travel before a mousedown becomes a drag. */
const DRAG_THRESHOLD = 4;
/** Viewport margin (px) inside which the window auto-scrolls. The marquee
 * shares the whole ramp via scrollVelocityFor below, not this constant. */
const SCROLL_ZONE = 80;
/** Auto-scroll speed range (px per frame). */
const SCROLL_MIN = 2;
const SCROLL_MAX = 40;
/** How far past the viewport edge keeps accelerating (as a zone multiple). */
const SCROLL_OVERSHOOT = 1.5;

/**
 * The quadratic edge-scroll ramp, shared by every scrollable drop zone (the
 * document viewport here; a DropZoneProvider's own scroller reuses the same
 * curve so all zones feel identical): zero outside the zone, SCROLL_MIN just
 * inside it, brisk at the edge, and still accelerating up to SCROLL_MAX as
 * `depthIntoZone` overshoots past the edge (the dnd-kit/Figma convention:
 * distance is the throttle, so 1px into the zone never sprints).
 */
export function edgeScrollVelocity(depthIntoZone: number, zone: number): number {
    if (zone <= 0 || depthIntoZone <= 0) {
        return 0;
    }
    const t = Math.min(depthIntoZone / zone, SCROLL_OVERSHOOT) / SCROLL_OVERSHOOT;
    return SCROLL_MIN + (SCROLL_MAX - SCROLL_MIN) * t * t;
}

/**
 * Signed auto-scroll velocity (px per frame) for a pointer at `clientY`:
 * the edgeScrollVelocity ramp applied to the viewport's top/bottom edge
 * zones. Shared by the drag and marquee sessions.
 */
export function scrollVelocityFor(clientY: number): number {
    // Clamp the zones on short viewports so a dead band always exists in
    // the middle — otherwise every pointer position would auto-scroll.
    const zone = Math.min(SCROLL_ZONE, Math.floor(window.innerHeight / 3));
    const topDepth = zone - clientY;
    const bottomDepth = clientY - (window.innerHeight - zone);
    const speed = edgeScrollVelocity(Math.max(topDepth, bottomDepth), zone);
    if (speed === 0) {
        return 0;
    }
    return topDepth > bottomDepth ? -speed : speed;
}

/**
 * blockBoundaryPositions minus every slot hidden inside a collapsed
 * section: those blocks are display:none, so their rects measure at y=0 —
 * a drag toward the viewport top would silently commit the drop into the
 * hidden range and the dragged block would vanish mid-fold. The boundary
 * AT a heading section's end (the first visible slot after the unit)
 * survives; a collapsed callout's end-of-body slot does not (both per
 * hiddenRangeCoversTarget — the SAME legality registry moveBlocks enforces,
 * so the slots the UI offers and the targets the primitive accepts cannot
 * drift). Exported for unit testing.
 */
export function visibleBoundaryPositions(
    state: EditorState,
): { pos: number; kind: "block" | "item"; ownerPos?: number }[] {
    // One fold-range map for every fold kind (MAR-110): heading sections
    // AND collapsed callout bodies — a drop must never land in either.
    const hidden = foldedHiddenRanges(state);
    const positions = blockBoundaryPositions(state.doc);
    if (hidden.length === 0) {
        return positions;
    }
    return positions.filter(
        ({ pos }) => !hidden.some((r) => hiddenRangeCoversTarget(state.doc, r, pos)),
    );
}

/** True when `el` sits inside a collapsed callout's hidden body. The
 * state-based filter in visibleBoundaryPositions excludes every fold-hidden
 * slot (callout end-of-body included, via hiddenRangeCoversTarget); this DOM
 * check stays as the residual defense for hidden GEOMETRY the fold state
 * can't see — a slot whose measuring DOM sits display:none/height:0 by any
 * other mechanism must never win the nearest-y drop contest, or a
 * bottom-edge drop would commit into it and the dragged block would
 * vanish. */
function inCollapsedCalloutBody(el: Element): boolean {
    return el.closest(".callout.collapsed .callout-body") !== null;
}

/** Current viewport geometry of every droppable boundary
 * (visibleBoundaryPositions supplies positions/kinds; the DOM supplies ys —
 * item slots also carry their column's left/width for the indented line). */
function measureBoundaries(view: EditorView): DropBoundary[] {
    const { doc } = view.state;
    const boundaries: DropBoundary[] = [];
    let lastBlockBottom: number | null = null;
    for (const { pos, kind, ownerPos } of visibleBoundaryPositions(view.state)) {
        if (kind === "block" && pos === doc.content.size) {
            if (lastBlockBottom !== null) {
                boundaries.push({ pos, y: lastBlockBottom, kind });
            }
            continue;
        }
        const dom = view.nodeDOM(pos);
        if (dom instanceof HTMLElement) {
            if (inCollapsedCalloutBody(dom)) {
                continue;
            }
            const rect = dom.getBoundingClientRect();
            if (rect.height === 0 && rect.width === 0) {
                continue; // display:none by any mechanism — not a visible target
            }
            if (ownerPos !== undefined) {
                // Owned slots (list items, container children) indent the
                // indicator to their own column.
                boundaries.push({ pos, y: rect.top, kind, left: rect.left, width: rect.width });
            } else {
                boundaries.push({ pos, y: rect.top, kind });
                lastBlockBottom = rect.bottom;
            }
        } else if (ownerPos !== undefined) {
            // End-of-owner slot: the OWNING node's bottom edge, at its own
            // children's column (its last DIRECT child supplies the indent —
            // deriving from the last WALKED node let a nested list's column
            // shadow the outer slot's geometry entirely).
            const ownerDom = view.nodeDOM(ownerPos);
            const ownerNode = doc.nodeAt(ownerPos);
            // A collapsed callout's own end slot sits inside its hidden
            // body; an owner buried in a collapsed ancestor is hidden too.
            if (
                ownerDom instanceof HTMLElement &&
                (ownerDom.matches(".callout.collapsed") || inCollapsedCalloutBody(ownerDom))
            ) {
                continue;
            }
            if (ownerDom instanceof HTMLElement && ownerNode && ownerNode.childCount > 0) {
                let lastChildOffset = 0;
                ownerNode.forEach((_child: ProseNode, childOffset: number) => {
                    lastChildOffset = childOffset;
                });
                const lastChildDom = view.nodeDOM(ownerPos + 1 + lastChildOffset);
                const column = lastChildDom instanceof HTMLElement
                    ? lastChildDom.getBoundingClientRect()
                    : ownerDom.getBoundingClientRect();
                boundaries.push({
                    pos,
                    y: ownerDom.getBoundingClientRect().bottom,
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
    }
    if (!indicatorEl.isConnected) {
        // (Re)mount on use: the singleton lives for the module's lifetime,
        // but a host teardown (tests resetting document.body) detaches it.
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
    return blocks > 1 ? `${blocks} ${t("blocks")}` : name;
}

/**
 * The singleton drop-indicator line, exported so ANY drop zone (the document
 * path here, a DropZoneProvider like the TOC panel) draws the same one line.
 * `y` is the boundary line the indicator marks; the element sits at y − 1 so
 * the 2px line centers on it.
 */
export function showDropIndicatorAt(rect: { left: number; width: number; y: number }): void {
    const el = indicator();
    el.style.left = `${rect.left}px`;
    el.style.width = `${rect.width}px`;
    el.style.top = `${rect.y - 1}px`;
    el.style.display = "block";
}

export function hideDropIndicator(): void {
    if (indicatorEl) {
        indicatorEl.style.display = "none";
    }
}

function showIndicator(view: EditorView, target: DropBoundary): void {
    // Item slots indent the line to the target column (nesting depth is
    // visible at a glance); block slots span the editor.
    const editorRect = view.dom.getBoundingClientRect();
    showDropIndicatorAt({
        left: target.left ?? editorRect.left,
        width: target.width ?? editorRect.width,
        y: target.y,
    });
}

// ── Drop-zone providers ─────────────────────────────────────────────────────
// Auxiliary drop zones (e.g. the TOC panel) that a drag session hands
// targeting to while the pointer is inside them. A provider renders its own
// chrome and owns its own scrolling, but the session keeps the commit path —
// the same moveBlocks call as the document path — so a zone can never invent
// drop semantics the primitive doesn't enforce.

export interface DropZoneProvider {
    /** Whether the viewport point sits inside this zone. With multiple
     * providers registered, the FIRST one (in registration order) whose
     * `contains` hits takes the pointer — zones must not overlap, or
     * registration order silently decides the winner. */
    contains(x: number, y: number): boolean;
    /** A drag session started: the dragged unit, for slot precomputation. */
    sessionStart(view: EditorView, range: { from: number; to: number }, kind: "block" | "item"): void;
    /**
     * Renders the provider's OWN chrome and returns the commit pos, or null
     * when the pointer sits inside the zone but over no legal slot — and a
     * null return must also UN-render the chrome (the session never cleans
     * up after a provider mid-hover; `clear` only fires on zone exit/end).
     * Called on every mousemove inside the zone AND once per auto-scroll
     * frame, so it must be cheap and idempotent — no layout writes when the
     * answer hasn't changed.
     *
     * `relevelDelta` (optional) rides along to the moveBlocks commit: a zone
     * whose slots carry structural intent (the TOC outline) reports the rank
     * shift its drop implies. Omitted ⇒ a literal move. The DOCUMENT path
     * never sets it — dragging in the text is a literal move; dragging in
     * the outline is a structural edit.
     */
    target(
        x: number,
        y: number,
        range: { from: number; to: number },
    ): { pos: number; relevelDelta?: number } | null;
    /** The pointer left the zone, or the session ended: remove all chrome.
     * Distinct from `target() → null` (still inside, just no legal slot);
     * both must be idempotent — the session may issue either repeatedly. */
    clear(): void;
    /**
     * Per-frame edge auto-scroll while the pointer rests inside the zone.
     * Return true iff the zone actually scrolled — the session then calls
     * `target` again to re-aim at the shifted geometry. Returning false
     * after scrolling leaves the committed target aimed at slots that no
     * longer sit under the pointer.
     */
    autoScroll(y: number): boolean;
    sessionEnd(): void;
}

const dropZoneProviders = new Set<DropZoneProvider>();

/** Register a drop zone for future drag sessions; returns the unregister. */
export function registerDropZoneProvider(provider: DropZoneProvider): () => void {
    dropZoneProviders.add(provider);
    return () => {
        dropZoneProviders.delete(provider);
    };
}

/**
 * Scroll the block a successful moveBlocks landed at under the topbar — the
 * same scroll TOC navigation uses (scrollElementBelowTopbar), so a drop-zone
 * commit and a TOC click settle the viewport identically. moveBlocks leaves
 * the selection riding the moved content (caret or block range at the
 * destination), so its top-level block IS the landing.
 */
function scrollLandedRangeIntoView(view: EditorView): void {
    const from = view.state.selection.from;
    const $from = view.state.doc.resolve(from);
    const dom = view.nodeDOM($from.depth > 0 ? $from.before(1) : from);
    if (dom instanceof HTMLElement) {
        scrollElementBelowTopbar(dom);
    }
}

// ── The pointer drag session ────────────────────────────────────────────────

/** What a drag source (gutter marker, TOC item, …) supplies to a session. */
export interface DragSessionSource {
    startX: number;
    startY: number;
    /** Called at threshold-crossing: the dragged unit, or null to abort the session. */
    resolveRange(): {
        range: { from: number; to: number };
        kind: "block" | "item";
        multi: boolean;
        label: string;
    } | null;
    /** Source-side chrome at threshold-crossing (dragged flag + class). */
    onStart?(): void;
    /** Source-side teardown when the session ends (commit, cancel, or abort). */
    onStop?(): void;
}

/**
 * Run one pointer drag session, from an armed mousedown to commit or cancel.
 * The session owns everything source-agnostic: the movement threshold, the
 * capture-phase listeners, document boundary targeting (indicator line +
 * edge auto-scroll), drop-zone provider handoff, the cursor pill, the range
 * veil, and the moveBlocks commit. The source supplies only what varies per
 * handle kind, via DragSessionSource.
 */
export function startPointerDragSession(view: EditorView, source: DragSessionSource): void {
    const { startX, startY } = source;
    let dragging = false;
    let sessionStarted = false; // providers were told sessionStart
    let target: { pos: number; relevelDelta?: number } | null = null;
    let range: { from: number; to: number } | null = null;
    let boundaries: DropBoundary[] = [];
    let draggedKind: "block" | "item" = "block";
    let multi = false;
    let scrollDir = 0;
    let scrollRaf = 0;
    let lastPointerX = startX;
    let lastPointerY = startY;
    let label = "";
    let activeProvider: DropZoneProvider | null = null;
    // The doc the session's range/boundaries were measured against — an
    // inbound edit mid-drag (external file sync) invalidates them, and a
    // drop must then cancel rather than slice stale positions.
    let startDoc: ProseNode | null = null;

    const scrollLoop = (): void => {
        if (activeProvider) {
            // The provider owns scrolling while the pointer is inside it; a
            // scroll moves its geometry, so re-aim its target.
            if (activeProvider.autoScroll(lastPointerY) && range) {
                target = activeProvider.target(lastPointerX, lastPointerY, range);
            }
            scrollRaf = requestAnimationFrame(scrollLoop);
            return;
        }
        const velocity = scrollDir === 0 ? 0 : scrollVelocityFor(lastPointerY);
        if (velocity !== 0) {
            window.scrollBy(0, velocity);
            // Geometry shifted under the pointer — remeasure and re-aim.
            boundaries = measureBoundaries(view).filter((b) => b.kind === draggedKind);
            if (range) {
                const boundary = dropTargetFor(boundaries, lastPointerY, range);
                target = boundary;
                if (boundary) {
                    showIndicator(view, boundary);
                } else {
                    hideDropIndicator();
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
        hideDropIndicator();
        hidePill();
        if (sessionStarted) {
            // Full provider teardown, pointer inside one or not — clear()
            // is idempotent chrome removal, so all zones get both calls.
            for (const provider of dropZoneProviders) {
                provider.clear();
                provider.sessionEnd();
            }
        }
        activeProvider = null;
        // A multi-block selection that outlives the session (e.g. an
        // Escape-canceled multi-drag) keeps its veil — one visual
        // language for the covered range, dragging or not.
        const survivingCover = selectionCoverRange(view);
        if (survivingCover) {
            showRangeVeil(view, survivingCover, "select");
        } else {
            hideRangeVeil();
        }
        document.body.classList.remove("block-dragging");
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("blur", onBlur);
        source.onStop?.();
    };

    const onMove = (move: MouseEvent): void => {
        lastPointerX = move.clientX;
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
            // Threshold crossed — the session starts now. onStart runs
            // BEFORE resolveRange so the source's click-suppression flag is
            // set even when resolution aborts (the release's click on the
            // handle must stay suppressed either way).
            dragging = true;
            source.onStart?.();
            const resolved = source.resolveRange();
            if (!resolved) {
                stop();
                return;
            }
            range = resolved.range;
            draggedKind = resolved.kind;
            multi = resolved.multi;
            label = resolved.label;
            boundaries = measureBoundaries(view).filter((b) => b.kind === draggedKind);
            startDoc = view.state.doc;
            closeBlockMenu();
            hideTooltip();
            document.body.classList.add("block-dragging");
            showRangeVeil(view, range);
            sessionStarted = true;
            for (const provider of dropZoneProviders) {
                provider.sessionStart(view, range, draggedKind);
            }
        }
        move.preventDefault();
        showPill(move.clientX, move.clientY, label);
        // A drop zone containing the pointer takes over targeting: it draws
        // its own chrome, so the document indicator hides and document
        // edge-scroll goes quiet until the pointer leaves it again.
        let provider: DropZoneProvider | null = null;
        for (const p of dropZoneProviders) {
            if (p.contains(move.clientX, move.clientY)) {
                provider = p;
                break;
            }
        }
        if (provider !== activeProvider) {
            activeProvider?.clear();
            activeProvider = provider;
        }
        if (provider) {
            hideDropIndicator();
            scrollDir = 0;
            target = provider.target(move.clientX, move.clientY, range!);
            if (!scrollRaf) {
                // Keep the frame loop alive so the provider gets its per-
                // frame autoScroll chances while the pointer rests inside.
                scrollRaf = requestAnimationFrame(scrollLoop);
            }
            return;
        }
        const boundary = dropTargetFor(boundaries, move.clientY, range!);
        target = boundary;
        if (boundary) {
            showIndicator(view, boundary);
        } else {
            hideDropIndicator();
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
        const commitMulti = multi;
        // Captured before stop() nulls it: whether the target came from a
        // drop-zone provider rather than a document boundary.
        const commitViaProvider = activeProvider !== null;
        stop();
        if (commit) {
            const moved = moveBlocks(view, commitRange!, commitTarget!.pos, {
                selectRun: commitMulti,
                // Set only by a structural zone (the TOC outline); the
                // document boundary path leaves it undefined.
                relevelDelta: commitTarget!.relevelDelta ?? 0,
            });
            // A document drop lands where the pointer already is, but a
            // drop-zone commit (a TOC "into" files at a section's end) can
            // land anywhere — off-screen, the landing flash paints outside
            // the viewport and the move reads as "my block disappeared".
            // Bring the destination into view, provider path only.
            if (moved && commitViaProvider) {
                scrollLandedRangeIntoView(view);
            }
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
}

/**
 * Arm a gutter marker for drag-to-reorder. Call once per marker; the handler
 * coexists with the marker's click-for-menu (a drag past the threshold sets
 * `data-dragged`, which the click handler consumes to skip opening the menu).
 * A thin wrapper over startPointerDragSession — only the marker-specific
 * bits live here (unit resolution, cover adoption, the marker's own chrome).
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
        startPointerDragSession(view, {
            startX: event.clientX,
            startY: event.clientY,
            resolveRange: () => {
                const pos = blockPos();
                let range = pos === null ? null : moveRangeAt(view, pos);
                // Multi-block drag: a selection spanning several top-level
                // blocks, with this marker's block inside it, drags the whole
                // covered run (the selection is KEPT — history then restores
                // it on undo).
                const cover = selectionCoverRange(view);
                // Only a TOP-LEVEL block's marker adopts the cover: a
                // nested child's marker still drags its own block even
                // inside a covered container (the handle you grab is the
                // block you move).
                const multi = Boolean(
                    range && cover && range.from >= cover.from && range.from < cover.to &&
                    view.state.doc.resolve(range.from).depth === 0,
                );
                if (multi) {
                    range = cover;
                }
                if (!range) {
                    return null;
                }
                if (!multi) {
                    // Caret into the dragged block: history snapshots the
                    // selection before the drop's transaction, so undoing a
                    // drag scrolls back to where the block came FROM. (A
                    // selection-only transaction: the session's startDoc
                    // identity guard and boundary geometry are unaffected.)
                    selectInto(view, range.from);
                }
                return {
                    range,
                    // A dragged unit only sees slots of its own kind: items
                    // drop at item boundaries (any list), blocks at block
                    // boundaries.
                    kind: !multi && view.state.doc.nodeAt(range.from)?.type.name === "list_item"
                        ? ("item" as const)
                        : ("block" as const),
                    multi,
                    label: pillLabel(view, marker.dataset["pill"] ?? marker.textContent ?? "", range),
                };
            },
            onStart: () => {
                marker.dataset["dragged"] = "1";
                marker.classList.add("heading-fold-marker--dragging");
            },
            onStop: () => {
                marker.classList.remove("heading-fold-marker--dragging");
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
            },
        });
    });
}
