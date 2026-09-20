/**
 * plugins/blockRange.ts — a real block-range Selection type (MAR-82).
 *
 * A `BlockRangeSelection` spans a contiguous run of WHOLE top-level blocks,
 * anchor/head at depth-0 boundaries. Compared to the TextSelection.between
 * approximation it replaces, leaf blocks (horizontal rules, image
 * paragraphs, empty paragraphs) participate instead of being snapped past,
 * `content()` is a closed slice (openStart/openEnd 0 — native copy and
 * replace treat it as whole blocks, never splicing text), and the browser
 * paints nothing (`visible = false`; the selection-cover veil is the one
 * visual language for "these blocks are included").
 *
 * Modeled on Tiptap's extension-node-range / BlockNote's
 * MultipleNodeSelection (both MIT), simplified to the single-range
 * contiguous case — no product has coherent drop semantics for
 * non-contiguous, so neither do we.
 */
import type { Node as ProseNode, ResolvedPos } from "../pm";
import type { Mappable } from "../pm";
import { Selection } from "../pm";

/** Snap `pos` to the start boundary of the top-level block containing it. */
function snapStart(doc: ProseNode, pos: number): number {
    const clamped = Math.max(0, Math.min(pos, doc.content.size));
    const $pos = doc.resolve(clamped);
    return $pos.depth === 0 ? clamped : $pos.before(1);
}

/** Snap `pos` to the end boundary of the top-level block containing it. */
function snapEnd(doc: ProseNode, pos: number): number {
    const clamped = Math.max(0, Math.min(pos, doc.content.size));
    const $pos = doc.resolve(clamped);
    return $pos.depth === 0 ? clamped : $pos.after(1);
}

export class BlockRangeSelection extends Selection {
    /**
     * Where the caret was before the keyboard grew this range, so Escape can
     * put it back (MAR-461). Null for a range the keyboard did not make (the
     * marquee, a drag handle, a block move), which collapses to its start as
     * it always did. Provenance rather than extent: `eq` ignores it, because
     * "already everything" is a question about which blocks are covered, and
     * a range that differs only in where it came from is the same range.
     */
    readonly origin: number | null;

    constructor($anchor: ResolvedPos, $head: ResolvedPos, origin: number | null = null) {
        super($anchor, $head);
        this.origin = origin;
    }

    override map(doc: ProseNode, mapping: Mappable): Selection {
        const origin = this.origin === null ? null : mapping.map(this.origin);
        return (
            BlockRangeSelection.tryCreate(doc, mapping.map(this.anchor), mapping.map(this.head), origin) ??
            Selection.near(doc.resolve(Math.max(0, Math.min(mapping.map(this.head), doc.content.size))))
        );
    }

    override eq(other: Selection): boolean {
        return (
            other instanceof BlockRangeSelection &&
            other.anchor === this.anchor &&
            other.head === this.head
        );
    }

    override toJSON(): { type: string; anchor: number; head: number; origin?: number } {
        return this.origin === null
            ? { type: "blockRange", anchor: this.anchor, head: this.head }
            : { type: "blockRange", anchor: this.anchor, head: this.head, origin: this.origin };
    }

    override getBookmark(): BlockRangeBookmark {
        return new BlockRangeBookmark(this.anchor, this.head, this.origin);
    }

    static override fromJSON(doc: ProseNode, json: { anchor?: unknown; head?: unknown; origin?: unknown }): Selection {
        if (typeof json.anchor !== "number" || typeof json.head !== "number") {
            throw new RangeError("Invalid input for BlockRangeSelection.fromJSON");
        }
        const origin = typeof json.origin === "number" ? json.origin : null;
        return (
            BlockRangeSelection.tryCreate(doc, json.anchor, json.head, origin) ??
            Selection.near(doc.resolve(Math.max(0, Math.min(json.head, doc.content.size))))
        );
    }

    /**
     * A block range whose boundaries snap outward to whole top-level blocks;
     * `anchor`/`head` order is preserved (a backward range keeps its anchor
     * at the bottom, so Shift+arrow extension honors direction). Null when
     * the snapped range contains no block (both positions at the same
     * boundary, or an empty doc). `origin` is carried, never snapped: it is
     * a caret position, not a boundary.
     */
    static tryCreate(doc: ProseNode, anchor: number, head: number, origin: number | null = null): BlockRangeSelection | null {
        const backward = head < anchor;
        const from = snapStart(doc, backward ? head : anchor);
        const to = snapEnd(doc, backward ? anchor : head);
        if (to <= from) {
            return null;
        }
        const $anchor = doc.resolve(backward ? to : from);
        const $head = doc.resolve(backward ? from : to);
        return new BlockRangeSelection($anchor, $head, origin);
    }
}

// The browser paints nothing for a block range (ProseMirror stamps
// .ProseMirror-hideselection on the root); the covered-range veil is the
// visual. Same prototype-level assignment NodeSelection itself uses — the
// d.ts declares `visible` as a plain property, so an accessor override is
// rejected (TS2611).
(BlockRangeSelection.prototype as { visible: boolean }).visible = false;

// Guarded: prosemirror-state keeps ONE process-global jsonID registry, but a
// fresh module graph (vi.resetModules() test harnesses) re-evaluates this
// module and would throw a duplicate-registration RangeError. Losing the
// re-registration is harmless — deserialization falls back to the first
// instance's class, and fold/selection state is view-only anyway.
try {
    Selection.jsonID("blockRange", BlockRangeSelection);
} catch {
    // already registered by a previous instance of this module
}

/**
 * History bookmark: prosemirror-history stores one per undo step, so a
 * block range survives undo/redo the way text selections do — mapped
 * through edits, degraded to a nearby caret only when its blocks are gone.
 */
export class BlockRangeBookmark {
    constructor(
        readonly anchor: number,
        readonly head: number,
        readonly origin: number | null = null,
    ) {}

    map(mapping: Mappable): BlockRangeBookmark {
        return new BlockRangeBookmark(
            mapping.map(this.anchor),
            mapping.map(this.head),
            this.origin === null ? null : mapping.map(this.origin),
        );
    }

    resolve(doc: ProseNode): Selection {
        return (
            BlockRangeSelection.tryCreate(doc, this.anchor, this.head, this.origin) ??
            Selection.near(doc.resolve(Math.max(0, Math.min(this.head, doc.content.size))))
        );
    }
}
