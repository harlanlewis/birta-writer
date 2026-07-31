/**
 * plugins/pasteContainerFit.ts — fitting a paste to the container it lands in
 * (MAR-274, MAR-277, MAR-278).
 *
 * A GFM table cell holds INLINE content only: there is no syntax for a list, a
 * heading, or a nested table inside one. Pasting anything block-shaped into a
 * cell therefore had no good landing place, and both paste paths mangled the
 * table rather than the payload:
 *
 *   - the literal path (ProseMirror's default) splits clipboard text into one
 *     paragraph per line, and each of those became its own CELL — pasting two
 *     lines into a 2-column table widened it to 5 columns and shifted the
 *     original content right;
 *   - the Markdown path (plugins/pasteMarkdown.ts) produced real block nodes,
 *     which ProseMirror could not fit into a cell at all, so it split the table
 *     into three fragments to place them.
 *
 * This flattens the pasted slice to inline content whenever the paste lands
 * inside a cell, joining each source block with a hard break — which is exactly
 * how a multi-line cell is written by hand, and round-trips as `<br>` through
 * the tableBreaks pipeline (MAR-17). The table keeps its shape; the payload
 * keeps its words.
 *
 * `transformPasted` is the seam because it is the LAST step of
 * parseFromClipboard, after the clipboardTextParser/DOM-parser split has
 * already happened — so one implementation covers the Markdown path, the
 * literal path, Shift+Cmd+V, and a rich-HTML paste alike, instead of four.
 *
 * Two deliberate non-targets:
 *   - a CellSelection paste, which is prosemirror-tables replacing whole cells
 *     with a copied table region — a table-level operation this must not touch;
 *   - a slice that is already a single open textblock, i.e. the ordinary
 *     inline paste, which needs no help and whose open depths are load-bearing.
 */
import { $prose } from "@milkdown/utils";
import { CellSelection, Fragment, Plugin, Slice } from "@/pm";
import type { Node as ProseNode, Schema } from "@/pm";

/** Is this position inside a table cell (at any depth)? */
export function isInTableCell($pos: { depth: number; node(d: number): ProseNode }): boolean {
    for (let d = $pos.depth; d > 0; d--) {
        const name = $pos.node(d).type.name;
        if (name === "table_cell" || name === "table_header") { return true; }
    }
    return false;
}

/**
 * Containers whose Markdown form is ONE LINE, so a raw newline inside them ends
 * the construct rather than wrapping within it: a table row is terminated by
 * it, and an ATX heading simply stops. Both can still carry an explicit `<br>`.
 *
 * The table cell was found first (MAR-277); the heading is the same defect in a
 * different container — `## A⏎B` reopens as a heading followed by a paragraph —
 * and was found by the paste matrix precisely because the matrix enumerates
 * contexts instead of relying on anyone remembering this one.
 */
function isSingleLineContainer($pos: { depth: number; node(d: number): ProseNode }): boolean {
    if (isInTableCell($pos)) { return true; }
    for (let d = $pos.depth; d > 0; d--) {
        if ($pos.node(d).type.name === "heading") { return true; }
    }
    return false;
}

/**
 * A hard break that a table cell can actually hold.
 *
 * A `hardbreak` carries `isInline` (MAR-17): true means "a SOFT break in the
 * source" and serializes as a literal newline; false means the `<br>` form. A
 * raw newline cannot exist inside a GFM table row — it terminates the row — so
 * a soft break pasted into a cell produced `| line1⏎line2 |`, which is not a
 * table at all. Inside a cell every break must therefore be the `<br>` form,
 * whatever it was in the source it came from.
 */
function cellBreak(node: ProseNode): ProseNode {
    return node.attrs["isInline"]
        ? node.type.create({ ...node.attrs, isInline: false }, node.content, node.marks)
        : node;
}

/** Rewrites every hardbreak in a fragment to the cell-safe `<br>` form. */
function withCellBreaks(fragment: Fragment): Fragment {
    const mapped: ProseNode[] = [];
    let changed = false;
    fragment.forEach((node) => {
        if (node.type.name === "hardbreak") {
            const safe = cellBreak(node);
            if (safe !== node) { changed = true; }
            mapped.push(safe);
            return;
        }
        if (node.content.size > 0) {
            const inner = withCellBreaks(node.content);
            if (inner !== node.content) {
                changed = true;
                mapped.push(node.copy(inner));
                return;
            }
        }
        mapped.push(node);
    });
    return changed ? Fragment.fromArray(mapped) : fragment;
}

/**
 * Collects the inline content of every textblock in `fragment`, in document
 * order, with one hard break between consecutive non-empty blocks. Containers
 * (lists, quotes, nested tables) are walked through; their markers are
 * structure, not text, and a cell cannot carry them.
 */
function inlineRuns(fragment: Fragment, out: ProseNode[][]): void {
    fragment.forEach((node) => {
        if (node.isInline) {
            // Bare inline content (an open slice's loose text) continues the
            // run in progress rather than starting a new line.
            if (out.length === 0) { out.push([]); }
            out[out.length - 1]!.push(node.type.name === "hardbreak" ? cellBreak(node) : node);
            return;
        }
        if (node.isTextblock) {
            const run: ProseNode[] = [];
            node.content.forEach((child) =>
                run.push(child.type.name === "hardbreak" ? cellBreak(child) : child));
            if (run.length > 0) { out.push(run); }
            return;
        }
        inlineRuns(node.content, out);
    });
}

/**
 * The flattened inline form of a pasted slice, or null when there is nothing
 * to flatten (no text at all — e.g. a lone horizontal rule), in which case the
 * caller leaves the original slice alone.
 */
export function flattenSliceToInline(slice: Slice, schema: Schema): Slice | null {
    const runs: ProseNode[][] = [];
    inlineRuns(slice.content, runs);
    if (runs.length === 0) { return null; }

    const hardbreak = schema.nodes["hardbreak"];
    const nodes: ProseNode[] = [];
    runs.forEach((run, i) => {
        if (i > 0 && hardbreak) { nodes.push(hardbreak.create()); }
        nodes.push(...run);
    });
    // Closed on both sides: the content is already inline, so it merges into
    // the cell's paragraph without ProseMirror re-opening a block wrapper.
    return new Slice(Fragment.fromArray(nodes), 0, 0);
}

/** True for the ordinary inline paste, which must pass through untouched. */
function isPlainInlinePaste(slice: Slice): boolean {
    if (slice.content.childCount !== 1) { return false; }
    const only = slice.content.firstChild;
    return !!only && only.isTextblock && only.type.name === "paragraph"
        && slice.openStart > 0 && slice.openEnd > 0;
}

export const pasteContainerFitPlugin = $prose(() =>
    new Plugin({
        props: {
            transformPasted(slice, view) {
                const { selection } = view.state;
                if (selection instanceof CellSelection) { return slice; }
                // Every single-line container needs its breaks made safe; only a
                // table CELL additionally needs block content flattened, since a
                // heading's own schema already refuses blocks.
                if (isSingleLineContainer(selection.$from) && !isInTableCell(selection.$from)) {
                    const safe = withCellBreaks(slice.content);
                    return safe === slice.content
                        ? slice
                        : new Slice(safe, slice.openStart, slice.openEnd);
                }
                if (!isInTableCell(selection.$from)) { return slice; }
                // Even a paste that needs no flattening needs its breaks made
                // cell-safe: a single newline between two pasted lines is a
                // SOFT break, which serializes as a raw newline and would
                // terminate the table row.
                if (isPlainInlinePaste(slice)) {
                    const safe = withCellBreaks(slice.content);
                    return safe === slice.content
                        ? slice
                        : new Slice(safe, slice.openStart, slice.openEnd);
                }
                return flattenSliceToInline(slice, view.state.schema) ?? slice;
            },
        },
    }));
