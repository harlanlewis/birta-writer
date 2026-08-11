/**
 * components/blockMenu/drag.ts
 *
 * Drag-to-reorder for the gutter block markers (MAR-19). Pointer-event based
 * — native HTML5 DnD is deliberately avoided (it leaked drag payloads into
 * the document and fought ProseMirror's own drop handler; see MAR-36).
 *
 * A mousedown on a marker arms a potential drag; crossing a small movement
 * threshold starts the session (and suppresses the click that would open the
 * block menu). The dragged unit is moveRangeAt's answer — every block moves
 * alone, a heading included, because a drag in the text is a literal sequence
 * edit. What the drag carries is the DESTINATION's call, not the handle's: a
 * zone declaring `scope: "outline"` (the TOC panel) re-scopes the very same
 * session to whole sections, and the veil and pill follow the pointer across
 * the boundary. While dragging:
 *   - a drop indicator line (theme accent) snaps to the nearest block
 *     boundary under the pointer. A drag is a free-form refile — unlike the
 *     menu's Move rows, which hop whole units — because markdown is text and
 *     dropping a section inside another section is a legitimate outline edit.
 *     The bound on that freedom is the move primitive's own verdict for the
 *     dragged run (`moveTargetFilter`), asked about the slot the pointer
 *     chose: THE LINE IS DRAWN ONLY WHERE A RELEASE WILL LAND, so there is no
 *     aiming at a drop that does nothing. Its two documented exclusions stay
 *     out: a target inside the dragged range is the put-it-back no-op, and
 *     the save-survival hazard is too expensive to ask per pointer move, so
 *     it alone can still refuse a drawn line — visibly, with its own notice;
 *   - the window auto-scrolls when the pointer nears the viewport edges;
 *   - Escape cancels, mouseup commits (one transaction, one undo step).
 *
 * The session machinery is source-agnostic (startPointerDragSession) — the
 * gutter marker is one DragSessionSource; other handles (e.g. TOC items)
 * supply their own. Registered DropZoneProviders (the TOC panel) take over
 * targeting while the pointer is inside them; the commit path stays the one
 * moveBlocks call regardless of zone.
 */
import type { EditorView } from "../../pm";
import type { EditorState } from "../../pm";
import type { Node as ProseNode } from "../../pm";
import { closeBlockMenu, moveRangeAt, outlineRangeAt } from "./menu";
import {
    foldedHiddenRanges,
    hiddenRangeCoversTarget,
    moveBlocks,
    moveTargetFilter,
} from "../../editing/blockOps";
import { isContainerNode, isListNode, selectionCoverRange } from "../../plugins/headingFold";
import { isBlankParagraph } from "../../plugins/fingerprints";
import { selectInto } from "./turnInto";
import { hideRangeVeil, showRangeVeil } from "../../editing/rangeIndicator";
import { hideTooltip } from "../../ui/tooltip";
import { getTopbarBottom, scrollElementBelowTopbar } from "../../utils/headingUtils";
import { stickyClearanceMargin } from "../../plugins/caretScrollMargin";
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
 * block plus the doc's end (kind "block"), before each list item at any
 * nesting depth plus each list's end (kind "item"), and — inside containers
 * and multi-child list items — before each nested block plus the parent's
 * end (kind "block"). Pure on the doc; the caller pairs positions with
 * viewport geometry. Exported for unit testing.
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
            // Item-internal BLOCK slots (MAR-88): between an item's
            // continuation blocks, and after the last one, so a block can be
            // dropped into (or reordered within) the item. Three deliberate
            // gaps: no slot before the LEAD child — `list_item` is
            // `paragraph block*`, so a non-paragraph drop there fails
            // canReplace and moveBlocks would refuse LOUDLY (its
            // caller-bug lane), and slot emission is content-blind so it
            // cannot offer that slot only to paragraphs — no slots at
            // all for a single-child item, whose interior has no
            // between-continuation boundary (scope of the MAR-88 defer) —
            // and none in an ARTIFACT-LEAD item, below.
            //
            // `- > quote` parses as [artifact empty paragraph, blockquote]:
            // the empty lead is a schema artifact the user cannot see. While
            // the item holds one real block the serializer rides it on the
            // marker line and the artifact never reaches the file (MAR-230),
            // but any SECOND real block forces the artifact out as a bare `-`
            // marker line with the content indented beneath — which re-lexes
            // as a setext underline and destroys the list on reopen. So every
            // interior slot of such an item is a slot whose drop corrupts the
            // document, and the emission is content-blind, so it cannot offer
            // only the safe ones. Withheld outright, and the withholding is
            // load-bearing rather than tidy: the same positions feed the image
            // FILE-DROP path (`editing/fileDrop.ts`), which commits a plain
            // async insert that no refuse lane inspects.
            const artifactLead =
                item.childCount > 0 && isBlankParagraph(item.child(0), item);
            let childEnd = itemPos + 1;
            item.forEach((child: ProseNode, childOffset: number, index: number) => {
                const childPos = itemPos + 1 + childOffset;
                if (index > 0 && !artifactLead) {
                    positions.push({ pos: childPos, kind: "block", ownerPos: itemPos });
                }
                childEnd = childPos + child.nodeSize;
                if (isListNode(child)) {
                    walkList(child, childPos);
                } else if (isContainerNode(child)) {
                    walkContainer(child, childPos);
                }
            });
            if (item.childCount > 1 && !artifactLead) {
                positions.push({ pos: childEnd, kind: "block", ownerPos: itemPos });
            }
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
 * null, which means no line is drawn and a release commits nothing. Two ways
 * to reach null, and they share that vocabulary on purpose: the user learns
 * "no line, no drop" once.
 *
 *   - The nearest boundary sits inside (or at an edge of) the dragged range:
 *     the "put it back" gesture. (Skipping own-range boundaries before
 *     choosing used to snap the indicator away from the origin, making it
 *     impossible to drop a block back where it was picked up.)
 *   - `isLegalTarget` refuses it — the move primitive's own verdict for this
 *     run (`moveTargetFilter`), so the drop line can only ever be drawn where
 *     the release will actually land.
 *
 * The winner alone is judged, not the whole set, and that is a cost decision
 * rather than a shortcut: judging every slot is quadratic in document size
 * (see `planBoundaries` for the mechanism), while one verdict per pointer
 * move rides the O(slots) scan this function already performs.
 *
 * Refusing rather than snapping onward to the next legal slot is deliberate:
 * a drop that silently travels to somewhere the user did not aim is worse
 * than one that does not happen.
 *
 * `range` is omitted by callers with nothing in flight to put back — an OS
 * file drag (editing/fileDrop.ts) carries content from outside the document,
 * so every boundary is a legal landing. Such callers pass no verdict either;
 * they insert asynchronously through a different path.
 */
export function dropTargetFor(
    boundaries: readonly DropBoundary[],
    pointerY: number,
    range?: { from: number; to: number },
    isLegalTarget?: (pos: number) => boolean,
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
    if (!best) {
        return null;
    }
    if (range && best.pos >= range.from && best.pos <= range.to) {
        return null;
    }
    if (isLegalTarget && !isLegalTarget(best.pos)) {
        return null;
    }
    return best;
}

// selectionCoverRange (the multi-drag cover this session adopts) lives in
// the fold model — the cover is fold-occupancy-aware, and the fold plugin's
// selection cover, the keyboard layer, and this session must all read the
// same one. Re-imported above from the plugins/headingFold facade.

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
 * the edgeScrollVelocity ramp applied to the top/bottom edges of the
 * scrollable content. Shared by the drag, marquee, and file-drop sessions.
 *
 * The top edge is the TOOLBAR's bottom, not the viewport's top. The bar is
 * fixed over the first ~40px of the page, so anchoring the zone at y=0 spent
 * half its ramp under chrome: the pointer was already scrolling at a fair
 * clip while still sitting comfortably inside the visible content, and the
 * full-speed end of the ramp was unreachable without dragging onto the bar.
 * Anchored here, the ramp starts where the content does — and the bar's own
 * band reads as past-the-edge, the same overshoot the bottom already had.
 * `getTopbarBottom()` returns 0 when the toolbar is hidden, so that
 * configuration behaves exactly as before. This mirrors what the TOC panel's
 * zone already does with its own scroller rect (components/toc/dnd.ts).
 */
export function scrollVelocityFor(clientY: number): number {
    const contentTop = getTopbarBottom();
    // Clamp the zones on short viewports so a dead band always exists in
    // the middle — otherwise every pointer position would auto-scroll.
    const zone = Math.min(SCROLL_ZONE, Math.floor((window.innerHeight - contentTop) / 3));
    const topDepth = contentTop + zone - clientY;
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
 * AT a heading section's end survives — it renders at the terminating
 * heading's line, so the user can see and aim at it; a collapsed callout's
 * end-of-body slot does not (both per hiddenRangeCoversTarget — the SAME
 * legality registry moveBlocks enforces, so the slots the UI offers and the
 * targets the primitive accepts cannot drift).
 *
 * That surviving slot is visible but sits INSIDE the section for insertion
 * purposes, so a drop there would be swallowed; moveBlocks reveals the fold
 * instead of hiding the landing (MAR-146). Offering it is therefore correct
 * — the drop is honored, not silently lost. Exported for unit testing.
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

/**
 * One boundary's cacheable half: everything about it that cannot change while
 * the editor state doesn't — its position and kind, and WHICH elements supply
 * its geometry. Resolving these is the expensive part (a full document walk,
 * a `view.nodeDOM` view-desc lookup per position, a `closest()` per element);
 * reading their rects is not. Splitting the two is what lets a drag measure
 * the plan once and re-read only rects on every auto-scroll frame.
 */
interface BoundaryPlan {
    pos: number;
    kind: "block" | "item";
    /** Owned slots (list items, container children) indent the drop line to
     * their own column; top-level ones span the editor. */
    owned: boolean;
    /** The element whose top is this boundary line (slot before a node). */
    dom: HTMLElement | null;
    /** End-of-owner slot: the owner's bottom, at its last child's column. */
    ownerDom: HTMLElement | null;
    columnDom: HTMLElement | null;
    /** The doc-end slot has no node of its own — it rides the bottom of
     * whichever top-level block turns out to be the last visible one, which
     * only the rect pass can know. */
    isDocEnd: boolean;
}

/**
 * Resolve every droppable boundary to the elements that will supply its
 * geometry. Pure over `view.state` + the current DOM shape — the caller may
 * cache the result for as long as `view.state` is identical (a scroll changes
 * geometry but no state, which is exactly the case this exists for).
 *
 * Deliberately NOT where the dragged run's legality is judged, though it is
 * the tempting place. `moveTargetFilter`'s per-target half is a `canReplace`,
 * and ProseMirror answers that by walking its parent's content from the index
 * to the end, so judging EVERY slot here would walk the whole document per
 * slot: quadratic in document size, on top of a plan that is already
 * O(blocks). The one slot the pointer actually chose is judged instead, once
 * per move, in `dropTargetFor`.
 */
export function planBoundaries(view: EditorView): BoundaryPlan[] {
    const { doc } = view.state;
    const plans: BoundaryPlan[] = [];
    for (const { pos, kind, ownerPos } of visibleBoundaryPositions(view.state)) {
        if (kind === "block" && pos === doc.content.size) {
            plans.push({ pos, kind, owned: false, dom: null, ownerDom: null, columnDom: null, isDocEnd: true });
            continue;
        }
        const dom = view.nodeDOM(pos);
        if (dom instanceof HTMLElement) {
            if (inCollapsedCalloutBody(dom)) {
                continue;
            }
            plans.push({
                pos, kind, owned: ownerPos !== undefined,
                dom, ownerDom: null, columnDom: null, isDocEnd: false,
            });
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
                plans.push({
                    pos, kind, owned: true, dom: null, ownerDom,
                    columnDom: lastChildDom instanceof HTMLElement ? lastChildDom : ownerDom,
                    isDocEnd: false,
                });
            }
        }
    }
    return plans;
}

/**
 * Read the plan's current viewport geometry. The only per-frame half: rect
 * reads, no tree walking. Entries whose element has gone display:none (zero
 * rect) drop out here rather than at plan time, because that is a rendering
 * state a plan cannot predict — and a slot with no visible geometry must
 * never win the nearest-y contest, or a drop would commit into hidden
 * content.
 */
export function readBoundaries(plans: readonly BoundaryPlan[]): DropBoundary[] {
    const boundaries: DropBoundary[] = [];
    let lastBlockBottom: number | null = null;
    for (const plan of plans) {
        if (plan.isDocEnd) {
            if (lastBlockBottom !== null) {
                boundaries.push({ pos: plan.pos, y: lastBlockBottom, kind: plan.kind });
            }
            continue;
        }
        if (plan.dom) {
            const rect = plan.dom.getBoundingClientRect();
            if (rect.height === 0 && rect.width === 0) {
                continue;
            }
            if (plan.owned) {
                boundaries.push({
                    pos: plan.pos, y: rect.top, kind: plan.kind,
                    left: rect.left, width: rect.width,
                });
            } else {
                boundaries.push({ pos: plan.pos, y: rect.top, kind: plan.kind });
                lastBlockBottom = rect.bottom;
            }
        } else if (plan.ownerDom && plan.columnDom) {
            const column = plan.columnDom.getBoundingClientRect();
            boundaries.push({
                pos: plan.pos,
                y: plan.ownerDom.getBoundingClientRect().bottom,
                kind: plan.kind,
                left: column.left,
                width: column.width,
            });
        }
    }
    return boundaries;
}

/**
 * A measurer for callers that re-measure REPEATEDLY during one interaction —
 * every auto-scroll frame, every pointer move. It re-plans only when
 * `view.state` changes and otherwise re-reads rects alone.
 *
 * Why it exists: planning is the expensive half and a scroll changes no state,
 * so re-planning per frame was pure waste — and waste that scales with the
 * document. Median auto-scroll frame time on a synthetic prose document
 * (headless Chromium, 2026-07-30), before → after this split:
 *
 *     3k blocks   16.7 ms → 16.7 ms     (already free; unchanged)
 *     6k blocks   49.5 ms → 16.7 ms
 *     9k blocks   93.7 ms → 16.7 ms
 *    15k blocks    197 ms → 16.7 ms     (5 fps → 60 fps; 8× the travel)
 *
 * A steady 60 fps at every size, with the whole remaining cost being the
 * rect pass — which is why this stops at caching and does NOT go on to
 * binary-search the boundary list for the one near the pointer. Reading
 * 15,000 rects fits in a frame; the tree walk did not. The one-time plan is
 * still O(document) and shows up as a single long first frame (~250 ms at 15k
 * blocks) when a drag starts on a document that size.
 *
 * `kind` filters at plan time, which also skips those entries' rect reads.
 * That is equivalent to filtering the result: only top-level entries feed
 * `lastBlockBottom`, and those are exactly the un-owned `block` ones, so
 * keeping `block` keeps every contributor, while keeping `item` drops the
 * doc-end slot that would have consumed it.
 *
 * State identity is ALMOST the whole invalidation story — every redraw
 * ProseMirror performs runs through `updateState`, so a decoration or plugin
 * change brings a new state with it. The exception is a NodeView that swaps
 * its own root element without a transaction: the plan would then hold a
 * detached node, which measures as a zero rect and silently drops that
 * boundary for the rest of the drag. So a connectivity sweep runs alongside
 * the rect pass — an `isConnected` read per entry, immaterial next to the
 * rects it accompanies — and re-plans if any element has been swapped out.
 */
export function createBoundaryMeasurer(kind?: "block" | "item"): {
    measure(view: EditorView): DropBoundary[];
    reset(): void;
} {
    let plannedFor: EditorState | null = null;
    let plans: BoundaryPlan[] = [];

    const plan = (view: EditorView): void => {
        plannedFor = view.state;
        const all = planBoundaries(view);
        plans = kind ? all.filter((p) => p.kind === kind) : all;
    };

    /** Whether every element the plan points at is still in the document. */
    const planIsLive = (): boolean =>
        plans.every((p) =>
            (p.dom?.isConnected ?? true) &&
            (p.ownerDom?.isConnected ?? true) &&
            (p.columnDom?.isConnected ?? true));

    return {
        measure(view: EditorView): DropBoundary[] {
            if (plannedFor !== view.state || !planIsLive()) {
                plan(view);
            }
            return readBoundaries(plans);
        },
        reset(): void {
            plannedFor = null;
            plans = [];
        },
    };
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

/**
 * Draw the drop line for a measured boundary — the one place that decides
 * how a boundary becomes pixels, shared by the drag session and by the file
 * drop path so a dropped image aims with the same line a dragged block does.
 */
export function showBoundaryIndicator(view: EditorView, target: DropBoundary): void {
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
    /**
     * What a dragged HEADING carries when it lands here. "body" moves the
     * heading line alone (the document canvas: a literal sequence edit);
     * "outline" moves its whole section. The DESTINATION decides, not the
     * handle the drag started on — a row in the outline stands for a section
     * wherever the grab happened, and a drop in the text is a literal move
     * even for a section dragged out of the panel. The session re-scopes the
     * range, the veil, and the pill as the pointer crosses in and out.
     */
    scope: "body" | "outline";
    /** Whether the viewport point sits inside this zone. With multiple
     * providers registered, the FIRST one (in registration order) whose
     * `contains` hits takes the pointer — zones must not overlap, or
     * registration order silently decides the winner. */
    contains(x: number, y: number): boolean;
    /** A drag session started: the dragged unit AT THIS ZONE'S SCOPE, for
     * slot precomputation. */
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
 * Scroll the block a successful moveBlocks landed at into view — the same
 * margin the review sidebar's range navigation uses (stickyClearanceMargin),
 * so a drop-zone commit and a sidebar jump settle the viewport identically.
 * The margin matters: a drop landing inside a section sits under that
 * section's sticky title, so clearing only the topbar can hide the landing
 * behind the bar. moveBlocks leaves the selection riding the moved content
 * (caret or block range at the destination), so its top-level block IS the
 * landing.
 */
function scrollLandedRangeIntoView(view: EditorView): void {
    const from = view.state.selection.from;
    const $from = view.state.doc.resolve(from);
    const dom = view.nodeDOM($from.depth > 0 ? $from.before(1) : from);
    if (dom instanceof HTMLElement) {
        scrollElementBelowTopbar(dom, stickyClearanceMargin());
    }
}

// ── The pointer drag session ────────────────────────────────────────────────

/** What a drag source (gutter marker, TOC item, …) supplies to a session. */
export interface DragSessionSource {
    startX: number;
    startY: number;
    /**
     * Called at threshold-crossing: the dragged unit, or null to abort the
     * session. BOTH scopes are resolved here, once, against the document the
     * session pins (`startDoc`) — the zone under the pointer picks between
     * them per move. A source with one answer for both (a multi-block cover,
     * a list item) omits the outline pair and every zone sees the same range.
     */
    resolveRange(): {
        range: { from: number; to: number };
        kind: "block" | "item";
        multi: boolean;
        label: string;
        /** The unit an "outline"-scoped zone receives; defaults to `range`. */
        outlineRange?: { from: number; to: number };
        /** Pill text while an "outline"-scoped zone has the pointer; defaults
         * to `label`. The pill must name what will actually move. */
        outlineLabel?: string;
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
    let outlineRange: { from: number; to: number } | null = null;
    let boundaries: DropBoundary[] = [];
    let draggedKind: "block" | "item" = "block";
    let multi = false;
    let scrollDir = 0;
    let scrollRaf = 0;
    let lastPointerX = startX;
    let lastPointerY = startY;
    let label = "";
    let outlineLabel = "";
    let activeProvider: DropZoneProvider | null = null;
    // Re-measured on every auto-scroll frame, so it re-plans only when the
    // state changes (see createBoundaryMeasurer).
    const measurer = createBoundaryMeasurer();
    // The move primitive's verdict for THIS run, resolved once (its expensive
    // half is the source, which cannot change mid-session — a doc edit cancels
    // the drop through the startDoc guard). Consulted for the one slot the
    // pointer chose, so the drop line only ever marks a landing that commits.
    let targetIsLegal: ((pos: number) => boolean) | null = null;
    // The doc the session's range/boundaries were measured against — an
    // inbound edit mid-drag (external file sync) invalidates them, and a
    // drop must then cancel rather than slice stale positions.
    let startDoc: ProseNode | null = null;

    /** The dragged unit at the scope of the zone currently holding the
     * pointer: the whole section inside the outline, the block alone over the
     * document. Every consumer of "what is being dragged" — veil, pill,
     * provider targeting, commit — reads it through here, so the three can
     * never disagree about what a drop will move. */
    const scopedRange = (): { from: number; to: number } =>
        (activeProvider?.scope === "outline" ? outlineRange : range)!;

    // The scope the source-side chrome currently shows, so a mousemove that
    // did not cross a zone boundary repaints nothing. The veil's reposition is
    // a layout read per call and this runs on every pointer move.
    let paintedScope: "body" | "outline" | null = null;

    /** Re-render the source-side chrome for the current scope: the veil over
     * what will move, the pill naming it. The pill's POSITION follows the
     * cursor every move; its text and the veil only change with the scope. */
    const paintScope = (): void => {
        const scope = activeProvider?.scope ?? "body";
        if (scope !== paintedScope) {
            paintedScope = scope;
            showRangeVeil(view, scopedRange());
        }
        showPill(lastPointerX, lastPointerY, scope === "outline" ? outlineLabel : label);
    };

    const scrollLoop = (): void => {
        if (activeProvider) {
            // The provider owns scrolling while the pointer is inside it; a
            // scroll moves its geometry, so re-aim its target.
            if (activeProvider.autoScroll(lastPointerY) && range) {
                target = activeProvider.target(lastPointerX, lastPointerY, scopedRange());
            }
            scrollRaf = requestAnimationFrame(scrollLoop);
            return;
        }
        const velocity = scrollDir === 0 ? 0 : scrollVelocityFor(lastPointerY);
        if (velocity !== 0) {
            window.scrollBy(0, velocity);
            // Geometry shifted under the pointer — remeasure and re-aim.
            boundaries = measurer.measure(view).filter((b) => b.kind === draggedKind);
            if (range) {
                const boundary = dropTargetFor(boundaries, lastPointerY, range, targetIsLegal ?? undefined);
                target = boundary;
                if (boundary) {
                    showBoundaryIndicator(view, boundary);
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
            outlineRange = resolved.outlineRange ?? resolved.range;
            draggedKind = resolved.kind;
            multi = resolved.multi;
            label = resolved.label;
            outlineLabel = resolved.outlineLabel ?? resolved.label;
            // After resolveRange, which may have dispatched (selectInto), so
            // the verdict is read off the state the boundaries describe.
            targetIsLegal = moveTargetFilter(view.state, range);
            boundaries = measurer.measure(view).filter((b) => b.kind === draggedKind);
            startDoc = view.state.doc;
            closeBlockMenu();
            hideTooltip();
            document.body.classList.add("block-dragging");
            sessionStarted = true;
            for (const provider of dropZoneProviders) {
                provider.sessionStart(
                    view,
                    provider.scope === "outline" ? outlineRange : range,
                    draggedKind,
                );
            }
        }
        move.preventDefault();
        // A drop zone containing the pointer takes over targeting: it draws
        // its own chrome, so the document indicator hides and document
        // edge-scroll goes quiet until the pointer leaves it again. Resolved
        // BEFORE the chrome is painted — the zone decides the scope, and the
        // veil and pill must show the scope the drop will actually use.
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
        paintScope();
        if (provider) {
            hideDropIndicator();
            scrollDir = 0;
            target = provider.target(move.clientX, move.clientY, scopedRange());
            if (!scrollRaf) {
                // Keep the frame loop alive so the provider gets its per-
                // frame autoScroll chances while the pointer rests inside.
                scrollRaf = requestAnimationFrame(scrollLoop);
            }
            return;
        }
        const boundary = dropTargetFor(boundaries, move.clientY, range!, targetIsLegal ?? undefined);
        target = boundary;
        if (boundary) {
            showBoundaryIndicator(view, boundary);
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
        // Scoped to the zone the pointer is in NOW — captured before stop()
        // clears activeProvider, which is what scopedRange reads.
        const commitRange = range ? scopedRange() : null;
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
                // The outline scope's answer for the SAME grab, resolved now
                // so a pointer crossing into the TOC panel costs no doc walk.
                let outlineRange = pos === null ? null : outlineRangeAt(view, pos);
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
                    // A cover is already the user's explicit statement of what
                    // moves, so both scopes see it unchanged.
                    range = cover;
                    outlineRange = cover;
                }
                if (!range || !outlineRange) {
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
                const name = marker.dataset["pill"] ?? marker.textContent ?? "";
                return {
                    range,
                    outlineRange,
                    // A dragged unit only sees slots of its own kind: items
                    // drop at item boundaries (any list), blocks at block
                    // boundaries.
                    kind: !multi && view.state.doc.nodeAt(range.from)?.type.name === "list_item"
                        ? ("item" as const)
                        : ("block" as const),
                    multi,
                    label: pillLabel(view, name, range),
                    outlineLabel: pillLabel(view, name, outlineRange),
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
