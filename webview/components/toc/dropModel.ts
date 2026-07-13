/**
 * components/toc/dropModel.ts
 *
 * Pure drop model for TOC drag-and-drop: maps the outline's top-level items
 * to the legal document positions a dragged block run may commit at (via
 * editing/moveBlocks). Zero DOM access — the TOC panel pairs these slots
 * with measured geometry and registers itself as a DropZoneProvider (see
 * components/blockMenu/drag); this module only decides WHERE a drop may
 * land and WHICH slot a pointer means.
 *
 * Slots never relevel: an "into" drop appends the run at the end of the
 * target section as-is (markdown is text; the outline is a view of it, not
 * a schema that rewrites what enters).
 */
import type { Node as ProseNode } from "@milkdown/prose/model";
import { findHeadingFoldRange } from "../../plugins/headingFold";

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
): TocSlot[] {
    const slots: TocSlot[] = [];
    let topIndex = 0;
    for (const heading of headings) {
        if (!heading.topLevel) {
            continue;
        }
        const node = doc.nodeAt(heading.pos);
        if (!node) {
            continue; // stale outline entry — the doc moved on
        }
        slots.push({ kind: "gap", pos: heading.pos, tocIndex: topIndex });
        slots.push({
            kind: "into",
            // The section's end; a heading with no body ends right after
            // its own line (so "into" an empty section drops just below it).
            pos: findHeadingFoldRange(doc, heading.pos, heading.level)?.to ?? heading.pos + node.nodeSize,
            tocIndex: topIndex,
            headingPos: heading.pos,
        });
        topIndex++;
    }
    if (topIndex === 0) {
        return [];
    }
    slots.push({ kind: "gap", pos: doc.content.size, tocIndex: topIndex });
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
 * slots, or when the winning slot's pos falls inside the dragged range
 * (self/descendant drop — the put-it-back gesture, mirroring dropTargetFor).
 */
export function tocDropTargetFor(
    slots: readonly MeasuredTocSlot[],
    pointerY: number,
    range: { from: number; to: number },
    opts: { allowInto: boolean },
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
        return null;
    }
    return winner;
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
