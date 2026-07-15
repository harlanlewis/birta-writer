/**
 * components/toc/dropModel.ts
 *
 * Pure drop model for TOC drag-and-drop: maps the outline's top-level items
 * to the legal document positions a dragged block run may commit at (via
 * editing/moveBlocks). Zero DOM access — the TOC panel pairs these slots
 * with measured geometry and registers itself as a DropZoneProvider (see
 * components/blockMenu/drag); this module only decides WHERE a drop may
 * land, WHICH slot a pointer means, and AT WHAT LEVEL a dropped section
 * lands.
 *
 * Slots DO relevel (MAR-81 reversed): the outline is both a view of the text
 * and a structural editor, so a drop's position dictates the dragged
 * section's rank — the drop context always wins, which is what makes an
 * outline drag readable from the insertion point alone.
 *
 *   - gap  → SIBLING of the heading the line sits above (terminal gap: of
 *            the last section).
 *   - into → CHILD of the owning heading (owner level + 1).
 *
 * The document canvas deliberately does NOT relevel: dragging in the text is
 * a literal move (see components/blockMenu/drag), dragging in the outline is
 * a structural edit. Only this provider supplies a delta.
 */
import type { Node as ProseNode } from "@milkdown/prose/model";
import { findHeadingFoldRange, getHeadingLevel } from "../../plugins/headingFold";

/** Markdown's heading rank bounds — a relevel clamps into this range. */
export const MIN_HEADING_LEVEL = 1;
export const MAX_HEADING_LEVEL = 6;

export interface TocHeadingEntry {
    level: number;
    text: string;
    pos: number;
    /** Whether the entry is a top-tier item of the rendered outline — only
     * these produce slots (nested headings are landmarks, not drop rows). */
    topLevel: boolean;
}

export interface TocSlot {
    /** gap = section boundary line; into = append at end of the item's section. */
    kind: "gap" | "into";
    /** Document position moveBlocks commits at. */
    pos: number;
    /** Index into the rendered top-level item list (gap sits at this item's
     * top; == count ⇒ the terminal after-last slot). */
    tocIndex: number;
    /** "into" only: the owning heading's pos (drives the item highlight). */
    headingPos?: number;
    /** The rank a dropped SECTION takes here — gap: the level of the heading
     * below the line (terminal gap: the last section's); into: the owner's
     * level + 1, clamped. Non-heading runs ignore it (tocRelevelDelta → 0). */
    targetLevel: number;
}

/**
 * Every legal drop slot for the current outline: a gap before each
 * top-level heading, one "into" per top-level heading (the end of its WHOLE
 * section, subsections included — the fold range is the section), and a
 * terminal end-of-doc gap. Slots whose pos is fold-hidden (per the caller's
 * predicate, built from the same fold registry moveBlocks enforces) are
 * dropped, so the slots the TOC offers and the targets the primitive
 * accepts cannot drift. An empty top-level outline yields NO slots — with
 * nothing rendered there is nothing to aim at.
 */
export function tocDropSlots(
    headings: readonly TocHeadingEntry[],
    doc: ProseNode,
    isHiddenTarget: (pos: number) => boolean,
    /** Whether the section owned by the heading at `pos` is COLLAPSED. Such a
     * section offers no "into" slot: filing a run into it would drop the run
     * under a fold and it would land at display:none — indistinguishable from
     * a delete. `isHiddenTarget` cannot catch this, because the into slot's
     * commit pos (the section's END boundary) is legal and visible BEFORE the
     * move; it is the drop itself — a relevel making the run a child, or
     * simply the section growing to swallow what was appended at its edge —
     * that closes the fold over the landing. Refusing the slot up front is
     * the only check that sees it coming. Defaults to "nothing collapsed" so
     * the pure model stays callable without fold state. */
    isCollapsed: (pos: number) => boolean = () => false,
): TocSlot[] {
    const slots: TocSlot[] = [];
    let topIndex = 0;
    // The terminal gap makes the run a sibling of the LAST section, so it
    // trails the most recent top-level heading's rank.
    let lastLevel = MIN_HEADING_LEVEL;
    for (const heading of headings) {
        if (!heading.topLevel) {
            continue;
        }
        const node = doc.nodeAt(heading.pos);
        if (!node) {
            continue; // stale outline entry — the doc moved on
        }
        slots.push({
            kind: "gap",
            pos: heading.pos,
            tocIndex: topIndex,
            // A gap line sits ABOVE this heading: dropping there makes the
            // run this heading's sibling, hence its exact rank.
            targetLevel: heading.level,
        });
        if (!isCollapsed(heading.pos)) {
            slots.push({
                kind: "into",
                // The section's end; a heading with no body ends right after
                // its own line (so "into" an empty section drops just below it).
                pos: findHeadingFoldRange(doc, heading.pos, heading.level)?.to ?? heading.pos + node.nodeSize,
                tocIndex: topIndex,
                headingPos: heading.pos,
                targetLevel: Math.min(heading.level + 1, MAX_HEADING_LEVEL),
            });
        }
        lastLevel = heading.level;
        topIndex++;
    }
    if (topIndex === 0) {
        return [];
    }
    slots.push({ kind: "gap", pos: doc.content.size, tocIndex: topIndex, targetLevel: lastLevel });
    return slots.filter((slot) => !isHiddenTarget(slot.pos));
}

/**
 * A slot paired with viewport geometry by the DOM layer:
 *   - gap: `y` is the boundary LINE — the top edge of the top-level item at
 *     tocIndex (terminal slot: the bottom edge of the last rendered item);
 *     left/width span the indicator line.
 *   - into: `top`/`height` are the item's FULL band and `y` its center
 *     (top + height / 2); left/width are the item's box. The band drives
 *     the middle-band hit test — keeping gaps as lines and intos as bands
 *     keeps the two contests from competing on one axis.
 */
export interface MeasuredTocSlot extends TocSlot {
    y: number;
    top?: number;
    height?: number;
    left: number;
    width: number;
}

/**
 * The slot a pointer at `pointerY` means — the hybrid band model: with
 * `allowInto`, the middle band (25%–75%) of an item's measured extent means
 * "into" that item's section; the edge bands (and everything, with
 * `allowInto: false`) mean the nearest gap by y. Band containment is STRICT,
 * so a pointer on a shared edge (an empty section's into band flush with a
 * gap line — coincident ys) resolves to the gap. Null when there are no
 * slots, or when the winning slot is a self/descendant drop (see below).
 *
 * `draggedLevel` (the carried section's rank, null for a non-heading run)
 * decides the ONE case where a positionally-identical drop is still real: a
 * section dropped onto the heading directly ABOVE it commits at its own
 * start — the put-it-back position — yet changes its rank. Once drops
 * relevel, "same position" stops implying "no-op", and rejecting it would
 * silently swallow the most natural nesting gesture there is.
 */
export function tocDropTargetFor(
    slots: readonly MeasuredTocSlot[],
    pointerY: number,
    range: { from: number; to: number },
    opts: { allowInto: boolean; draggedLevel?: number | null },
): MeasuredTocSlot | null {
    let winner: MeasuredTocSlot | null = null;
    if (opts.allowInto) {
        for (const slot of slots) {
            if (slot.kind !== "into" || slot.top === undefined || slot.height === undefined || slot.height <= 0) {
                continue; // a degenerate band (empty section, no extent) never wins
            }
            const bandTop = slot.top + slot.height * 0.25;
            const bandBottom = slot.top + slot.height * 0.75;
            if (pointerY > bandTop && pointerY < bandBottom) {
                winner = slot;
                break;
            }
        }
    }
    if (!winner) {
        let bestDist = Infinity;
        for (const slot of slots) {
            if (slot.kind !== "gap") {
                continue;
            }
            const dist = Math.abs(slot.y - pointerY);
            // Ties break toward the LARGER position (the dropTargetFor
            // convention: coincident slots resolve to the later one).
            if (dist < bestDist || (dist === bestDist && winner !== null && slot.pos > winner.pos)) {
                bestDist = dist;
                winner = slot;
            }
        }
    }
    if (!winner) {
        return null;
    }
    if (winner.pos >= range.from && winner.pos <= range.to) {
        // Inside the dragged range. The lone exception: landing exactly at
        // the range's START with a rank change — the section stays put and
        // only relevels (drop "## Two" onto the "### Deep" it already follows
        // ⇒ Two becomes H4 in place). Everything else here is a self or
        // descendant drop: a section cannot nest inside its own subtree, and
        // a zero-delta drop at the start is the put-it-back gesture.
        const inPlaceRelevel =
            winner.pos === range.from &&
            tocRelevelDelta(winner, opts.draggedLevel ?? null) !== 0;
        if (!inPlaceRelevel) {
            return null;
        }
    }
    return winner;
}

/**
 * The rank of the section a drag is carrying — the level of the heading that
 * STARTS the moved run — or null when the run isn't a heading section (a
 * paragraph refiled from the document: it has no rank, so nothing relevels).
 */
export function draggedSectionLevel(doc: ProseNode, range: { from: number; to: number }): number | null {
    if (range.from < 0 || range.from >= doc.content.size) {
        return null;
    }
    const node = doc.nodeAt(range.from);
    return node?.type.name === "heading" ? getHeadingLevel(node) : null;
}

/**
 * The level delta to apply to EVERY heading in a dragged section for a drop
 * at `slot`: enough to land the section's root heading at the slot's target
 * rank. Zero for a non-heading run (nothing to relevel) and for a drop that
 * already matches the target rank.
 *
 * Markdown headings are flat siblings at the doc root, so a section's whole
 * subtree lives inside the moved range: shifting every heading in the range
 * by this one delta preserves the section's internal hierarchy exactly. Ranks
 * that would overflow clamp at H6 (applied per heading at relevel time), so a
 * deep subtree flattens at the floor rather than blocking a legitimate drop.
 */
export function tocRelevelDelta(slot: TocSlot, draggedLevel: number | null): number {
    if (draggedLevel === null) {
        return 0;
    }
    return slot.targetLevel - draggedLevel;
}

/** Cursor-pill label for a TOC-targeted drag: the heading text, truncated
 * to ~28 chars with an ellipsis so a long title doesn't ride the cursor as
 * a banner. */
export function tocPillLabel(text: string): string {
    const MAX = 28;
    const trimmed = text.trim();
    if (trimmed.length <= MAX) {
        return trimmed;
    }
    return `${trimmed.slice(0, MAX - 1).trimEnd()}…`;
}
