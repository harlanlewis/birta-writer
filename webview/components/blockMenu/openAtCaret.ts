/**
 * webview/components/blockMenu/openAtCaret.ts
 *
 * Keyboard path into the gutter block menu (birta.editor.
 * openBlockMenu — the mouse path is clicking a gutter marker).
 *
 * Resolves the caret (or a block-range selection's head) to the block that
 * owns a gutter marker — the same unit semantics the gutter renders: the
 * innermost list item in lists, a nested container child with its own
 * marker, otherwise the top-level block — then opens the menu anchored to
 * that marker, in keyboard mode (Escape returns focus to the marker).
 *
 * This never touches the handles-quiet reveal state: markers are hidden via
 * opacity only (geometry intact, so the menu positions off the anchor rect
 * regardless), and openBlockMenu's --menu-open class is excluded from every
 * hide rule — the anchor surfaces on its own without flashing the rest of
 * the gutter back in mid-typing.
 */
import type { EditorView } from "../../pm";
import { CellSelection, NodeSelection } from "../../pm";
import { blockMarkerElements, isListNode } from "../../plugins/headingFold";
import { openBlockMenu } from "./menu";

/** The block position a marker's gutter widget belongs to (the widget sits
 * at blockPos + 1 — gutterBlockPos's rule, read from the marker's parent). */
function markerBlockPos(view: EditorView, marker: HTMLElement): number | null {
    const gutter = marker.parentElement;
    if (!gutter) {
        return null;
    }
    try {
        return view.posAtDOM(gutter, 0) - 1;
    } catch {
        return null;
    }
}

/**
 * Open the block menu anchored to the caret's block. Returns whether a menu
 * was opened — false (no dispatch, no error) when no block in the caret's
 * ancestor chain carries a gutter marker.
 */
export function openBlockMenuAtCaret(view: EditorView): boolean {
    const { selection } = view.state;
    const $head = selection.$head;

    // A caret INSIDE a table opens the table's menu CARRYING the caret's
    // cell (MAR-118): the menu's Table section then targets the same
    // row/column unit a right-click on that cell would, so ⌘. never yanks
    // scope out to the whole table silently (the escalateSelectAll
    // precedent — the cell rows lead, the table-block actions follow). A
    // table selected from the OUTSIDE still reaches its marker via the
    // depth-0 branch, with no cell to carry. Innermost table wins for the
    // (pathological) nested case; a CellSelection's $head resolves BEFORE
    // its head cell, so step inside it — tableCmd's cellAround needs a
    // position the cell is an ancestor of.
    let tableCell: { tablePos: number; cellPos: number } | null = null;
    for (let depth = $head.depth; depth > 0; depth--) {
        if ($head.node(depth).type.name === "table") {
            tableCell = {
                tablePos: $head.before(depth),
                cellPos: selection instanceof CellSelection
                    ? selection.$headCell.pos + 1
                    : $head.pos,
            };
            break;
        }
    }

    // Candidate block positions, innermost-first: each ancestor block down
    // to the top level. The first whose DOM carries its OWN gutter marker is
    // the unit the gutter itself targets — a list caret hits the innermost
    // item, a quoted paragraph falls through to its blockquote (nested text
    // paragraphs render no marker: the container is their handle), a nested
    // heading/code block anchors to its own badge.
    const candidates: number[] = [];
    // A node selection names its block outright, so it is the innermost
    // candidate. The ancestor walk below cannot reach it: $head sits AFTER
    // the selected node, so for a code block or table nested inside a
    // callout, $head's chain starts at the callout and the menu would open
    // on the container rather than the block the user selected.
    if (selection instanceof NodeSelection) {
        candidates.push(selection.from);
    }
    for (let depth = $head.depth; depth >= 1; depth--) {
        candidates.push($head.before(depth));
    }
    if (candidates.length === 0) {
        // Depth-0 head (block-range / node selection, gap cursor): the block
        // the head touches — behind it for a forward selection (the head sits
        // at the range's END, so its block is the one just before), otherwise
        // the one after.
        const forward = selection.head >= selection.anchor;
        const before = $head.nodeBefore;
        const after = $head.nodeAfter;
        if (forward && before) {
            candidates.push($head.pos - before.nodeSize);
        } else if (after) {
            candidates.push($head.pos);
        } else if (before) {
            candidates.push($head.pos - before.nodeSize);
        }
    }

    for (const pos of candidates) {
        const dom = view.nodeDOM(pos);
        if (!(dom instanceof HTMLElement)) {
            continue;
        }
        // Ownership check via position round-trip (never "first marker in
        // subtree"): a container's DOM also holds its children's markers.
        // blockMarkerElements, not a bare querySelectorAll: a leaf atom's
        // gutter (a rule, an mdx island) is its next sibling, not its child.
        for (const marker of blockMarkerElements(dom)) {
            if (markerBlockPos(view, marker) === pos) {
                openBlockMenu(
                    view,
                    pos,
                    marker,
                    /* viaKeyboard */ true,
                    // The caret's cell rides along only when THIS block is
                    // the table that holds it — a table nested in a marker-
                    // owning container must not leak its cell onto the
                    // container's menu.
                    tableCell && tableCell.tablePos === pos
                        ? { cellPos: tableCell.cellPos }
                        : undefined,
                );
                return true;
            }
        }
        // A LIST node carries no marker of its own — its items do (gutter
        // unit semantics). A depth-0 candidate can be a whole list (block
        // range / node selection over it): fall back to the head-side ITEM —
        // the last item when the block sits behind the head (forward
        // selection), the first when it sits after (backward).
        const node = view.state.doc.nodeAt(pos);
        if (node && isListNode(node)) {
            const useLast = pos < selection.head;
            const item = useLast ? node.lastChild : node.firstChild;
            if (item) {
                const itemPos = useLast ? pos + node.nodeSize - 1 - item.nodeSize : pos + 1;
                for (const marker of dom.querySelectorAll<HTMLElement>(".heading-fold-marker")) {
                    if (markerBlockPos(view, marker) === itemPos) {
                        openBlockMenu(view, itemPos, marker, /* viaKeyboard */ true);
                        return true;
                    }
                }
            }
        }
    }
    return false;
}
