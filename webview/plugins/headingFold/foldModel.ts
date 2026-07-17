/**
 * webview/plugins/headingFold/foldModel.ts
 *
 * The fold layer's pure model: node-kind predicates, the rank-derived
 * section-range computation, the hidden-range/occupancy queries every
 * consumer shares (caret guard, drag slot filter, move primitive, drop
 * gates), and the visible-content guards the plugin's apply() consumes.
 * No DOM and no decoration work lives here — everything below answers
 * questions about a document (plus the fold plugin's state), so every other
 * layer (persistence, gutter DOM, decorations, commands, the plugin itself)
 * can build on it without cycling.
 */
import type { EditorView } from "@milkdown/prose/view";
import type { Node as ProseMirrorNode } from "@milkdown/prose/model";
import {
    Selection,
    TextSelection,
    type EditorState,
    type Transaction,
} from "@milkdown/prose/state";
import { foldPluginKey } from "../foldState";

export type HeadingFoldRange = { from: number; to: number };

type ProseNodeLike = {
    type: { name: string };
    attrs?: Record<string, unknown>;
    nodeSize: number;
};

export function isHeadingNode(node: ProseNodeLike | null | undefined): node is ProseNodeLike {
    return node?.type.name === "heading";
}

export function isCalloutNode(node: { type: { name: string } } | null | undefined): boolean {
    return node?.type.name === "callout";
}

export function isTableNode(node: { type: { name: string } } | null | undefined): boolean {
    return node?.type.name === "table";
}

export function isCodeBlockNode(node: { type: { name: string } } | null | undefined): boolean {
    return node?.type.name === "code_block";
}

export function isListItemNode(node: { type: { name: string } } | null | undefined): boolean {
    return node?.type.name === "list_item";
}

/** Whether any ancestor of `pos` is a list item — the chrome-parity gate
 * shared by callouts, tables, and code blocks (see isFoldableCallout). */
function hasListItemAncestor(doc: any, pos: number): boolean {
    const $pos = doc.resolve(pos);
    for (let depth = $pos.depth; depth > 0; depth--) {
        if ($pos.node(depth).type.name === "list_item") {
            return true;
        }
    }
    return false;
}

/**
 * A list item folds to its FIRST LINE (heading-section semantics applied to
 * list nesting, MAR-125): foldable only when it owns anything beyond its
 * first child block — nested sub-lists, continuation blocks. Siblings are
 * never affected; a leaf item shows no chevron (mirroring how a heading
 * without a body isn't foldable).
 */
export function listItemHasDescendants(node: { childCount: number }): boolean {
    return node.childCount > 1;
}

/** Whether a table has any REAL body row. The gfm schema pads a header-only
 * markdown table with one empty, cell-less `table_row` (nodeSize 2), so
 * childCount alone over-reports — require a body row that carries cells. */
export function tableHasBody(node: { childCount: number; child(i: number): { childCount: number } }): boolean {
    for (let i = 1; i < node.childCount; i++) {
        if (node.child(i).childCount > 0) {
            return true;
        }
    }
    return false;
}

/** A table folds to its HEADER ROW: foldable when body rows exist. Same
 * list-item chrome-parity gate as callouts (no gutter → no invisible fold). */
function isFoldableTable(doc: any, pos: number, node: any): boolean {
    return isTableNode(node) && tableHasBody(node) && !hasListItemAncestor(doc, pos);
}

/** A code block (plain fence, math, mermaid) folds to its chrome/header row:
 * foldable when it has any content. Same chrome-parity gate as callouts. */
function isFoldableCodeBlock(doc: any, pos: number, node: any): boolean {
    return isCodeBlockNode(node) && node.content.size > 0 && !hasListItemAncestor(doc, pos);
}

/** Every node kind the fold plugin may own an entry for (MAR-110 + MAR-125). */
export function isFoldableKindNode(node: any): boolean {
    return (
        isHeadingNode(node) ||
        isCalloutNode(node) ||
        isListItemNode(node) ||
        isTableNode(node) ||
        isCodeBlockNode(node)
    );
}

/**
 * A callout is foldable whenever it has a body (MAR-110 — no longer only
 * when the source carries a `+`/`-` marker): anything beyond one empty
 * paragraph counts.
 */
export function calloutHasBody(node: { childCount: number; firstChild: { childCount: number } | null }): boolean {
    return !(node.childCount === 1 && (node.firstChild?.childCount ?? 0) === 0);
}

/**
 * THE foldable-callout invariant, shared by every layer that can create or
 * honor a callout fold (the meta guards in apply(), Fold All, fold-at-caret,
 * persistence restore, syntax seeding, and — via foldHiddenRange — the caret
 * guard and drop guards): a callout nested inside a list item is NOT
 * foldable. The decoration pass renders fold chrome only for top-level
 * blocks and container children (emitContainerChildGutters); list-item
 * children go through emitItemGutters, which has no fold context, so a fold
 * entry there would hide nothing visibly while the caret guard ejected
 * carets from the "hidden" body and drop guards vetoed the region — an
 * invisible fold, unrecoverable by undo (fold metas are history-exempt).
 * Feature-completing this (threading fold context through emitItemGutters)
 * is the future alternative to the restriction.
 */
export function isFoldableCallout(doc: any, pos: number, node: any): boolean {
    return isCalloutNode(node) && calloutHasBody(node) && !hasListItemAncestor(doc, pos);
}

/** A heading NODE's level attr (the DOM-element twin lives in utils/headingUtils). */
export function getHeadingLevel(node: { attrs?: Record<string, unknown> }): number {
    const level = node.attrs?.["level"];
    return typeof level === "number" ? level : 1;
}

/**
 * Retype the block at `headingPos` to a heading of `level` (1–6), or to a
 * paragraph when `level` is 0. Accepts a heading OR a paragraph (the paragraph
 * gutter promotes P → Hn; the heading gutter goes both ways). Targets the node
 * BY POSITION, not the current selection, so the gutter menu can change a block
 * the caret isn't inside. Heading→heading preserves the node's other attrs
 * (e.g. the TOC-anchor id); →paragraph drops them. Returns false when the
 * position isn't a retypeable block or the change is a no-op (same level).
 * Exported for unit testing.
 */
export function setHeadingLevelAt(view: EditorView, headingPos: number, level: number): boolean {
    const node = view.state.doc.nodeAt(headingPos);
    const isParagraph = node?.type.name === "paragraph";
    if (!isHeadingNode(node) && !isParagraph) {
        return false;
    }
    const schema = view.state.schema;
    if (level <= 0) {
        if (isParagraph) {
            return false; // already a paragraph — no-op
        }
        const paragraph = schema.nodes["paragraph"];
        if (!paragraph) {
            return false;
        }
        view.dispatch(view.state.tr.setNodeMarkup(headingPos, paragraph, null));
    } else {
        const heading = schema.nodes["heading"];
        if (!heading) {
            return false;
        }
        const clamped = Math.min(Math.max(Math.round(level), 1), 6);
        if (!isParagraph && getHeadingLevel(node) === clamped) {
            return false;
        }
        const attrs = isParagraph ? { level: clamped } : { ...node.attrs, level: clamped };
        view.dispatch(view.state.tr.setNodeMarkup(headingPos, heading, attrs));
    }
    view.focus();
    return true;
}

/**
 * Fold ranges for EVERY heading in one pass (a stack of open sections): a
 * heading's range runs from just after it to the next heading of the same or
 * higher rank. Null value = the heading owns nothing (not foldable).
 */
export function computeFoldRanges(doc: any): Map<number, HeadingFoldRange | null> {
    const ranges = new Map<number, HeadingFoldRange | null>();
    const open: { pos: number; level: number; from: number }[] = [];
    const closeThrough = (level: number, to: number): void => {
        while (open.length > 0 && open[open.length - 1]!.level >= level) {
            const section = open.pop()!;
            ranges.set(section.pos, section.from < to ? { from: section.from, to } : null);
        }
    };
    doc.forEach((node: any, offset: number) => {
        if (!isHeadingNode(node)) {
            return;
        }
        const level = getHeadingLevel(node);
        closeThrough(level, offset);
        open.push({ pos: offset, level, from: offset + node.nodeSize });
    });
    closeThrough(0, doc.content.size);
    return ranges;
}

/**
 * computeFoldRanges memoized on the doc (ProseMirror docs are immutable, so
 * the doc reference is a perfect cache key). Per-mousemove and per-keystroke
 * callers share one walk per document version instead of each paying their
 * own.
 */
const foldRangesByDoc = new WeakMap<object, Map<number, HeadingFoldRange | null>>();

export function cachedFoldRanges(doc: any): Map<number, HeadingFoldRange | null> {
    let ranges = foldRangesByDoc.get(doc);
    if (!ranges) {
        ranges = computeFoldRanges(doc);
        foldRangesByDoc.set(doc, ranges);
    }
    return ranges;
}

/**
 * The content range ONE heading owns (see computeFoldRanges for the map the
 * decoration pass uses). A direct scan — the block menu / drag handle call
 * this per action, sometimes in loops, so it mustn't build the whole map.
 */
export function findHeadingFoldRange(doc: any, headingPos: number, headingLevel?: number): HeadingFoldRange | null {
    const headingNode = doc.nodeAt(headingPos);
    if (!isHeadingNode(headingNode)) {
        return null;
    }
    const level = headingLevel ?? getHeadingLevel(headingNode);
    const from = headingPos + headingNode.nodeSize;
    let to = doc.content.size;
    doc.forEach((node: any, offset: number) => {
        if (offset <= headingPos || !isHeadingNode(node)) {
            return;
        }
        if (getHeadingLevel(node) <= level && to === doc.content.size) {
            to = offset;
        }
    });
    return from < to ? { from, to } : null;
}

/**
 * If the block at `blockPos` is a COLLAPSED foldable heading, the end of its
 * hidden section — else null. The block keyboard layer and the selection
 * cover use it so an explicit block selection over a folded heading always
 * carries the invisible body (orphaning it would let a move/delete act on
 * content the user can't see).
 */
/**
 * Every collapsed heading's section end in ONE doc pass (computeFoldRanges
 * is a single stack walk) — callers that consult many positions (unit maps,
 * cover expansion) use this instead of per-position foldedSectionEnd, which
 * would re-walk the doc for each collapsed heading.
 */
export function foldedSectionEnds(state: EditorState): ReadonlyMap<number, number> {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState || pluginState.folded.size === 0) {
        return EMPTY_FOLD_MAP;
    }
    const ranges = cachedFoldRanges(state.doc);
    const ends = new Map<number, number>();
    for (const pos of pluginState.folded) {
        const range = ranges.get(pos);
        if (range) {
            ends.set(pos, range.to);
        }
    }
    return ends;
}

const EMPTY_FOLD_MAP: ReadonlyMap<number, number> = new Map();

export function foldedSectionEnd(state: EditorState, blockPos: number): number | null {
    const node = state.doc.nodeAt(blockPos);
    if (!isHeadingNode(node)) {
        return null;
    }
    if (!foldPluginKey.getState(state)?.folded.has(blockPos)) {
        return null;
    }
    return findHeadingFoldRange(state.doc, blockPos)?.to ?? null;
}

/**
 * The content range a fold at `pos` HIDES when collapsed, or null when the
 * block isn't foldable. The kinds differ in where the hidden content lives:
 * a heading hides its following section (blocks OUTSIDE the node); a callout
 * or code block hides its own body (everything INSIDE the node); a list item
 * or table hides everything inside AFTER its first child (the item's first
 * line / the header row stays visible and editable). Everything that needs
 * to reason about invisible content — drop guards, reveal-on-navigate, the
 * caret skip-over — derives from this one map.
 */
export function foldHiddenRange(doc: any, pos: number): HeadingFoldRange | null {
    const node = doc.nodeAt(pos);
    if (isHeadingNode(node)) {
        // Only top-level headings own sections; the ranges map is keyed by
        // top-level offsets, so a nested heading simply misses.
        return cachedFoldRanges(doc).get(pos) ?? null;
    }
    // The isFoldable* predicates exclude list-item-nested callouts/tables/
    // code blocks (no gutter chrome there), so the meta guards, the caret
    // guard, and the drop guards all inherit the state/decoration-parity
    // invariant from this one map.
    if (isFoldableCallout(doc, pos, node)) {
        return { from: pos + 1, to: pos + node.nodeSize - 1 };
    }
    if (isListItemNode(node) && listItemHasDescendants(node)) {
        return { from: pos + 1 + node.firstChild!.nodeSize, to: pos + node.nodeSize - 1 };
    }
    if (isFoldableTable(doc, pos, node)) {
        return { from: pos + 1 + node.firstChild!.nodeSize, to: pos + node.nodeSize - 1 };
    }
    if (isFoldableCodeBlock(doc, pos, node)) {
        return { from: pos + 1, to: pos + node.nodeSize - 1 };
    }
    return null;
}

/** Every currently-hidden range (both kinds), with its owning fold position. */
export function foldedHiddenRanges(
    state: EditorState,
): { pos: number; from: number; to: number }[] {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState || pluginState.folded.size === 0) {
        return [];
    }
    const out: { pos: number; from: number; to: number }[] = [];
    for (const pos of pluginState.folded) {
        const range = foldHiddenRange(state.doc, pos);
        if (range) {
            out.push({ pos, from: range.from, to: range.to });
        }
    }
    return out;
}

/**
 * Whether `target` sits inside content the fold at `range.pos` hides RIGHT
 * NOW — the ONE occupancy rule every consumer shares (the caret skip-over,
 * the drag slot filter, the move primitive, the native-drop guard). The two
 * fold kinds differ at the range's end:
 *   - a HEADING hides FOLLOWING sibling blocks: `to` is the position of the
 *     heading that ends the section, which is visible — half-open;
 *   - a CALLOUT hides its own body: the end-of-body slot at `to` is still
 *     inside the collapsed node — inclusive.
 *
 * Occupancy is NOT a prediction about insertion. A heading's `to` is visible,
 * so the caret may rest there and the drag UI paints a slot — yet content
 * INSERTED there lands INSIDE the section, because the insert pushes the
 * terminating heading later and the rank-derived extent grows over it
 * (MAR-146). Nothing tries to foresee that: `swallowedVisibleContent` sees the
 * section's END grow over the landing and expands the fold (MAR-149), asking
 * the resulting document instead of predicting it.
 *
 * `from`/`to` come from the argument (not re-derived), so callers that map
 * the span through pending steps (contentGuard's drop gate) share the rule.
 */
export function hiddenRangeCoversTarget(
    doc: ProseMirrorNode,
    range: { pos: number; from: number; to: number },
    target: number,
): boolean {
    const halfOpen = isHeadingNode(doc.nodeAt(range.pos));
    return target >= range.from && (halfOpen ? target < range.to : target <= range.to);
}

/**
 * True when a block boundary at `pos` sits inside content a collapsed fold
 * hides — the single target-legality registry (MAR-112). The move primitive
 * (editing/moveBlocks) rejects such targets and the drag UI
 * (visibleBoundaryPositions) never offers them, both through this function,
 * so UI slots and primitive legality cannot drift.
 *
 * Occupancy only: a section's END boundary is visible and stays legal here.
 * Content landed there may still end up inside the fold — that is not refused
 * but revealed, by `swallowedVisibleContent` (MAR-146, MAR-149).
 */
export function isHiddenTargetPos(state: EditorState, pos: number): boolean {
    return foldedHiddenRanges(state).some((range) =>
        hiddenRangeCoversTarget(state.doc, range, pos));
}

/** Whether `pos` holds a block the fold plugin may keep an entry for. */
export function isFoldEntryAt(doc: any, pos: number): boolean {
    return isFoldableKindNode(doc.nodeAt(pos));
}

/**
 * Whether the fold at `oldPos` came out of `tr` hiding content past the END of
 * what it hid before — an edit the user did not frame as a fold growing a
 * collapsed section over its neighbours (MAR-149). Applies MAR-146's principle
 * (content the user can see must not be hidden by an edit that isn't a fold)
 * to the case that principle's per-call-site guards could not reach.
 *
 * A HEADING's extent is DERIVED from ranks, never stored, so an edit that
 * touches no folded content can still grow one: retyping `## Two` to
 * `#### Two` under a collapsed `### Deep` puts Two and its body inside Deep;
 * deleting a terminating heading does the same. The plugin's own bookkeeping
 * cannot notice — the entry maps cleanly and still hides something, so
 * `cleanFoldedPositions` keeps it — and each entry point (the H-badge, the
 * toolbar, `wrapInHeadingCommand`, the `### ` input rule, a native drop) would
 * otherwise need its own guard.
 *
 * Asked of the RESULTING document rather than predicted from the edit: the new
 * extent is compared against where the old one's end actually landed. The
 * `assoc` split is the same one `hiddenRangeCoversTarget` makes, for the same
 * reason — a heading's `to` is the VISIBLE terminating heading, so content
 * inserted there is swallowed and the old end must not follow it (`-1`);
 * the other kinds' `to` is the last position INSIDE the collapsed node, so an
 * append there was never visible and must not cost the user their fold (`+1`).
 *
 * Both ends are checked. A list item's / table's `from` sits AFTER its
 * visible first child, so growing that first child pushes `from` forward
 * over content the user could see — pasting two paragraphs mid-way through
 * a collapsed item's first line tore its own text in half, the tail at
 * display:none (MAR-155). The `from` assoc MIRRORS the `to` assoc: a
 * heading's `from` is the first HIDDEN position, so a block landing exactly
 * there vanishes and must count (`+1` keeps the old boundary before it),
 * while the other kinds' `from` is inside the collapsed node, where a
 * prepend (an external sync) was never visible and must not cost the fold
 * (`-1` — the exact counterpart of the `to` append rule).
 *
 * Scope: entries RELOCATED by a move meta never reach this (their
 * coordinates don't map); `relocationChangedHiddenContent` asks them the
 * same question by hidden-text identity instead — MAR-156.
 */
export function swallowedVisibleContent(
    tr: Transaction,
    oldDoc: any,
    newDoc: any,
    oldPos: number,
    newPos: number,
): boolean {
    const before = foldHiddenRange(oldDoc, oldPos);
    const after = foldHiddenRange(newDoc, newPos);
    if (!before || !after) {
        return false;
    }
    const assoc = isHeadingNode(newDoc.nodeAt(newPos)) ? -1 : 1;
    return (
        after.to > tr.mapping.map(before.to, assoc) ||
        after.from < tr.mapping.map(before.from, -assoc)
    );
}

/**
 * The relocation counterpart of `swallowedVisibleContent` (MAR-156): a moved
 * entry's old and new positions live in different coordinate spaces, so the
 * mapped-position comparison is meaningless — but the same question can be
 * asked of the resulting document by CONTENT: the relocated fold must hide
 * the same text it hid before. A grown extent (the destination put nothing
 * between the moved section and following blocks that out-ranks it) fails
 * this; so does an extent that swallowed one block while releasing another.
 * Either way the fold would hide content the user could see, so it expands
 * instead — reveal, don't refuse (MAR-146), exactly as
 * `swallowedVisibleContent` treats in-place growth.
 *
 * Text identity rather than node identity on purpose: a TOC drop relevels
 * the moved section's headings in the same transaction, which changes their
 * `level` attrs but hides nothing new — a fold whose hidden BYTES changed
 * only in heading rank still travels. (Every shipped mover passes moveRangeAt
 * or cover-expanded ranges that carry the whole collapsed unit; this check is
 * what keeps a future caller with a narrower range from burying content
 * silently.) Block separators and leaf-type tokens make boundaries and
 * non-text leaves part of the identity, so an hr swapped for an empty
 * paragraph reads as a change. Two different block TYPES with byte-identical
 * text would evade it — accepted: this is a burial net, not an identity
 * proof, and that doppelgänger needs the destination to contain the fold's
 * exact text by coincidence.
 */
export function relocationChangedHiddenContent(
    oldDoc: any,
    newDoc: any,
    oldPos: number,
    newPos: number,
): boolean {
    const before = foldHiddenRange(oldDoc, oldPos);
    const after = foldHiddenRange(newDoc, newPos);
    if (!before || !after) {
        return false;
    }
    const hiddenText = (doc: any, r: { from: number; to: number }) =>
        doc.textBetween(r.from, r.to, " | ", (leaf: ProseMirrorNode) => ` [${leaf.type.name}] `);
    return hiddenText(newDoc, after) !== hiddenText(oldDoc, before);
}

export function cleanFoldedPositions(doc: any, folded: Iterable<number>): Set<number> {
    const next = new Set<number>();
    for (const pos of folded) {
        // The block must still exist AND still hide something: a heading
        // whose section was emptied by edits (fold range now null) resets to
        // open. A kept entry would show no chevron and no ellipsis, then
        // silently swallow the next content to appear under the heading.
        if (foldHiddenRange(doc, pos) !== null) {
            next.add(pos);
        }
    }
    return next;
}

/** Every foldable position in the doc: top-level heading sections plus every
 * other foldable kind at any chrome-bearing depth (callouts, list items with
 * descendants, tables with body rows, non-empty code blocks — one fold
 * grammar, so Fold All folds them all). */
export function allFoldablePositions(doc: any): number[] {
    const positions: number[] = [];
    for (const [pos, range] of cachedFoldRanges(doc)) {
        if (range) {
            positions.push(pos);
        }
    }
    doc.descendants((node: any, pos: number) => {
        if (!isHeadingNode(node) && foldHiddenRange(doc, pos) !== null) {
            positions.push(pos);
        }
        return true;
    });
    return positions;
}

/**
 * Where a selection that would land inside newly hidden content escapes to.
 * Kinds with a visible caret home keep the caret local: a heading's own
 * line, a list item's first line, a table's header row. A collapsed callout
 * or code block has no editable line left, so the caret lands just before
 * the block.
 */
export function foldEscapeSelection(tr: Transaction, node: any, pos: number): Selection {
    return isHeadingNode(node) || isListItemNode(node) || isTableNode(node)
        ? TextSelection.near(tr.doc.resolve(Math.min(pos + 1, tr.doc.content.size)))
        : Selection.near(tr.doc.resolve(pos), -1);
}

/** True for the two list container types (items are the draggable units).
 * Exported: the single source of the grabbable-structure taxonomy (the drag
 * boundary walker consumes it too). */
export function isListNode(node: any): boolean {
    return node.type.name === "bullet_list" || node.type.name === "ordered_list";
}

/** Containers whose direct block children are grabbable units of their own
 * (all are `content: "block+"`, so drops between their children are legal).
 * Exported alongside isListNode as the taxonomy's single source. */
export function isContainerNode(node: any): boolean {
    switch (node.type.name) {
        case "blockquote":
        case "callout":
        case "notion_callout":
        case "container_directive":
            return true;
        default:
            return false;
    }
}

export function findSectionHeadingPosAt(view: EditorView, pos: number): number | null {
    return sectionHeadingPosAt(view.state.doc, pos);
}

/**
 * Doc-based body of findSectionHeadingPosAt, for callers that run on
 * (state, dispatch) with no view in hand.
 */
export function sectionHeadingPosAt(doc: ProseMirrorNode, pos: number): number | null {
    // Innermost heading whose section contains pos — the innermost is the
    // one starting latest. One cached stack walk instead of the old
    // per-heading full-doc scan: this runs on EVERY mousemove over
    // non-heading content, where the old shape was O(headings × doc) and
    // measured 2.6ms/event on a 500-heading document.
    let headingPos: number | null = null;
    for (const [candidate, range] of cachedFoldRanges(doc)) {
        if (
            range && candidate <= pos && pos < range.to &&
            (headingPos === null || candidate > headingPos)
        ) {
            headingPos = candidate;
        }
    }
    return headingPos;
}
