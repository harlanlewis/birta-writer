/**
 * components/blockMenu/menu.ts
 *
 * The gutter block menu (MAR-78) — opened by clicking a block's gutter marker
 * (`#`..`######`, `P`, …). The labeled sections:
 *   - **Table** (⌘. inside a table only, MAR-118): the caret cell's
 *     row/column ops, dispatched through the SAME contributed commands the
 *     native right-click menu invokes — see openBlockMenu's `opts.cellPos`.
 *   - **Turn into**: real markdown conversions — P / H1–H6, the three list
 *     types, blockquote, callout, code block — the current type shown as an
 *     accent-filled row (the toolbar Format-menu idiom). Row art (icons,
 *     badges, markdown hints) comes straight from the slash-menu registry, so
 *     the two menus can never drift apart visually.
 *   - **Numbering** (ordered lists only): how the list DRAWS its markers —
 *     `1.`, `a.`, `A.`, `i.`, `I.`. Presentation, never source: the file keeps
 *     `1.` because CommonMark has no lettered marker (utils/orderedMarkers.ts).
 *   - **Actions**: Duplicate, Copy as Markdown, Move Up/Down, Delete, and
 *     Copy Link on headings (slug anchors are the only block identity
 *     markdown has).
 *
 * Every action targets the block BY POSITION (like setHeadingLevelAt), never
 * the ambient selection, so the menu can change a block the caret isn't in.
 * Every action on a heading acts on the heading LINE alone: Move leaves the
 * section's body where it is (section semantics belong to the outline —
 * moveRangeAt against outlineRangeAt), and Duplicate/Delete are least
 * destructive (deleting a collapsed heading simply reveals its content). The
 * sole exception is a COLLAPSED heading's Move, which must bring the hidden
 * content it owns rather than strand it.
 *
 * Body-mounted like the other chrome popups; one menu open at a time; the
 * keyboard model mirrors the toolbar dropdowns (roving arrows, Enter, Escape).
 */
import { bindActivate } from "@/ui/dom";
import type { EditorView } from "../../pm";
import { Fragment } from "../../pm";
import type { Node as ProseNode } from "../../pm";
import {
    findHeadingFoldRange,
    foldAllCommand,
    foldedSectionEnd,
    foldedSectionEnds,
    headingFoldPluginKey,
    tagContentGuard,
    unfoldAllCommand,
    type HeadingFoldMeta,
} from "../../editing/blockOps";
import { getHeadingLevel, selectionCoverRange } from "../../plugins/headingFold";
import { sinkItemKeepingChildren } from "../../plugins/tabKeymap";
import { attrsFromMarker, markerWithFold } from "../../plugins/callouts";
import { BlockRangeSelection } from "../../plugins/blockRange";
// Value import from editorCommands is the turnInto.ts precedent: the cycle
// (editorCommands → blockMenu → editorCommands) only ever resolves at call
// time, never during module evaluation.
import { runEditorCommand, type GetEditor } from "../../editorCommands";
import type { EditorCommandId } from "../../../shared/editorCommands";
import { linkAtCaret, openLinkAtCaret } from "../linkPopup";
import { focusImageInputAt, imageWidthControlAt, openImageLightbox } from "../imageView";
import { notifyClipboardWrite } from "../../messaging";
import { slugify } from "../../utils/slug";
import { getTopbarBottom, slugTextOf } from "../../utils/headingUtils";
import { hideTooltip } from "../../ui/tooltip";
import { registerEscapeLayer } from "../../ui/escapeLayers";
import { clampLeft, viewportSize } from "../../ui/anchoredPlacement";
import { onOutsideClick } from "../../ui/outsideClick";
import { t } from "../../i18n";
import { filterSlashItems, SLASH_MENU_ITEMS } from "../slashMenu/registry";
import {
    IconAlertCircle,
    IconAlignCenter,
    IconAlignLeft,
    IconAlignRight,
    IconArrowDownToLine,
    IconCheckSquare,
    IconChevronDown,
    IconChevronLeft,
    IconChevronRight,
    IconChevronUp,
    IconCopy,
    IconExpandHorizontal,
    IconExternalLink,
    IconFileText,
    IconLink,
    IconList,
    IconMaximize2,
    IconPencil,
    IconPlus,
    IconTrash2,
} from "../../ui/icons";
import {
    anchorAt,
    getBlockWidth,
    inheritDuplicatedAnchors,
    setBlockWidth,
    tableAnchorBase,
    tableWidthAnchor,
} from "../../blockWidth";
import {
    isChecklistSinkEnabled,
    setChecklistSinkEnabled,
    uncheckAllTasks,
} from "../../editing/checklistSink";
import { mergeableListBoundary, mergeListsAt } from "../../editing/listMerge";
import { outermostListAt } from "../../editing/listConvert";
import { listTreeIsLoose, setListTreeSpread } from "../../plugins/list";
import { blockMarkdownAt, selectInto } from "./turnInto";
import { setListNumberingAt } from "../../plugins/listNumbering";
import { isOrderedNumbering, type OrderedNumbering } from "../../utils/orderedMarkers";
import { moveBlocks, moveFits } from "../../editing/blockOps";
import {
    canConvert,
    canConvertRange,
    contentEffectOf,
    conversionKindAt,
    convertAt,
    convertRange,
    coveredBlockPositions,
    type ConversionKind,
    type FingerprintKey,
} from "../../blockCapabilities";
import { flashRange } from "../../editing/rangeIndicator";
import { TextSelection, type EditorState } from "../../pm";
import { liftListItem, liftTarget, NodeRange, sinkListItem } from "../../pm";

// ── Editor access ───────────────────────────────────────────────────────────
// The menu lives behind a ProseMirror widget, which only hands us the view;
// commands and the markdown serializer need the Editor ctx. Wired once from
// webview/index.ts, matching the setEditorCommandHost pattern.
let getEditor: GetEditor = () => null;

export function setBlockMenuContext(ctx: { getEditor: GetEditor }): void {
    getEditor = ctx.getEditor;
}

/**
 * The Numbering rows, in the order a reader would expect them: the default
 * first, then letters, then roman, lower before upper. The `hint` shows the
 * actual markers rather than naming the CSS keyword, because the markers are
 * what the user is choosing between.
 */
const NUMBERING_CHOICES: readonly {
    style: OrderedNumbering;
    label: string;
    hint: string;
    keywords: readonly string[];
}[] = [
    {
        style: "decimal",
        label: t("Numbers"),
        hint: "1. 2. 3.",
        keywords: ["numbering", "numbers", "decimal", "digits", "123", "default"],
    },
    {
        style: "lower-alpha",
        label: t("Lowercase letters"),
        hint: "a. b. c.",
        keywords: ["numbering", "letters", "alpha", "lowercase", "abc"],
    },
    {
        style: "upper-alpha",
        label: t("Uppercase letters"),
        hint: "A. B. C.",
        keywords: ["numbering", "letters", "alpha", "uppercase", "capital", "ABC"],
    },
    {
        style: "lower-roman",
        label: t("Lowercase roman"),
        hint: "i. ii. iii.",
        keywords: ["numbering", "roman", "lowercase", "numerals"],
    },
    {
        style: "upper-roman",
        label: t("Uppercase roman"),
        hint: "I. II. III.",
        keywords: ["numbering", "roman", "uppercase", "capital", "numerals"],
    },
];

// ── Block actions ───────────────────────────────────────────────────────────

/**
 * The range the block at `pos` occupies for a move in the DOCUMENT BODY: the
 * node alone, heading included. Moving a heading in the text is a LITERAL
 * block move — the paragraphs under it keep their place — because the text is
 * where a user edits sequence, not hierarchy. Section semantics live in the
 * outline (`outlineRangeAt`), which is where a gesture means "this heading and
 * everything it owns". Exported for unit testing.
 *
 * The one expansion: a COLLAPSED heading is inseparable from its hidden
 * section. Moving the line alone would strand blocks the user cannot see under
 * a new owner, and the fold would then swallow whatever followed the landing —
 * the same rule the keyboard's unit map and the selection cover already keep.
 */
export function moveRangeAt(view: EditorView, pos: number): { from: number; to: number } | null {
    const node = view.state.doc.nodeAt(pos);
    if (!node) {
        return null;
    }
    const nodeEnd = pos + node.nodeSize;
    // The depth guard is stated HERE, not inherited: foldedSectionEnd reaches
    // findHeadingFoldRange, which walks TOP-LEVEL offsets, so asking it about
    // a heading nested in a container would return an end outside that
    // container and moveBlockTo's deleteRange would destroy everything up to
    // the next top-level heading (the same trap outlineRangeAt names). The
    // fold plugin holds no fold for a nested heading (foldHiddenRange misses
    // for one), so a heading at depth carries no hidden section and moves as
    // its own line — but that contract lives two modules away, and this
    // guard is what keeps the range honest if it ever shifts.
    if (view.state.doc.resolve(pos).depth !== 0) {
        return { from: pos, to: nodeEnd };
    }
    return { from: pos, to: foldedSectionEnd(view.state, pos) ?? nodeEnd };
}

/**
 * The range the block at `pos` occupies for a move in the OUTLINE: a heading
 * carries its whole section (heading + fold range), everything else is just
 * the node. This is the TOC's scope — a row there stands for a section, so a
 * drop into the panel moves the section, whichever surface the drag started
 * on. Exported for unit testing.
 */
export function outlineRangeAt(view: EditorView, pos: number): { from: number; to: number } | null {
    const node = view.state.doc.nodeAt(pos);
    if (!node) {
        return null;
    }
    const nodeEnd = pos + node.nodeSize;
    // Section semantics are a TOP-LEVEL concept: findHeadingFoldRange walks
    // top-level offsets, so for a heading nested in a container it would
    // return an end OUTSIDE the container — moveBlockTo's deleteRange would
    // then destroy everything up to the next top-level heading. A nested
    // heading moves as a single block.
    if (node.type.name === "heading" && view.state.doc.resolve(pos).depth === 0) {
        const range = findHeadingFoldRange(view.state.doc, pos, getHeadingLevel(node));
        return { from: pos, to: range ? range.to : nodeEnd };
    }
    return { from: pos, to: nodeEnd };
}

/**
 * Duplicate the sibling blocks in [range.from, range.to) as ONE undo step.
 * `dir` picks where the copy lands: 1 = after the range — and after the
 * hidden section of a trailing COLLAPSED heading (inserting at range.to
 * would drop the copy into display:none), -1 = before it. With `select`,
 * the selection follows VS Code's copy-line semantics: duplicate-down lands
 * on the later run (the copy), duplicate-up stays on the earlier one — a
 * caret keeps its offset inside its block (the runs are identical), a block
 * range covers the whole run. Exported for the keyboard layer (blockKeys);
 * the menu's Duplicate row uses the single-node wrapper below.
 */
export function duplicateBlockRange(
    view: EditorView,
    range: { from: number; to: number },
    dir: -1 | 1,
    opts?: { select?: boolean },
): boolean {
    const { state } = view;
    const { doc } = state;
    // Collect the copied children directly from their common parent (the
    // moveBlockTo idiom): a doc.slice through a LIST would wrap the items
    // in a phantom open list node. Works uniformly for top-level blocks
    // (parent = doc) and list items (parent = list).
    const $from = doc.resolve(range.from);
    const parent = $from.depth === 0 ? doc : $from.parent;
    const base = $from.depth === 0 ? 0 : $from.start();
    const copied: ProseNode[] = [];
    let lastPos = -1;
    parent.forEach((child: ProseNode, offset: number) => {
        const childPos = base + offset;
        if (childPos >= range.from && childPos < range.to) {
            copied.push(child);
            lastPos = childPos;
        }
    });
    if (copied.length === 0) {
        return false;
    }
    const content = Fragment.from(copied);
    let insertAt = dir === 1 ? range.to : range.from;
    if (dir === 1 && lastPos >= 0) {
        const sectionEnd = foldedSectionEnd(state, lastPos);
        if (sectionEnd !== null && sectionEnd > insertAt) {
            insertAt = sectionEnd;
        }
    }
    const tr = state.tr.insert(insertAt, content);
    if (tr.doc.content.size < doc.content.size + content.size) {
        // tr.insert silently no-ops when the content can't fit (replaceStep
        // returns null); a failed duplicate must change nothing.
        return false;
    }
    if (opts?.select) {
        const runStart = dir === 1 ? insertAt : range.from;
        const sel = state.selection;
        if (sel instanceof BlockRangeSelection) {
            const runRange = BlockRangeSelection.tryCreate(
                tr.doc, runStart, runStart + content.size,
            );
            if (runRange) {
                tr.setSelection(runRange);
            }
        } else {
            // Caret/text: same offset within the target run. Explicit even
            // for dir -1 (numerically unchanged positions) — the default
            // insert mapping would push the selection onto the later run.
            const delta = runStart - range.from;
            const clamp = (pos: number): number =>
                Math.max(0, Math.min(pos + delta, tr.doc.content.size));
            tr.setSelection(TextSelection.between(
                tr.doc.resolve(clamp(sel.anchor)),
                tr.doc.resolve(clamp(sel.head)),
            ));
        }
    }
    // Content-guard contract (MAR-108): a duplicate gains exactly this copy.
    tagContentGuard(tr, { kind: "duplicate", gained: content });
    const docBefore = view.state.doc;
    view.dispatch(tr);
    if (view.state.doc === docBefore) {
        // Guard veto — the transaction never applied. Report a truthful
        // no-op and skip the landing flash (its positions describe a doc
        // that doesn't exist).
        return false;
    }
    view.focus();
    // A copy reads the way the block it copied does (MAR-334). Presentation
    // preferences live beside the document under occurrence-disambiguated keys,
    // so inserting a twin renumbers them: without this the copy would paint at
    // its default width beside a full-width original, and a duplicate-UP would
    // hand the original's preference to the copy. Not a document edit, so it
    // stays outside the transaction and outside undo history — the same footing
    // as every other write to this store.
    inheritDuplicatedAnchors({
        before: docBefore,
        after: view.state.doc,
        sourceFrom: range.from,
        insertAt,
        size: content.size,
    });
    // "Here's where it landed" — the same landing flash a move gets. A
    // block-range duplicate already reads its destination from the selection
    // tint on the copy, but a caret duplicate otherwise makes a second block
    // appear with no feedback; flashing the copy covers both.
    flashRange(view, insertAt, insertAt + content.size);
    return true;
}

/** Duplicate the node at `pos`, inserting the copy right after it — or, for
 * a COLLAPSED heading, after its hidden section (see duplicateBlockRange). */
function duplicateBlock(view: EditorView, pos: number): boolean {
    const node = view.state.doc.nodeAt(pos);
    if (!node) {
        return false;
    }
    return duplicateBlockRange(view, { from: pos, to: pos + node.nodeSize }, 1);
}

/**
 * Delete the blocks in [range.from, range.to) as one step (deleteRange
 * fills the schema-required empty paragraph when the last block goes). The
 * fold meta stops a collapsed heading's fold entry from transferring to
 * whatever fills the gap. Exported for the keyboard layer (blockKeys).
 */
export function deleteBlockRange(
    view: EditorView,
    range: { from: number; to: number },
): boolean {
    if (range.to <= range.from) {
        return false;
    }
    const tr = view.state.tr.deleteRange(range.from, range.to);
    tr.setMeta(headingFoldPluginKey, {
        type: "delete",
        from: range.from,
        to: range.to,
    } satisfies HeadingFoldMeta);
    view.dispatch(tr);
    view.focus();
    return true;
}

/** Delete the node at `pos` (see deleteBlockRange). */
function deleteBlock(view: EditorView, pos: number): boolean {
    const node = view.state.doc.nodeAt(pos);
    if (!node) {
        return false;
    }
    return deleteBlockRange(view, { from: pos, to: pos + node.nodeSize });
}

/**
 * Where a move in `dir` would land, or null at a document edge.
 *
 * Any block hops exactly one visible UNIT — a collapsed heading and its
 * hidden section count as one (landing between them would drop the moved
 * block into display:none, an apparent deletion). A run that CARRIES a whole
 * section (only a collapsed heading does, in the body — see moveRangeAt) hops
 * a whole neighboring section UNIT instead, so two sections never interleave:
 *   - down: if the next block is a heading, hop its entire fold range;
 *   - up: hop to the start of the outermost section that ends exactly where
 *     this one starts (candidates whose fold range ends at `range.from`;
 *     ancestors don't qualify — their ranges extend past us).
 */
function moveTargetFor(
    state: EditorState,
    range: { from: number; to: number },
    carriesSection: boolean,
    dir: -1 | 1,
): number | null {
    const doc = state.doc;
    const sectionEnds = foldedSectionEnds(state);
    if (dir === 1) {
        const nextNode = doc.nodeAt(range.to);
        if (!nextNode) {
            return null;
        }
        // A collapsed next heading hides its section: hop the whole unit.
        let hopEnd = sectionEnds.get(range.to) ?? range.to + nextNode.nodeSize;
        if (carriesSection && nextNode.type.name === "heading") {
            const section = findHeadingFoldRange(doc, range.to, getHeadingLevel(nextNode));
            if (section) {
                hopEnd = Math.max(hopEnd, section.to);
            }
        }
        return hopEnd;
    }
    let prevStart: number | null = null;
    let skipUntil = 0;
    doc.forEach((node: ProseNode, offset: number) => {
        if (offset < skipUntil) {
            return; // hidden inside a collapsed section — not a landing spot
        }
        const end = sectionEnds.get(offset) ?? offset + node.nodeSize;
        if (end <= range.from) {
            prevStart = offset; // last one wins — the visible unit just before
        }
        skipUntil = end;
    });
    if (prevStart === null) {
        return null;
    }
    if (carriesSection) {
        let unitStart: number | null = null;
        doc.forEach((node: ProseNode, offset: number) => {
            if (offset >= range.from || node.type.name !== "heading" || unitStart !== null) {
                return;
            }
            const section = findHeadingFoldRange(doc, offset, getHeadingLevel(node));
            const end = section ? section.to : offset + node.nodeSize;
            if (end === range.from) {
                unitStart = offset; // first (outermost) section ending at us
            }
        });
        if (unitStart !== null) {
            return unitStart;
        }
    }
    return prevStart;
}

/**
 * Sibling-hop target for any NESTED block's move (list items, container
 * children — the walk is parent-generic via $pos.index/posAtIndex): the
 * previous sibling's start or the next sibling's end, null at the parent's
 * edge. Nested blocks move within their own parent from the menu (drag
 * handles cross-parent refile).
 */
function moveNestedTarget(view: EditorView, itemPos: number, dir: -1 | 1): number | null {
    const $pos = view.state.doc.resolve(itemPos);
    if ($pos.depth === 0) {
        return null;
    }
    const index = $pos.index();
    const parent = $pos.parent;
    if (dir === -1) {
        return index > 0 ? $pos.posAtIndex(index - 1) : null;
    }
    if (index >= parent.childCount - 1) {
        return null;
    }
    return $pos.posAtIndex(index + 1) + parent.child(index + 1).nodeSize;
}

// The move primitive was extracted to editing/moveBlocks (MAR-112): the
// hardened structural contract — source-range integrity, explicit canReplace
// fit, fold-hidden target legality, the content-guard tag, and the fold move
// meta — lives there. Re-exported under its historical name so the menu's
// Move rows, drag-drop, the keyboard layer, and the test surface keep one
// import site.
export { moveBlocks as moveBlockTo } from "../../editing/moveBlocks";

/**
 * Whether the move range at `pos` reaches past the block itself — i.e. it
 * carries a whole section (a collapsed heading, the only body-scope case).
 * That is what earns the section-unit hop in moveTargetFor; a bare heading
 * hops one block like any other.
 */
function carriesSection(view: EditorView, pos: number, range: { from: number; to: number }): boolean {
    const node = view.state.doc.nodeAt(pos);
    return node !== null && range.to > pos + node.nodeSize;
}

/**
 * Move the block one unit up or down. Returns false at a document edge.
 * A heading moves ALONE here (the body is a literal-sequence surface — see
 * moveRangeAt); only a collapsed one brings its hidden section. Exported for
 * unit testing.
 */
export function moveBlockAt(view: EditorView, pos: number, dir: -1 | 1): boolean {
    const range = moveRangeAt(view, pos);
    if (!range) {
        return false;
    }
    // Any NESTED block (list item, or a container's child) hops among its
    // siblings via the parent-generic index walk; only top-level blocks use
    // the doc-level walk (which also hops whole sections).
    const nested = view.state.doc.resolve(pos).depth > 0;
    const target = nested
        ? moveNestedTarget(view, pos, dir)
        : moveTargetFor(view.state, range, carriesSection(view, pos, range), dir);
    if (target === null) {
        return false;
    }
    return moveBlocks(view, range, target);
}

// ── Refile: indent into / outdent out of a container (MAR-118) ─────────────
// The keyboard path to what drag-refile does: move a block INTO the previous
// sibling container (indent) or lift it OUT of its enclosing one (outdent).
// List items delegate to the Tab machinery (sinkItemKeepingChildren /
// sinkListItem / liftListItem), so ⌘] on an item and Tab in it can never
// diverge; everything else routes through moveBlocks (indent — the same
// hardened primitive every mover uses) or a plain ProseMirror lift (outdent —
// the wrapBlocks convention: lifting part of a container splits it, as it
// does everywhere else in ProseMirror).

/**
 * The boundary inside the PREVIOUS sibling where the run [range.from,
 * range.to) could land: the shallowest position along that sibling's
 * last-child spine that moveBlocks would accept. Walking the spine is what
 * makes one rule serve every container — a blockquote/callout absorbs at its
 * own end, a list refuses blocks as direct children so the walk descends into
 * its last item's `paragraph block*` content, and a textblock/atom sibling
 * offers no boundary at all. moveFits carries the full target contract
 * (schema fit on both sides, fold-hidden targets rejected), so a collapsed
 * container can never swallow an indented block invisibly. Exported for unit
 * testing.
 */
export function indentTargetFor(
    state: EditorState,
    range: { from: number; to: number },
): number | null {
    const $from = state.doc.resolve(range.from);
    const parent = $from.depth === 0 ? state.doc : $from.parent;
    const index = $from.index($from.depth);
    if (index === 0) {
        return null;
    }
    let pos = $from.posAtIndex(index - 1);
    let node: ProseNode | null = parent.child(index - 1);
    while (node && !node.isTextblock && !node.isAtom && node.childCount > 0) {
        const inside = pos + node.nodeSize - 1;
        if (moveFits(state, range, inside)) {
            return inside;
        }
        const last: ProseNode = node.lastChild!;
        pos = inside - last.nodeSize;
        node = last;
    }
    return null;
}

/**
 * Run `fn` with a text selection guaranteed inside the node at `pos`: the
 * preset list commands (sink/lift) are selection-driven, while this menu's
 * contract is by-position. A selection already inside the node is kept (so a
 * caret keeps its offset); otherwise a caret is placed at the node's start
 * first — a selection-only transaction, invisible to history.
 */
function withCaretIn(view: EditorView, pos: number, node: ProseNode, fn: () => boolean): boolean {
    const { from, to } = view.state.selection;
    if (from <= pos || to >= pos + node.nodeSize) {
        view.dispatch(view.state.tr.setSelection(
            TextSelection.near(view.state.doc.resolve(pos + 1), 1),
        ));
    }
    return fn();
}

/** The selection-probe state for a dry-run of a selection-driven command
 * against the block at `pos` (a caret placed just inside it). */
function probeStateAt(view: EditorView, pos: number): EditorState {
    return view.state.apply(view.state.tr.setSelection(
        TextSelection.near(view.state.doc.resolve(pos + 1), 1),
    ));
}

/**
 * Move the block at `pos` INTO the previous sibling container (one level
 * deeper). A list item sinks exactly like Tab (sinkItemKeepingChildren's
 * item-alone rule, then stock sinkListItem); everything else moves through
 * moveBlocks to the indentTargetFor boundary — a collapsed heading brings its
 * hidden section (moveRangeAt). False when nothing can absorb it.
 */
export function indentBlockAt(view: EditorView, pos: number): boolean {
    const node = view.state.doc.nodeAt(pos);
    if (!node) {
        return false;
    }
    if (node.type.name === "list_item") {
        if (view.state.doc.resolve(pos).index() === 0) {
            return false; // nothing to sink under
        }
        return withCaretIn(view, pos, node, () =>
            sinkItemKeepingChildren(node.type)(view.state, view.dispatch) ||
            sinkListItem(node.type)(view.state, view.dispatch));
    }
    const range = moveRangeAt(view, pos);
    if (!range) {
        return false;
    }
    const target = indentTargetFor(view.state, range);
    if (target === null) {
        return false;
    }
    return moveBlocks(view, range, target);
}

/**
 * Lift the block at `pos` OUT of its enclosing container (one level up). A
 * list item lifts exactly like Shift+Tab (preset liftListItem: following
 * siblings become its children); everything else lifts its own NodeRange out
 * of its direct parent. False at the top level, and when the schema refuses
 * the lift.
 */
export function outdentBlockAt(view: EditorView, pos: number): boolean {
    const node = view.state.doc.nodeAt(pos);
    if (!node) {
        return false;
    }
    if (node.type.name === "list_item") {
        return withCaretIn(view, pos, node, () =>
            liftListItem(node.type)(view.state, view.dispatch));
    }
    const $pos = view.state.doc.resolve(pos);
    if ($pos.depth === 0) {
        return false;
    }
    const range = new NodeRange(
        view.state.doc.resolve(pos),
        view.state.doc.resolve(pos + node.nodeSize),
        $pos.depth,
    );
    const target = liftTarget(range);
    if (target === null) {
        return false;
    }
    view.dispatch(view.state.tr.lift(range, target).scrollIntoView());
    return true;
}

/** Whether indentBlockAt would act — drives the menu row's presence. */
export function canIndentAt(view: EditorView, pos: number): boolean {
    const node = view.state.doc.nodeAt(pos);
    if (!node) {
        return false;
    }
    if (node.type.name === "list_item") {
        if (view.state.doc.resolve(pos).index() === 0) {
            return false;
        }
        const probe = probeStateAt(view, pos);
        return sinkItemKeepingChildren(node.type)(probe) || sinkListItem(node.type)(probe);
    }
    const range = moveRangeAt(view, pos);
    return range !== null && indentTargetFor(view.state, range) !== null;
}

/** Whether outdentBlockAt would act — drives the menu row's presence. */
export function canOutdentAt(view: EditorView, pos: number): boolean {
    const node = view.state.doc.nodeAt(pos);
    if (!node) {
        return false;
    }
    if (node.type.name === "list_item") {
        return liftListItem(node.type)(probeStateAt(view, pos));
    }
    const $pos = view.state.doc.resolve(pos);
    if ($pos.depth === 0) {
        return false;
    }
    const range = new NodeRange(
        view.state.doc.resolve(pos),
        view.state.doc.resolve(pos + node.nodeSize),
        $pos.depth,
    );
    return liftTarget(range) !== null;
}

/**
 * The block the SELECTION-driven refile verbs act on (the contributed
 * ⌘]/⌘[ commands): the innermost list item, else the caret's own block at
 * whatever depth it sits — a quoted paragraph outdents alone, splitting its
 * quote, the ProseMirror convention — else the block a depth-0 selection
 * (gap cursor, block range head) touches. Null inside a table: a refile
 * there would tear a block out of its cell (the deleteSelectedBlocks rule).
 */
function refileCaretPos(view: EditorView): number | null {
    const { $from } = view.state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
        const name = $from.node(depth).type.name;
        if (name === "list_item") {
            return $from.before(depth);
        }
        if (name === "table") {
            return null;
        }
    }
    if ($from.depth === 0) {
        return $from.nodeAfter ? $from.pos : null;
    }
    return $from.before($from.depth);
}

/**
 * Indent for the current selection: an explicit block-spanning selection
 * moves its whole (fold-expanded) cover into the previous container and
 * stays selected — the moveSelectedBlocks convention — a caret indents its
 * refileCaretPos block. Exported for the contributed command.
 */
export function indentSelection(view: EditorView): boolean {
    const cover = selectionCoverRange(view);
    if (cover) {
        const target = indentTargetFor(view.state, cover);
        if (target === null) {
            return false;
        }
        return moveBlocks(view, cover, target, {
            selectRun: view.state.selection instanceof BlockRangeSelection,
        });
    }
    const pos = refileCaretPos(view);
    return pos !== null && indentBlockAt(view, pos);
}

/**
 * Outdent for the current selection: an explicit cover lifts as one
 * NodeRange (top-level covers have nowhere to lift and refuse); a caret
 * outdents its refileCaretPos block. Exported for the contributed command.
 */
export function outdentSelection(view: EditorView): boolean {
    const cover = selectionCoverRange(view);
    if (cover) {
        const $from = view.state.doc.resolve(cover.from);
        if ($from.depth === 0) {
            return false;
        }
        const range = new NodeRange($from, view.state.doc.resolve(cover.to), $from.depth);
        const target = liftTarget(range);
        if (target === null) {
            return false;
        }
        view.dispatch(view.state.tr.lift(range, target).scrollIntoView());
        return true;
    }
    const pos = refileCaretPos(view);
    return pos !== null && outdentBlockAt(view, pos);
}

/**
 * Whether a move in `dir` is actually possible (drives row disabling). A
 * neighbour to hop is necessary but NOT sufficient: the move must also be one
 * the primitive will accept, so the answer defers to moveBlocks' own verdict
 * (moveFits) rather than re-deriving legality here. Without that, a row can
 * render live and do nothing on click — the shape a list item's first
 * grabbable child had, whose "Move Up" would promote a non-paragraph to the
 * head of a `paragraph block*` item and be refused (MAR-88).
 */
function canMove(view: EditorView, pos: number, dir: -1 | 1): boolean {
    const range = moveRangeAt(view, pos);
    if (!range) {
        return false;
    }
    const target = view.state.doc.resolve(pos).depth > 0
        ? moveNestedTarget(view, pos, dir)
        : moveTargetFor(view.state, range, carriesSection(view, pos, range), dir);
    if (target === null) {
        return false;
    }
    return moveFits(view.state, range, target);
}

/**
 * The heading's real anchor slug: duplicates get `-1`, `-2`, … in document
 * order — the exact scheme headingIds/linkPopup resolve against (see
 * findHeadingElement in components/linkPopup), so a copied link always lands
 * on THIS heading, not the first duplicate. Exported for unit testing.
 */
export function headingAnchorSlug(doc: ProseNode, pos: number): string | null {
    const target = doc.nodeAt(pos);
    if (!target || target.type.name !== "heading") {
        return null;
    }
    const base = slugify(slugTextOf(target));
    let priorDuplicates = 0;
    doc.descendants((node: ProseNode, nodePos: number) => {
        if (node.type.name === "heading" && nodePos < pos && slugify(slugTextOf(node)) === base) {
            priorDuplicates++;
        }
        return true;
    });
    return priorDuplicates === 0 ? base : `${base}-${priorDuplicates}`;
}

/** Copy `[text](#slug)` for the heading at `pos` (its TOC anchor). */
function copyHeadingLink(view: EditorView, pos: number): void {
    const slug = headingAnchorSlug(view.state.doc, pos);
    const node = view.state.doc.nodeAt(pos);
    if (slug === null || !node) {
        return;
    }
    // Escape link-text metacharacters so a heading like "a ] b" survives.
    const text = node.textContent.trim().replace(/([\\[\]])/g, "\\$1");
    notifyClipboardWrite("markdown", `[${text}](#${slug})`);
}

// ── The menu ────────────────────────────────────────────────────────────────

// Turn-into rows reuse the slash registry's art wholesale — label, icon,
// SVG-or-badge slot, and the right-aligned literal-markdown hint — so the two
// menus present every block type identically (single source, zero drift).
//
// A kind with no slash row names itself instead. Those are the two container
// spellings the editor can convert AWAY from but never inserts (see
// blockCapabilities): nothing in the slash menu creates a `:::name` directive
// or a Notion `<aside>`, so there is no row to borrow. Each shows in exactly
// one place, as the filled current-type row on its own block's menu.
const SLASH_ID_BY_KIND: Record<ConversionKind, string | { label: string; icon: string }> = {
    paragraph: "paragraph",
    h1: "heading1",
    h2: "heading2",
    h3: "heading3",
    h4: "heading4",
    h5: "heading5",
    h6: "heading6",
    bulletList: "bulletList",
    orderedList: "orderedList",
    taskList: "taskList",
    blockquote: "blockquote",
    callout: "callout",
    codeBlock: "codeBlock",
    directive: { label: t("Directive"), icon: IconAlertCircle },
    notionCallout: { label: t("Notion Callout"), icon: IconAlertCircle },
};

interface TurnIntoRow {
    kind: ConversionKind;
    label: string;
    keywords: readonly string[];
    icon: string;
    badge?: string;
    hint?: string;
}

const TURN_INTO_CHOICES: TurnIntoRow[] = (Object.keys(SLASH_ID_BY_KIND) as ConversionKind[]).map(
    (kind) => {
        const art = SLASH_ID_BY_KIND[kind]!;
        if (typeof art !== "string") {
            return { kind, label: art.label, keywords: [art.label.toLowerCase()], icon: art.icon };
        }
        const item = SLASH_MENU_ITEMS.find((entry) => entry.id === art);
        return {
            kind,
            label: item?.label ?? kind,
            // The registry's search keywords power this menu's filter too.
            keywords: item?.keywords ?? [],
            icon: item?.icon ?? "",
            ...(item?.badge !== undefined && { badge: item.badge }),
            ...(item?.hint !== undefined && { hint: item.hint }),
        };
    },
);

/**
 * What a degrading conversion costs, one fingerprint key at a time. The
 * registry declares WHAT a pair drops (blockCapabilities' ContentEffect);
 * the words for it are this menu's, because this is the surface that says
 * them. Every key the registry can drop must appear here, which
 * blockMenu.test.ts sweeps rather than trusts.
 */
export const LOSS_NOTES: Record<FingerprintKey, string> = {
    "task:state": t("checkmarks dropped"),
    "callout:marker": t("callout marker dropped"),
    "directive:name": t("directive name dropped"),
    "notion:icon": t("callout icon dropped"),
};

/**
 * The quiet note a Turn-into row carries when the pick is not conserving, or
 * null when nothing is lost. Advisory only, per docs/DESIGN_PRINCIPLES: the
 * row still applies on one click and undo is the safety mechanism, so this
 * tells the user what just happened rather than asking them to confirm it.
 */
function conversionLossNote(
    source: ConversionKind,
    target: ConversionKind,
): string | null {
    const effect = contentEffectOf(source, target);
    if (effect === null || effect === "conserving") {
        return null;
    }
    if (effect === "conserving-modulo-marks") {
        // A fence holds uninterpreted text, so bold and links arrive as the
        // markdown that spells them.
        return t("formatting becomes text");
    }
    const notes = (effect.drops ?? [])
        .map((key) => LOSS_NOTES[key])
        .filter((note): note is string => note !== undefined);
    return notes.length > 0 ? notes.join(", ") : null;
}

// Only one gutter menu is open at a time; opening (or clicking the same
// marker again) closes the previous one.
let closeActiveBlockMenu: (() => void) | null = null;

// Monotonic id source for the listbox container, so the combobox input's
// aria-controls always points at a fresh, unique element even if a prior
// menu lingers a tick during teardown.
let blockMenuSeq = 0;

/** Closes the currently open block menu, if any (used by the drag handle). */
export function closeBlockMenu(): void {
    closeActiveBlockMenu?.();
}

/**
 * Open the block menu anchored to a gutter marker. Both open modes focus
 * the "Search actions…" input (the Notion pattern); `viaKeyboard` only
 * decides where focus RETURNS on Escape (the marker) vs any other close
 * (the editor).
 *
 * `opts.cellPos` (MAR-118, the ⌘.-inside-a-table path) is a position INSIDE
 * a cell of the anchor table; it surfaces the Table section, whose rows run
 * the SAME contributed table commands the right-click menu does, against
 * that exact cell.
 */
export function openBlockMenu(
    view: EditorView,
    blockPos: number,
    anchor: HTMLElement,
    viaKeyboard: boolean,
    opts?: { cellPos?: number },
): void {
    // Toggle: a second click on the SAME marker closes its menu instead of
    // reopening it (read the open-state before closing — close() clears it).
    const reopeningSameMarker = anchor.classList.contains("heading-fold-marker--menu-open");
    closeActiveBlockMenu?.();
    if (reopeningSameMarker) {
        return;
    }

    // Identity guard: every action re-checks that the block it was built for
    // is still the node at blockPos. The doc-change close (headingFold's
    // plugin view calls closeBlockMenu) makes stale menus rare; this makes a
    // stale ACTION impossible — same philosophy as tableCmd's cellPos bail.
    const anchorNode = view.state.doc.nodeAt(blockPos);
    const isHeading = anchorNode?.type.name === "heading";
    // The "Move Section" label follows what the move will actually carry, not
    // what kind of block this is: in the body a heading moves alone, so only a
    // COLLAPSED one (inseparable from its hidden content) is a section move.
    const anchorMoveRange = moveRangeAt(view, blockPos);
    const movesSection =
        anchorMoveRange !== null && carriesSection(view, blockPos, anchorMoveRange);
    const isItem = anchorNode?.type.name === "list_item";
    // An ITEM's marker still offers the LIST-level conversions (turn the
    // whole list ordered/task/prose/…): actions target the item, Turn-into
    // targets its parent list — the list node itself carries no marker.
    const conversionPos = isItem
        ? view.state.doc.resolve(blockPos).before(view.state.doc.resolve(blockPos).depth)
        : blockPos;
    const currentKind = conversionKindAt(view, conversionPos);
    // A menu opened on a block inside a multi-block cover (a block-range
    // selection, or a text selection spanning blocks) turns the WHOLE run:
    // the rows are the intersection of every covered block's legal targets
    // and one pick converts them all (convertRange). Only a top-level
    // conversion block joins a run; a nested handle keeps its own scope.
    const cover = selectionCoverRange(view);
    const coveredRun =
        cover !== null &&
        cover.from <= conversionPos &&
        conversionPos < cover.to &&
        view.state.doc.resolve(conversionPos).depth === 0 &&
        coveredBlockPositions(view.state.doc, cover).length > 1
            ? cover
            : null;
    const runKinds = coveredRun
        ? coveredBlockPositions(view.state.doc, coveredRun).map((pos) => conversionKindAt(view, pos))
        : [];

    const menu = document.createElement("div");
    menu.className = "block-menu";
    // Not role="menu": this is an aria-activedescendant-driven COMBOBOX (the
    // search input) over a LISTBOX of rows (the body), not a menu of
    // menuitems — the input keeps focus and mirrors the highlight through
    // aria-activedescendant, exactly like the slash menu's combobox model.
    // The wrapper itself carries no role; the semantics live on the input
    // (combobox) and the body (listbox).

    // ── "Search actions…" (the Notion pattern): a default-focused filter
    // input; typing narrows both sections to one flat ranked list, sharing
    // the slash menu's matcher and the registry's keywords. ──
    const listboxId = `block-menu-listbox-${++blockMenuSeq}`;
    const search = document.createElement("input");
    search.type = "text";
    search.className = "block-menu-search";
    search.placeholder = t("Search actions…");
    search.setAttribute("aria-label", t("Search actions"));
    // Full WAI-ARIA combobox contract: the input owns focus and drives the
    // listbox rows via aria-activedescendant (set in setHl/clearHl below).
    search.setAttribute("role", "combobox");
    search.setAttribute("aria-haspopup", "listbox");
    search.setAttribute("aria-autocomplete", "list");
    search.setAttribute("aria-controls", listboxId);
    search.setAttribute("aria-expanded", "true");
    menu.appendChild(search);
    // Rows re-render per keystroke into their own container so the input
    // (and its focus/caret) is never rebuilt. The container is the listbox
    // aria-controls points at; its option rows are built by addRow.
    const body = document.createElement("div");
    body.className = "block-menu-body";
    body.id = listboxId;
    body.setAttribute("role", "listbox");
    menu.appendChild(body);

    let outsideOff: (() => void) | null = null;
    const rowEls = (): HTMLElement[] =>
        Array.from(menu.querySelectorAll<HTMLElement>(".block-menu-item:not([aria-disabled='true'])"));
    // Focus stays in the search input; arrows move a VIRTUAL highlight over
    // the rows (the slash menu's combobox model), mirrored to AT via
    // aria-activedescendant. Mouse hover/click on rows is unchanged.
    let hlIdx = -1;
    let rowIdSeq = 0;
    const clearHl = (): void => {
        hlIdx = -1;
        rowEls().forEach((row) => row.classList.remove("block-menu-item--hl", "ui-menu-row--selected"));
        search.removeAttribute("aria-activedescendant");
    };
    /** Wraps into [0, rows) — pass hlIdx±1 to step (from -1, ArrowDown
     * lands on the first row and ArrowUp on the last). */
    const setHl = (idx: number): void => {
        const list = rowEls();
        if (list.length === 0) {
            clearHl();
            return;
        }
        hlIdx = ((idx % list.length) + list.length) % list.length;
        list.forEach((row, i) => {
            row.classList.toggle("block-menu-item--hl", i === hlIdx);
            row.classList.toggle("ui-menu-row--selected", i === hlIdx);
        });
        const current = list[hlIdx]!;
        if (!current.id) {
            current.id = `block-menu-row-${++rowIdSeq}`;
        }
        search.setAttribute("aria-activedescendant", current.id);
        current.scrollIntoView?.({ block: "nearest" });
    };
    // Escape closes from anywhere (document capture); with focus in the
    // search input, arrows drive the highlight, Enter activates it, and Tab
    // steps it (focus never leaves the input — the combobox model).
    const onKeyDown = (event: KeyboardEvent): void => {
        // Never interrupt IME composition: the keydown that commits (Enter)
        // or navigates candidates (arrows) must reach the input untouched —
        // the slash menu's rule (slashMenu.ts), applied to this input too.
        if (event.isComposing) {
            return;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
            // Keyboard users get their focus back on the marker; a mouse
            // open never moved focus into the editor chrome, so return it
            // to the editor (the marker may also have been destroyed by a
            // decoration rebuild).
            if (viaKeyboard && anchor.isConnected) {
                anchor.focus();
            } else {
                view.focus();
            }
            return;
        }
        if (event.target !== search) {
            return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Tab") {
            // Tab joins the arrows: focus stays in the input (tabbing out
            // would land on the scrollable row container, a dead end) and
            // steps the highlight instead.
            event.preventDefault();
            event.stopPropagation();
            const back = event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey);
            setHl(hlIdx + (back ? -1 : 1));
        } else if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            // Only a VISIBLE highlight may act: in browse mode nothing is
            // highlighted and Enter must be a no-op — a `?? first row`
            // fallback here silently converted the block to the first
            // turn-into choice (Paragraph) with zero on-screen indication.
            if (hlIdx >= 0) {
                rowEls()[hlIdx]?.dispatchEvent(
                    new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
                );
            }
        }
    };
    const onFocusOut = (event: FocusEvent): void => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || (!menu.contains(next) && next !== anchor)) {
            close();
        }
    };
    // Keep the menu glued to its marker while any ancestor scrolls (the
    // slash-menu idiom: capture-phase because the editor's scroller isn't
    // always window). The marker may be destroyed by a decoration rebuild
    // mid-scroll — then there is nothing to anchor to, so close.
    const onScroll = (event: Event): void => {
        // Capture-phase scroll listeners also see the menu's OWN internal
        // scrolling — repositioning then (which touches maxHeight) would
        // reset the menu's scrollTop on every wheel tick. Only document
        // scrolling moves the anchor.
        if (event.target instanceof Node && menu.contains(event.target)) {
            return;
        }
        if (!anchor.isConnected) {
            close();
            return;
        }
        // Scrolling can slide another block's marker under the stationary
        // pointer — its tooltip alongside an open menu is noise.
        hideTooltip();
        position();
    };
    // A panel/sash resize reflows the editor with no scroll event — re-anchor
    // exactly as a scroll would (or close if the marker was rebuilt away).
    const onResize = (): void => {
        if (!anchor.isConnected) {
            close();
            return;
        }
        position();
    };
    // The webview losing focus (user clicked another VS Code panel) should
    // dismiss transient chrome, like the slash menu does.
    const onWindowBlur = (): void => {
        close();
    };
    function close(): void {
        if (closeActiveBlockMenu === close) {
            closeActiveBlockMenu = null;
        }
        escapeLayerOff();
        // The search input owns focus while the menu is open; removing it
        // would strand focus on <body> (dead keyboard) for every close that
        // no action follows — non-mutating picks (Copy as Markdown), the
        // already-active radio row, scroll-away, doc-change. Hand focus
        // back to the editor; Escape's keyboard branch re-targets the
        // marker right after, and mutating actions re-focus anyway.
        if (menu.contains(document.activeElement)) {
            view.focus();
        }
        anchor.classList.remove("heading-fold-marker--menu-open");
        if (anchor.isConnected) {
            anchor.setAttribute("aria-expanded", "false");
        }
        outsideOff?.();
        outsideOff = null;
        document.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", onResize);
        window.removeEventListener("blur", onWindowBlur);
        menu.removeEventListener("focusout", onFocusOut);
        menu.remove();
    }

    const addRow = (
        label: string,
        opts: {
            active?: boolean;
            disabled?: boolean;
            radio?: boolean;
            /** menuitemcheckbox semantics (aria-checked from `active`). */
            check?: boolean;
            danger?: boolean;
            icon?: string;
            badge?: string;
            hint?: string;
            /** The hint is prose about this pick, not markdown the user could
             * have typed. Drops the monospace so the two registers stay
             * legible as different things. */
            hintIsNote?: boolean;
            /** False for read-only rows (copies) — they must not move the
             * user's caret/selection. Defaults true. */
            mutates?: boolean;
            /** True for a mutating row that acts on the SELECTION rather
             * than the anchor block (a run conversion): the caret is not
             * pre-placed, so the selection history bookmarks, and undo
             * restores, is the run itself. */
            actsOnSelection?: boolean;
            action: () => void;
        },
    ): HTMLElement => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "ui-menu-row block-menu-item";
        row.dataset["mutates"] = opts.mutates === false ? "0" : "1";
        // Every row is a listbox option (the combobox model): AT reaches it
        // through the input's aria-activedescendant, not by focusing it. The
        // transient keyboard highlight is a separate channel: the input's
        // aria-activedescendant, set in setHl/clearHl. This is why blockMenu
        // does not follow the slash menu's aria-selected=highlight rule — its
        // rows, unlike the slash menu's, hold state of their own.
        //
        // That state splits across the TWO properties `option` supports,
        // because the menu holds two different kinds of it:
        //   - radio rows ("Turn into") are a single-select set — exactly one
        //     block type is current — which is what aria-selected means. The
        //     container is a single-select listbox (no aria-multiselectable),
        //     so AT may hear at most ONE selected option in the whole menu.
        //   - check rows (the callout fold toggle) are an independent on/off
        //     that is CHECKED, not selected — the state the row carried before
        //     the listbox move. Both properties are valid on `option`, so the
        //     toggle keeps aria-checked while selection stays with the set
        //     that actually has one.
        // Collapsing both onto aria-selected made a collapsed-by-default
        // callout announce TWO selected options ("Callout" and "Collapsed by
        // default") in a single-select listbox — invalid — and lost the checked
        // semantic on the way. Command rows (Duplicate, Delete, …) hold no
        // state and so claim neither: aria-selected's default is `undefined`,
        // which reads as "not selectable" — exactly what a command is.
        row.setAttribute("role", "option");
        row.tabIndex = -1;
        if (opts.radio) {
            row.setAttribute("aria-selected", opts.active ? "true" : "false");
        } else if (opts.check) {
            row.setAttribute("aria-checked", opts.active ? "true" : "false");
        }
        row.classList.toggle("block-menu-item--active", Boolean(opts.active));
        row.classList.toggle("block-menu-item--danger", Boolean(opts.danger));
        if (opts.disabled) {
            row.setAttribute("aria-disabled", "true");
        }
        // Leading 16px slot: text badge ("H1".."H6") or SVG icon — the slash
        // menu's exact row anatomy.
        const slot = document.createElement("span");
        slot.setAttribute("aria-hidden", "true");
        if (opts.badge) {
            slot.className = "block-menu-item-badge";
            slot.textContent = opts.badge;
        } else {
            slot.className = "block-menu-item-icon";
            slot.innerHTML = opts.icon ?? "";
        }
        const text = document.createElement("span");
        text.className = "block-menu-item-label";
        text.textContent = label;
        row.append(slot, text);
        if (opts.hint) {
            const hint = document.createElement("span");
            hint.className = opts.hintIsNote
                ? "block-menu-item-hint block-menu-item-hint--note"
                : "block-menu-item-hint";
            hint.textContent = opts.hint;
            row.appendChild(hint);
        }
        // Hover and keyboard share ONE highlight: pointing at a row moves
        // the same --hl the arrows move, so Enter always fires the row
        // that looks selected (the slash menu's lesson).
        row.addEventListener("mouseover", () => {
            if (!opts.disabled) {
                setHl(rowEls().indexOf(row));
            }
        });
        bindActivate(row, () => {
            if (opts.disabled) {
                return;
            }
            close();
            // Identity guard (see anchorNode above): never act on a block
            // that is no longer the one this menu was opened for.
            if (view.state.doc.nodeAt(blockPos) === anchorNode) {
                // Pre-place the caret in the target block for MUTATING
                // actions: history snapshots the selection before the
                // transaction, so undo/redo restore (and scroll) here — not
                // to wherever the caret happened to sit (see selectInto).
                if (opts.mutates !== false && !opts.actsOnSelection) {
                    selectInto(view, blockPos);
                }
                opts.action();
            }
        });
        body.appendChild(row);
        return row;
    };
    const addHeader = (label: string): void => {
        const header = document.createElement("div");
        header.className = "ui-heading ui-menu-heading block-menu-header";
        // Presentational inside the listbox (the slash menu's group-label
        // idiom) — a group label, not a selectable option.
        header.setAttribute("role", "presentation");
        header.textContent = label;
        body.appendChild(header);
    };
    const addDivider = (): void => {
        const divider = document.createElement("div");
        divider.className = "ui-menu-divider block-menu-divider";
        // A listbox owns `option` and `group` — `separator` is not a permitted
        // child, so the rule it draws is presentational here (the same call the
        // section header above makes). A real `role="group"` + aria-label per
        // section would expose MORE than this does, but the rows are a flat
        // list that the filter and the highlight index address by position;
        // regrouping them is its own change, not a rider on this one.
        divider.setAttribute("role", "presentation");
        body.appendChild(divider);
    };

    // ── Row specs ──
    // Both sections as filterable specs: `build` renders via addRow, and
    // label+keywords feed the slash menu's matcher (filterSlashItems) when
    // the user types in the search input. Blocks with no nameable kind
    // (tables, HR, image/html paragraphs, raw blocks) get an actions-only
    // menu; conversions the matrix can't perform for THIS source (e.g.
    // anything from a code block) are hidden rather than disabled — a
    // never-possible row is noise, unlike the move rows' temporarily-
    // impossible edges.
    interface RowSpec {
        label: string;
        keywords: readonly string[];
        section: "table" | "turnInto" | "numbering" | "actions";
        build: () => HTMLElement;
    }
    const specs: RowSpec[] = [];
    // ── Table section (MAR-118): the caret's cell/row/column unit ──
    // Rendered FIRST for a ⌘. inside a table — the unit the caret is in
    // outranks the table-block actions below it. Every row dispatches the
    // SAME contributed command id the native right-click menu invokes
    // (shared/editorCommands.ts), carrying the cell target the way the
    // context menu's data-vscode-context round-trip does, so the two
    // surfaces cannot drift. Labels match the contributed titles exactly.
    // No "Delete Table" row: the Actions section's Delete IS delete-table
    // for a table block, and one destructive verb per menu is enough.
    const cellPos = opts?.cellPos;
    if (
        anchorNode?.type.name === "table" &&
        typeof cellPos === "number" &&
        cellPos > blockPos &&
        cellPos < blockPos + anchorNode.nodeSize
    ) {
        const tableRow = (
            label: string,
            keywords: readonly string[],
            icon: string,
            commandId: EditorCommandId,
            danger?: boolean,
        ): void => {
            specs.push({
                label,
                keywords,
                section: "table",
                build: () => addRow(label, {
                    icon,
                    ...(danger ? { danger: true } : {}),
                    action: () => runEditorCommand(commandId, getEditor, { cellPos }),
                }),
            });
        };
        tableRow(t("Insert Row Above"), ["table", "insert", "row", "above"], IconPlus, "tableInsertRowAbove");
        tableRow(t("Insert Row Below"), ["table", "insert", "row", "below"], IconPlus, "tableInsertRowBelow");
        tableRow(t("Insert Column Left"), ["table", "insert", "column", "left"], IconPlus, "tableInsertColumnLeft");
        tableRow(t("Insert Column Right"), ["table", "insert", "column", "right"], IconPlus, "tableInsertColumnRight");
        tableRow(t("Align Column Left"), ["table", "align", "column", "left"], IconAlignLeft, "tableAlignColumnLeft");
        tableRow(t("Align Column Center"), ["table", "align", "column", "center"], IconAlignCenter, "tableAlignColumnCenter");
        tableRow(t("Align Column Right"), ["table", "align", "column", "right"], IconAlignRight, "tableAlignColumnRight");
        tableRow(t("Delete Row"), ["table", "delete", "remove", "row"], IconTrash2, "tableDeleteRow", true);
        tableRow(t("Delete Column"), ["table", "delete", "remove", "column"], IconTrash2, "tableDeleteColumn", true);
    }
    // The Turn-into rows: over the covered run when there is one, else over
    // the anchor block. One loop, because the two differ only in what the
    // source kinds are and which converter runs.
    const sourceKinds: (ConversionKind | null)[] = coveredRun ? runKinds : [currentKind];
    if (sourceKinds.some((kind) => kind !== null)) {
        const offered = TURN_INTO_CHOICES.filter(({ kind }) => coveredRun
            ? canConvertRange(view, coveredRun, kind)
            : canConvert(view, conversionPos, kind));
        for (const choice of offered) {
            // The row is "current" only when EVERY source block already is
            // that kind; a mixed run has no current row, and its pick still
            // converts the blocks that differ (the rest join as they are).
            const active = sourceKinds.every((kind) => kind === choice.kind);
            // A degrading pick says what it costs, in the slot that would
            // otherwise repeat the markdown for a block type the user is
            // already looking at, over every source kind that differs. The
            // current-type row costs nothing.
            const loss = active
                ? null
                : [...new Set(sourceKinds)]
                    .map((kind) => (kind === null || kind === choice.kind
                        ? null
                        : conversionLossNote(kind, choice.kind)))
                    .filter((note): note is string => note !== null)
                    .join(", ") || null;
            specs.push({
                label: choice.label,
                keywords: choice.keywords,
                section: "turnInto",
                build: () => addRow(choice.label, {
                    radio: true,
                    active,
                    icon: choice.icon,
                    ...(choice.badge !== undefined && { badge: choice.badge }),
                    ...(loss !== null
                        ? { hint: loss, hintIsNote: true }
                        : choice.hint !== undefined && { hint: choice.hint }),
                    ...(coveredRun !== null && { actsOnSelection: true }),
                    action: () => {
                        if (active) {
                            return;
                        }
                        if (coveredRun) {
                            convertRange(view, coveredRun, choice.kind, getEditor);
                        } else {
                            convertAt(view, conversionPos, choice.kind, getEditor);
                        }
                    },
                }),
            });
        }
    }
    const action = (
        label: string,
        keywords: readonly string[],
        opts: Parameters<typeof addRow>[1],
    ): void => {
        specs.push({ label, keywords, section: "actions", build: () => addRow(label, opts) });
    };
    action(t("Duplicate"), ["duplicate", "copy", "clone"], {
        icon: IconCopy,
        action: () => duplicateBlock(view, blockPos),
    });
    // Direct block serialization — the shared copyAsMarkdown command prefers
    // a non-empty ambient selection, which would violate this menu's
    // by-position contract (select text in block A, copy block B → get A).
    action(t("Copy as Markdown"), ["copy", "markdown", "clipboard", "source"], {
        icon: IconFileText,
        mutates: false,
        action: () => {
            const markdown = blockMarkdownAt(view, blockPos, getEditor);
            if (markdown !== null) {
                notifyClipboardWrite("markdown", markdown);
            }
        },
    });
    if (isHeading) {
        action(t("Copy Link"), ["link", "anchor", "copy", "url"], {
            icon: IconLink,
            mutates: false,
            action: () => copyHeadingLink(view, blockPos),
        });
    }
    // ── Open the link under the caret (MAR-118) ── the keyboard path to
    // what Cmd+Click does, through the popup's own routing (linkPopup).
    // Offered only when the CARET actually sits in this menu's block: the
    // menu's contract is by-position, and a mouse open on another block's
    // marker must not surface a row that would act on the caret's block
    // instead. The row re-resolves at activation (openLinkAtCaret), so a
    // stale link is a no-op, not a mis-open.
    {
        const { $head } = view.state.selection;
        const caretInBlock =
            anchorNode !== null &&
            $head.pos >= blockPos &&
            $head.pos <= blockPos + anchorNode.nodeSize;
        if (caretInBlock && linkAtCaret(view) !== null) {
            action(t("Open Link"), ["open", "follow", "link", "url", "go"], {
                icon: IconExternalLink,
                mutates: false,
                action: () => {
                    openLinkAtCaret(view);
                },
            });
        }
    }
    // ── Image rows (MAR-118) ── the keyboard paths to the NodeView's own
    // chrome: the zoom button's lightbox (same surface, same Escape layer)
    // and the toolbar's editors (alt caption, title, path) plus the width
    // cycle. An image lives in a paragraph (the gutter's "Image" marker
    // unit); the FIRST image is the paragraph's identity — a multi-image
    // paragraph is rare enough that per-image targeting stays with the
    // mouse/NodeView.
    {
        let image: ProseNode | null = null;
        let imageOffset = 0;
        if (anchorNode?.type.name === "paragraph") {
            anchorNode.forEach((child: ProseNode, offset: number) => {
                if (image === null && child.type.name === "image") {
                    image = child;
                    imageOffset = offset;
                }
            });
        }
        if (image !== null) {
            const src = String((image as ProseNode).attrs["src"] ?? "");
            const alt = String((image as ProseNode).attrs["alt"] ?? "");
            const imagePos = blockPos + 1 + imageOffset;
            if (src !== "") {
                action(t("View Fullscreen"), ["image", "fullscreen", "zoom", "view", "lightbox", "preview"], {
                    icon: IconMaximize2,
                    mutates: false,
                    action: () => openImageLightbox(src, alt),
                });
            }
            // The edit rows hand focus to the NodeView's inputs (selecting
            // the image pins its toolbar open); inside, the inputs' own
            // contracts take over — Enter commits, Escape reverts, both
            // return focus to the editor.
            action(t("Edit Alt Text"), ["image", "alt", "caption", "description", "text", "edit"], {
                icon: IconPencil,
                action: () => { focusImageInputAt(view, imagePos, "alt"); },
            });
            action(t("Edit Image Title"), ["image", "title", "tooltip", "hover", "edit"], {
                icon: IconPencil,
                action: () => { focusImageInputAt(view, imagePos, "title"); },
            });
            action(t("Edit Image Path"), ["image", "path", "src", "url", "file", "rename", "edit"], {
                icon: IconPencil,
                action: () => { focusImageInputAt(view, imagePos, "path"); },
            });
            // Width cycle: the row IS the control-column button (same verb
            // computation, same store write) — presentation only, so it
            // neither dirties the file nor moves the caret.
            const width = imageWidthControlAt(view, imagePos);
            if (width) {
                action(width.verb, ["image", "width", "full", "fit", "natural", "size"], {
                    icon: IconExpandHorizontal,
                    mutates: false,
                    action: width.cycle,
                });
            }
        }
    }
    if (
        anchorNode?.type.name === "table" &&
        view.state.doc.resolve(blockPos).depth === 0 &&
        // In FULL-width page mode a table already fills the pane — the row
        // would be a dead switch (the control column hides its twin too).
        !document.body.classList.contains("editor-width-auto")
    ) {
        // Per-block width (blockWidth.ts): tables have no header chrome, so
        // the toggle lives here — images/code/embeds carry theirs in their
        // own chrome. A settings-style toggle, not a doc edit (mutates:
        // false — the markdown never changes and nothing lands in undo
        // history); the table NodeView listens and applies the class.
        // Top-level only: a nested table's box isn't the content column.
        // The SAME occurrence-disambiguated key the table's own NodeView uses
        // (blockWidth.ts) — two surfaces for one preference, so they must
        // resolve identically or the row and the in-table toggle disagree.
        const widthAnchor = anchorAt(view.state.doc, blockPos, tableAnchorBase)
            ?? tableWidthAnchor(anchorNode.firstChild?.textContent ?? "");
        const isFullWidth = getBlockWidth(widthAnchor) === "full";
        action(t("Full Width"), ["width", "full", "wide", "fixed", "narrow", "size"], {
            icon: IconExpandHorizontal,
            check: true,
            active: isFullWidth,
            mutates: false,
            action: () => setBlockWidth(widthAnchor, isFullWidth ? null : "full"),
        });
    }
    if (anchorNode?.type.name === "callout") {
        // T1 write path (MAR-110): a deliberate, undoable document edit that
        // writes/removes the Obsidian `[!kind]-` fold marker — the syntax
        // sets the DEFAULT state; chevron clicks stay transient and never
        // touch the marker. Re-synthesized like a kind change (case, title
        // bytes preserved); the fold meta syncs the visual state to the new
        // default in the same single-undo-step transaction.
        const defaultCollapsed = ((anchorNode.attrs["fold"] as string) ?? "") === "-";
        action(t("Collapsed by default"), ["collapse", "fold", "default", "marker"], {
            check: true,
            active: defaultCollapsed,
            icon: IconChevronRight,
            action: () => {
                const node = view.state.doc.nodeAt(blockPos);
                if (node?.type.name !== "callout") {
                    return;
                }
                const nextFold = defaultCollapsed ? "" : "-";
                const marker = markerWithFold((node.attrs["marker"] as string) ?? "[!NOTE]", nextFold);
                const tr = view.state.tr.setNodeMarkup(
                    blockPos,
                    null,
                    attrsFromMarker(marker, node.attrs["attached"] as boolean),
                );
                tr.setMeta(headingFoldPluginKey, {
                    type: "set",
                    pos: blockPos,
                    folded: nextFold === "-",
                } satisfies HeadingFoldMeta);
                view.dispatch(tr);
                view.focus();
            },
        });
    }
    if (isItem && anchorNode?.attrs["checked"] != null) {
        // Reset a task list for reuse (MAR-175): clear every checked box in the
        // whole checklist, nested sublists included, in one undo step. The row
        // is disabled when nothing is checked so it is never a dead action.
        // The action clears the OUTERMOST list containing the caret
        // (uncheckAllTasks), so the disabled check scans that same outermost
        // tree — scoping the two differently would enable a row that clears
        // nothing, or disable one that could.
        let listNode = view.state.doc.nodeAt(conversionPos);
        const $list = view.state.doc.resolve(conversionPos);
        for (let depth = 1; depth <= $list.depth; depth++) {
            const name = $list.node(depth).type.name;
            if (name === "bullet_list" || name === "ordered_list") {
                listNode = $list.node(depth);
                break;
            }
        }
        let hasChecked = false;
        listNode?.descendants((n) => {
            if (n.type.name === "list_item" && n.attrs["checked"] === true) {
                hasChecked = true;
            }
            return !hasChecked;
        });
        action(t("Uncheck All Tasks"), ["uncheck", "clear", "reset", "tasks", "checklist", "todo"], {
            icon: IconCheckSquare,
            disabled: !hasChecked,
            action: () => uncheckAllTasks(view),
        });
        // Discoverable home for birta.checklist.sinkChecked (MAR-175): a
        // settings toggle, not a doc edit (mutates: false — never moves the
        // caret), with menuitemcheckbox state showing the current value.
        action(t("Move Checked Tasks to Bottom"), ["sink", "move", "checked", "bottom", "sort", "tasks"], {
            icon: IconArrowDownToLine,
            check: true,
            active: isChecklistSinkEnabled(),
            mutates: false,
            action: () => setChecklistSinkEnabled(!isChecklistSinkEnabled()),
        });
    }
    if (isItem) {
        // ── Numbering: how THIS ordered list draws its markers ──
        // A real, undoable transaction (the style is a node attr), unlike the
        // width rows next door which write only to the store — so `mutates`
        // keeps its default and the caret is placed first, which is what makes
        // undo land back on this list. It still never dirties the FILE: the
        // attr is absent from ordered_list's toMarkdown, so the document
        // serializes byte-identically and editor.ts's sync equality check
        // no-ops. The bag write follows from the reconcile pass
        // (plugins/listNumbering.ts).
        //
        // `conversionPos` already IS this item's own parent list (see its
        // derivation above), which is the right target for the same reason
        // Turn-into uses it: the marker you clicked belongs to that list, so a
        // numbering choice restyles the level the marker is on and never a
        // parent from inside a sublist.
        const listNode = view.state.doc.nodeAt(conversionPos);
        // A task item draws a checkbox INSTEAD of its marker (`list-style: none`
        // and an emptied `::marker`, style.css), so a list whose every item is a
        // task has no marker for a numbering to change. Offering the rows there
        // is a dead control, the same reason Full Width hides itself in
        // full-width page mode. A MIXED list keeps them: its plain items still
        // draw markers.
        const everyItemIsTask = listNode?.type.name === "ordered_list"
            && listNode.childCount > 0
            && (() => {
                let allTasks = true;
                listNode.forEach((item: ProseNode) => {
                    if (item.attrs["checked"] == null) {
                        allTasks = false;
                    }
                });
                return allTasks;
            })();
        if (listNode?.type.name === "ordered_list" && !everyItemIsTask) {
            const list = { pos: conversionPos, node: listNode };
            const current = isOrderedNumbering(listNode.attrs["numbering"])
                ? listNode.attrs["numbering"]
                : "decimal";
            for (const choice of NUMBERING_CHOICES) {
                const active = choice.style === current;
                specs.push({
                    label: choice.label,
                    keywords: choice.keywords,
                    section: "numbering",
                    build: () => addRow(choice.label, {
                        radio: true,
                        active,
                        hint: choice.hint,
                        action: () => {
                            if (active) {
                                return;
                            }
                            if (setListNumberingAt(view, list.pos, choice.style)) {
                                view.focus();
                            }
                        },
                    }),
                });
            }
        }
        // Adjacent same-type sibling lists are the file's own split (a
        // `-`→`*` marker change — edit-created adjacency auto-joins, see
        // listAutoJoinPlugin), so merging is offered, never assumed. Rows
        // exist only when a mergeable neighbor does — an absent neighbor
        // makes the action never-possible for this block, and the menu's
        // convention hides those rather than disabling them.
        const mergeAbove = mergeableListBoundary(view.state.doc, conversionPos, -1);
        const mergeBelow = mergeableListBoundary(view.state.doc, conversionPos, 1);
        if (mergeAbove !== null) {
            action(t("Merge with List Above"), ["merge", "join", "combine", "list", "above"], {
                icon: IconList,
                action: () => mergeListsAt(view, mergeAbove),
            });
        }
        if (mergeBelow !== null) {
            action(t("Merge with List Below"), ["merge", "join", "combine", "list", "below"], {
                icon: IconList,
                action: () => mergeListsAt(view, mergeBelow),
            });
        }
        // Tight/loose is the author's character — the editor never rewrites
        // it on its own (the spread normalizer is force-only) — so the
        // deliberate switch lives here. One toggle row, named for the state
        // it will CREATE, applied to the whole outermost list tree. Tighten
        // keeps any blank line Markdown requires (a multi-paragraph item).
        // blockPos sits INSIDE the list chain (conversionPos is before it).
        const outer = outermostListAt(view.state.doc.resolve(blockPos));
        if (outer) {
            const loose = listTreeIsLoose(view.state.doc, outer.pos);
            action(
                loose ? t("Tighten List") : t("Loosen List"),
                ["tighten", "loosen", "spacing", "spread", "blank", "lines", "compact", "list"],
                {
                    icon: IconList,
                    action: () => setListTreeSpread(view, outer.pos, !loose),
                },
            );
        }
    }
    action(movesSection ? t("Move Section Up") : t("Move Up"), ["move", "up", "reorder"], {
        icon: IconChevronUp,
        disabled: !canMove(view, blockPos, -1),
        action: () => moveBlockAt(view, blockPos, -1),
    });
    action(movesSection ? t("Move Section Down") : t("Move Down"), ["move", "down", "reorder"], {
        icon: IconChevronDown,
        disabled: !canMove(view, blockPos, 1),
        action: () => moveBlockAt(view, blockPos, 1),
    });
    // ── Refile (MAR-118) — the keyboard path to drag-refile. Hidden rather
    // than disabled when impossible (the merge-rows convention: possibility
    // hangs on this block's neighbors/ancestry, and a block with no container
    // in reach makes the action never-possible from here).
    if (canIndentAt(view, blockPos)) {
        action(t("Indent"), ["indent", "nest", "sink", "move", "into", "refile"], {
            icon: IconChevronRight,
            action: () => indentBlockAt(view, blockPos),
        });
    }
    if (canOutdentAt(view, blockPos)) {
        action(t("Outdent"), ["outdent", "unnest", "lift", "move", "out", "refile"], {
            icon: IconChevronLeft,
            action: () => outdentBlockAt(view, blockPos),
        });
    }
    // Document-wide fold verbs (MAR-110) — palette + block menu only (the
    // Cmd+K fold chords are consumed by insertLink in this editor). Not
    // block-scoped, so they never pre-place the caret (mutates: false).
    action(t("Fold All"), ["fold", "collapse", "all", "sections"], {
        icon: IconChevronRight,
        mutates: false,
        disabled: !foldAllCommand(view.state),
        action: () => foldAllCommand(view.state, view.dispatch),
    });
    action(t("Unfold All"), ["unfold", "expand", "all", "sections"], {
        icon: IconChevronDown,
        mutates: false,
        disabled: !unfoldAllCommand(view.state),
        action: () => unfoldAllCommand(view.state, view.dispatch),
    });
    // The block's own kind rides the keywords so "delete table" (or "delete
    // code") finds this row — the generic Delete IS delete-<kind> for the
    // anchor block, and without the kind word the filter answered "No
    // matching actions" (found by the MAR-118 lane).
    action(t("Delete"), ["delete", "remove", "trash", ...(anchorNode?.type.name.split("_") ?? [])], {
        icon: IconTrash2,
        danger: true,
        action: () => deleteBlock(view, blockPos),
    });

    // ── Render (and re-render per filter keystroke) ──
    // Empty query: today's grouped sections. Non-empty: one flat ranked
    // list across both sections — ranking beats grouping, the slash menu's
    // rule — with the top row pre-highlighted so Enter always acts.
    const renderRows = (query: string): void => {
        body.textContent = "";
        const q = query.trim();
        if (q === "") {
            // Table (cell/row/column) rows lead: with a caret inside a
            // table, ⌘. is asking about the unit under the caret first.
            const table = specs.filter((spec) => spec.section === "table");
            if (table.length > 0) {
                addHeader(t("Table"));
                for (const spec of table) {
                    spec.build();
                }
                addDivider();
            }
            const turnInto = specs.filter((spec) => spec.section === "turnInto");
            if (turnInto.length > 0) {
                // The count is the same phrase the drag pill uses for a run
                // ("3 blocks"), so the two say the same thing about the
                // same selection.
                addHeader(coveredRun
                    ? `${t("Turn")} ${runKinds.length} ${t("blocks into")}`
                    : isItem ? t("Turn list into") : t("Turn into"));
                for (const spec of turnInto) {
                    spec.build();
                }
                addDivider();
            }
            const numbering = specs.filter((spec) => spec.section === "numbering");
            if (numbering.length > 0) {
                addHeader(t("Numbering"));
                for (const spec of numbering) {
                    spec.build();
                }
                addDivider();
            }
            addHeader(t("Actions"));
            for (const spec of specs) {
                if (spec.section === "actions") {
                    spec.build();
                }
            }
        } else {
            const ranked = filterSlashItems(specs, q);
            if (ranked.length === 0) {
                const empty = document.createElement("div");
                empty.className = "block-menu-empty";
                empty.textContent = t("No matching actions");
                body.appendChild(empty);
            }
            for (const spec of ranked) {
                spec.build();
            }
        }
        // aria-expanded tracks whether the listbox is actually showing
        // options — a zero-match filter ("No matching actions") collapses it,
        // like the slash menu's zero-match state.
        search.setAttribute(
            "aria-expanded",
            String(body.querySelector(".block-menu-item") !== null),
        );
        if (q === "") {
            clearHl(); // browsing: no pre-highlight, grouped sections
        } else {
            setHl(0); // filtering: top match pre-highlighted so Enter acts
        }
        naturalHeight = 0; // content changed — remeasure before positioning
        position();
    };
    search.addEventListener("input", () => renderRows(search.value));

    // The target-block tint (the Editor.js/Notion "what will this hit" cue)
    // is pure CSS: hosts match `:has(.heading-fold-marker--menu-open)`.
    // Deliberately NOT a classList mutation on the block's own element —
    // ProseMirror's DOM observer treats that as an unexpected mutation and
    // redraws the node, recreating this menu's anchor widget out from under
    // it. Widget-internal class changes (the marker's --menu-open) are
    // invisible to the observer.

    document.body.appendChild(menu);
    anchor.classList.add("heading-fold-marker--menu-open");
    anchor.setAttribute("aria-expanded", "true");
    menu.addEventListener("focusout", onFocusOut);

    // Position below the marker from a FRESH anchor rect, flipping/clamping
    // to stay on screen — called at open and again on every scroll. The menu
    // never intrudes into the fixed topbar's band, and when neither side can
    // hold it whole it takes the LARGER side and scrolls internally (its
    // max-height is set to the space actually available) — clamping a
    // full-height menu used to occlude its own anchor and slide under the
    // topbar/sticky-heading chrome.
    // The menu's content is fixed after build — measure its natural height
    // once (lazily, after mount) instead of clearing maxHeight per scroll,
    // which would force double reflows and clamp the menu's own scrollTop.
    let naturalHeight = 0;
    function position(): void {
        if (!menu.isConnected) {
            return;
        }
        const rect = anchor.getBoundingClientRect();
        const topbarBottom = getTopbarBottom();
        const mw = menu.offsetWidth;
        if (naturalHeight === 0) {
            naturalHeight = menu.offsetHeight;
        }
        const left = clampLeft(rect.left, mw, viewportSize());

        // The below-side start line is the anchor's bottom OR the topbar
        // band's floor, whichever is lower: an anchor scrolled under the bar
        // clamps the menu to the band, and the available space must be
        // measured from that clamped line — measuring from the (hidden)
        // anchor and clamping afterward pushed the menu down WITHOUT
        // shrinking it, overflowing the viewport bottom.
        const belowStart = Math.max(rect.bottom + 4, topbarBottom + 8);
        const spaceBelow = window.innerHeight - 8 - belowStart;
        const spaceAbove = rect.top - 4 - (topbarBottom + 8);
        const below = naturalHeight <= spaceBelow || spaceBelow >= spaceAbove;
        const space = Math.max(below ? spaceBelow : spaceAbove, 48);
        menu.style.maxHeight = naturalHeight > space ? `${Math.floor(space)}px` : "";
        const height = Math.min(naturalHeight, space);
        const top = below ? belowStart : rect.top - 4 - height;
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(Math.max(topbarBottom + 8, top))}px`;
    }
    renderRows("");

    closeActiveBlockMenu = close;
    // Escape-layer bookkeeping: the menu's own document-capture handler
    // still claims Escape first (it runs before the layer stack ever sees
    // the key), so registering only keeps the stack's picture of "what is
    // open" honest — close() drops the entry on every close path.
    const escapeLayerOff = registerEscapeLayer(close);
    // Synchronous registration is safe: this runs from the marker's `click`,
    // whose mousedown already happened — the next mousedown is genuinely
    // outside. (A deferred add could leak if close() raced the timeout.)
    outsideOff = onOutsideClick([menu, anchor], close);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onWindowBlur);
    hideTooltip();

    // The search input is focused for BOTH open modes (the Notion pattern:
    // the menu opens ready to filter). Escape still restores marker/editor
    // focus per the open mode above.
    search.focus();
}
