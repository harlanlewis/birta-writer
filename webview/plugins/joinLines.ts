/**
 * plugins/joinLines.ts — Join Lines (MAR-96, VS Code `editor.action.joinLines`
 * parity, adapted to blocks).
 *
 * Reachable from the command palette everywhere and Ctrl+J on macOS (a
 * contributed, rebindable keybinding in package.json — no ProseMirror keymap
 * here). Unbound on Windows/Linux, exactly like the built-in editor.
 *
 * Semantics — a "line" is a soft line: a hardbreak-separated run inside a
 * textblock, or the textblock itself:
 *
 *   - Caret: remove the line seam nearest AFTER the caret. A hardbreak later
 *     in the same textblock wins over the block boundary (VS Code removes the
 *     break at the end of the current line); otherwise the next joinable
 *     textblock's inline content is pulled up into this one. Whitespace at
 *     the seam collapses to exactly one space — no space at all when either
 *     side of the seam is an empty line (VS Code: "foo" + "" joins to "foo").
 *     Marks travel untouched; the seam space inherits the marks left of the
 *     seam. The caret lands at the seam.
 *   - Selection: every seam inside the selection is joined (all covered
 *     textblocks and soft lines become one line); a selection containing no
 *     seam falls back to the caret behavior from its end, like VS Code's
 *     single-line selection. The selection survives, mapped over the result.
 *   - Structure: sibling list items merge — the following item's leading
 *     paragraph is pulled up and the item goes away (any children it had are
 *     adopted); a paragraph directly after a list joins into the last item.
 *     Non-text targets (code fence, table, HR, image-only paragraph, math
 *     block, nested lists, blockquotes) refuse with `false` — never
 *     destructive. All-or-nothing: an unjoinable seam anywhere in the
 *     selection means no change at all.
 *   - One gesture = one undo step (single transaction, single dispatch).
 */
import type { Node as PMNode, ResolvedPos } from "@milkdown/prose/model";
import { TextSelection, type Command, type Transaction } from "@milkdown/prose/state";

const HARDBREAK = "hardbreak";

/** A join seam: delete [a, b) (the seam plus surrounding whitespace), then
 *  optionally insert a single space at `a`. */
interface Seam {
    a: number;
    b: number;
    space: boolean;
}

function isWhitespaceChar(doc: PMNode, pos: number): boolean {
    const ch = doc.textBetween(pos, pos + 1);
    return ch.length === 1 && /\s/.test(ch);
}

/** True for inline content with children but no text at all (image-only). */
function isTextless(block: PMNode): boolean {
    if (block.childCount === 0) {
        return false; // empty is fine to join (it just vanishes)
    }
    let hasText = false;
    block.forEach((child) => {
        if (child.isText) {
            hasText = true;
        }
    });
    return !hasText;
}

/** Textblocks whose inline content may be pulled up by a join. */
function isJoinableTextblock(node: PMNode): boolean {
    return (
        node.isTextblock &&
        !node.type.spec.code &&
        (node.type.name === "paragraph" || node.type.name === "heading") &&
        !isTextless(node)
    );
}

type JoinTarget = { contentStart: number; contentEnd: number };

/**
 * The textblock a join at the end of the block around `$end` would pull up:
 * the nearest following sibling at any ancestor level (climbing out of list
 * items, lists, and quotes when the current block is their last child).
 * Returns "blocked" when that sibling exists but is not joinable, and null
 * when nothing follows at all (last block of the document).
 */
function nextJoinTarget($end: ResolvedPos): JoinTarget | "blocked" | null {
    for (let level = $end.depth; level >= 1; level--) {
        const container = $end.node(level - 1);
        const index = $end.index(level - 1);
        if (index + 1 >= container.childCount) {
            continue; // last child at this level — climb out
        }
        const sibling = container.child(index + 1);
        const siblingPos = $end.posAtIndex(index + 1, level - 1);
        if (isJoinableTextblock(sibling)) {
            return {
                contentStart: siblingPos + 1,
                contentEnd: siblingPos + 1 + sibling.content.size,
            };
        }
        if (sibling.type.name === "list_item") {
            // The following item's leading paragraph merges up; deleting
            // across the item boundary makes the item go away (ProseMirror
            // adopts any remaining children into the current item).
            const first = sibling.firstChild;
            if (first && first.type.name === "paragraph" && !isTextless(first)) {
                return {
                    contentStart: siblingPos + 2,
                    contentEnd: siblingPos + 2 + first.content.size,
                };
            }
        }
        return "blocked"; // code fence, table, HR, image-only, math, nested list, …
    }
    return null;
}

/**
 * Build a seam over [rawA, rawB), widening it over whitespace on both sides
 * (never past the current block's content start `leftMin` nor the target's
 * content end `rightMax`). The seam gets a single space unless the line on
 * either side of it is empty.
 */
function makeSeam(doc: PMNode, rawA: number, rawB: number, leftMin: number, rightMax: number): Seam {
    let a = rawA;
    while (a > leftMin && isWhitespaceChar(doc, a - 1)) {
        a--;
    }
    let b = rawB;
    while (b < rightMax && isWhitespaceChar(doc, b)) {
        b++;
    }
    const leftEmpty = a === leftMin || doc.resolve(a).nodeBefore?.type.name === HARDBREAK;
    const rightEmpty = b === rightMax || doc.resolve(b).nodeAfter?.type.name === HARDBREAK;
    return { a, b, space: !leftEmpty && !rightEmpty };
}

/**
 * The nearest seam at/after `anchor` (which must sit inside a textblock):
 * the first hardbreak after it in the same textblock, else the boundary to
 * the next joinable block. With a `limit` (selection end), only seams the
 * selection reaches count — past-limit seams report null ("no seam here"),
 * an unjoinable neighbor reports "blocked".
 */
function seamAfter(doc: PMNode, anchor: number, limit: number | null): Seam | "blocked" | null {
    const $anchor = doc.resolve(anchor);
    const block = $anchor.parent;
    if (!block.isTextblock || block.type.spec.code) {
        return "blocked"; // caret in a code fence / math block / non-text spot
    }
    const contentStart = $anchor.start();
    const contentEnd = $anchor.end();
    let breakPos = -1;
    block.forEach((child, offset) => {
        if (breakPos >= 0) {
            return;
        }
        const pos = contentStart + offset;
        if (child.type.name === HARDBREAK && pos >= anchor) {
            breakPos = pos;
        }
    });
    if (breakPos >= 0) {
        if (limit !== null && breakPos >= limit) {
            return null; // the break sits past the selection
        }
        return makeSeam(doc, breakPos, breakPos + 1, contentStart, contentEnd);
    }
    if (limit !== null && limit <= contentEnd + 1) {
        return null; // the selection does not reach past this block
    }
    const target = nextJoinTarget(doc.resolve(contentEnd));
    if (target === null || target === "blocked") {
        return target;
    }
    return makeSeam(doc, contentEnd, target.contentStart, contentStart, target.contentEnd);
}

/** Delete the seam and insert its space, giving the space only the marks that
 *  run CONTINUOUSLY across the seam — those present on the text node on both
 *  sides. Inheriting the left side's marks unconditionally pulled the space
 *  into a run that ends at the seam: a link or inline-code left line rewrote
 *  the saved markdown (`[foo](url)` + `bar` → `[foo ](url)bar`; `` `foo` `` +
 *  `bar` → `` `foo `bar ``), a phase-0 fidelity break. (This schema sets no
 *  `inclusive: false` on link/code, so the marks() boundary convention can't
 *  be relied on; the intersection is the schema-independent rule.) Emphasis
 *  that genuinely spans both lines still carries the space. */
function applySeam(tr: Transaction, seam: Seam): void {
    tr.delete(seam.a, seam.b);
    if (seam.space) {
        const $seam = tr.doc.resolve(seam.a);
        const left = $seam.nodeBefore?.marks ?? [];
        const right = $seam.nodeAfter?.marks;
        const marks = right ? left.filter((m) => m.isInSet(right)) : [];
        tr.insert(seam.a, tr.doc.type.schema.text(" ", marks));
    }
}

/** Descend from a block boundary to the content start of the first textblock. */
function descendToTextblock(doc: PMNode, pos: number): number | null {
    const $pos = doc.resolve(pos);
    if ($pos.parent.isTextblock) {
        return pos;
    }
    let node = $pos.nodeAfter;
    let at = pos;
    while (node && !node.isTextblock) {
        at += 1;
        node = node.firstChild;
    }
    return node ? at + 1 : null; // null: a leaf (HR, table cell chrome, …)
}

/** Join the next line/block onto the current one (single undo step). */
export const joinLinesCommand: Command = (state, dispatch) => {
    const sel = state.selection;
    const origFrom = sel.from;
    const origTo = sel.to;
    const tr = state.tr;
    let joins = 0;
    let caretSeamA: number | null = null;

    if (!sel.empty) {
        // Join every seam the selection covers, left to right (sequential,
        // like VS Code — an empty covered line still yields one space between
        // its neighbors). All positions are re-derived from tr.doc each step.
        let anchor = descendToTextblock(state.doc, origFrom);
        if (anchor === null) {
            return false; // selection starts on a non-text leaf (HR, …)
        }
        for (let guard = 0; guard < 10_000; guard++) {
            const limit = tr.mapping.map(origTo, -1);
            if (anchor >= limit) {
                break;
            }
            const seam = seamAfter(tr.doc, anchor, limit);
            if (seam === "blocked") {
                return false; // all-or-nothing: never a partial join
            }
            if (seam === null) {
                break;
            }
            applySeam(tr, seam);
            anchor = seam.a + (seam.space ? 1 : 0);
            joins++;
        }
    }

    if (joins === 0) {
        // Caret — or a selection containing no seam (VS Code joins the next
        // line anyway): join the single nearest seam after it.
        let start = sel.empty ? origFrom : tr.mapping.map(origTo, -1);
        const $start = tr.doc.resolve(start);
        if (!$start.parent.isTextblock) {
            if ($start.nodeBefore?.isTextblock) {
                start -= 1; // block-range end boundary → inside the block
            } else {
                return false;
            }
        }
        const seam = seamAfter(tr.doc, start, null);
        if (seam === null || seam === "blocked") {
            return false; // last block, or an unjoinable neighbor
        }
        applySeam(tr, seam);
        caretSeamA = seam.a;
        joins++;
    }

    if (dispatch) {
        if (sel.empty && caretSeamA !== null) {
            // VS Code: the caret lands at the seam (before the seam space).
            tr.setSelection(TextSelection.create(tr.doc, caretSeamA));
        } else {
            tr.setSelection(TextSelection.between(
                tr.doc.resolve(tr.mapping.map(origFrom, 1)),
                tr.doc.resolve(tr.mapping.map(origTo, -1)),
            ));
        }
        dispatch(tr.scrollIntoView());
    }
    return true;
};
