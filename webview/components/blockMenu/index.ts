/**
 * components/blockMenu/index.ts
 *
 * The gutter block menu (MAR-78) — opened by clicking a block's gutter marker
 * (`#`..`######`, `P`, …). Two labeled sections:
 *   - **Turn into**: real markdown conversions — P / H1–H6, the three list
 *     types, blockquote, callout, code block — the current type shown as an
 *     accent-filled row (the toolbar Format-menu idiom). Row art (icons,
 *     badges, markdown hints) comes straight from the slash-menu registry, so
 *     the two menus can never drift apart visually.
 *   - **Actions**: Duplicate, Copy as Markdown, Move Up/Down, Delete, and
 *     Copy Link on headings (slug anchors are the only block identity
 *     markdown has).
 *
 * Every action targets the block BY POSITION (like setHeadingLevelAt), never
 * the ambient selection, so the menu can change a block the caret isn't in.
 * Headings MOVE with their whole section (the fold range — outline semantics;
 * a collapsed heading must never leave its hidden content behind), while
 * Duplicate/Delete act on the heading line alone (least destructive — deleting
 * a collapsed heading simply reveals its content).
 *
 * Body-mounted like the other chrome popups; one menu open at a time; the
 * keyboard model mirrors the toolbar dropdowns (roving arrows, Enter, Escape).
 */
import type { EditorView } from "@milkdown/prose/view";
import { Fragment } from "@milkdown/prose/model";
import type { Node as ProseNode } from "@milkdown/prose/model";
import {
    findHeadingFoldRange,
    foldAllCommand,
    foldedSectionEnd,
    foldedSectionEnds,
    getHeadingLevel,
    headingFoldPluginKey,
    unfoldAllCommand,
    type HeadingFoldMeta,
} from "../../plugins/headingFold";
import { attrsFromMarker, markerWithFold } from "../../plugins/callouts";
import { BlockRangeSelection } from "../../plugins/blockRange";
import { type GetEditor } from "../../editorCommands";
import { notifyClipboardWrite, notifySetGutterMarkers } from "../../messaging";
import { GUTTER_MARKERS_DISPLAY_ORDER, type GutterMarkersMode } from "../../../shared/gutterMarkers";
import { applyGutterMarkers, currentGutterMarkersMode } from "../../utils/gutterMarkers";
import { slugify } from "../../utils/slug";
import { getTopbarBottom } from "../../utils/headingUtils";
import { hideTooltip } from "../../ui/tooltip";
import { t } from "../../i18n";
import { filterSlashItems, SLASH_MENU_ITEMS } from "../slashMenu/registry";
import {
    IconChevronDown,
    IconChevronRight,
    IconChevronUp,
    IconCopy,
    IconEye,
    IconEyeOff,
    IconFileText,
    IconLink,
    IconTrash2,
} from "../../ui/icons";
import { blockMarkdownAt, canTurnInto, selectInto, turnBlockInto, turnIntoKindAt, type TurnIntoKind } from "./turnInto";
import { flashRange } from "./rangeIndicator";
import { TextSelection, type EditorState } from "@milkdown/prose/state";

// The conversion matrix and kind helpers live in ./turnInto; re-exported so
// consumers and tests keep one import surface.
export { turnIntoKindAt, canTurnInto, turnBlockInto, isTextBearingParagraph } from "./turnInto";
export type { TurnIntoKind } from "./turnInto";

// ── Editor access ───────────────────────────────────────────────────────────
// The menu lives behind a ProseMirror widget, which only hands us the view;
// commands and the markdown serializer need the Editor ctx. Wired once from
// webview/index.ts, matching the setEditorCommandHost pattern.
let getEditor: GetEditor = () => null;

export function setBlockMenuContext(ctx: { getEditor: GetEditor }): void {
    getEditor = ctx.getEditor;
}

// ── Block actions ───────────────────────────────────────────────────────────

/**
 * The range the block at `pos` occupies for MOVE purposes: headings carry
 * their whole section (heading + fold range — outline semantics), everything
 * else is just the node. Exported for unit testing.
 */
export function moveRangeAt(view: EditorView, pos: number): { from: number; to: number } | null {
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
    view.dispatch(tr);
    view.focus();
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
 * A non-heading block hops exactly one visible UNIT — a collapsed heading
 * and its hidden section count as one (landing between them would drop the
 * moved block into display:none, an apparent deletion). A heading (moving
 * as a section) hops a whole neighboring section UNIT, so sections never
 * interleave:
 *   - down: if the next block is a heading, hop its entire fold range;
 *   - up: hop to the start of the outermost section that ends exactly where
 *     this one starts (candidates whose fold range ends at `range.from`;
 *     ancestors don't qualify — their ranges extend past us).
 */
function moveTargetFor(
    state: EditorState,
    range: { from: number; to: number },
    isHeading: boolean,
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
        if (isHeading && nextNode.type.name === "heading") {
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
    if (isHeading) {
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

/**
 * Move `range` so it starts at boundary `targetPos`, as a single transaction
 * (one undo step). Returns false for no-op targets (inside/adjacent to the
 * range). Carries the fold-preserving move meta so a collapsed section stays
 * collapsed at its destination — and nothing else inherits its fold.
 * Exported for unit testing; shared by the menu's Move rows and drag-drop.
 */
export function moveBlockTo(
    view: EditorView,
    range: { from: number; to: number },
    targetPos: number,
    opts?: { selectRun?: boolean },
): boolean {
    if (targetPos >= range.from && targetPos <= range.to) {
        return false;
    }
    const { doc } = view.state;
    // Collect the moved children directly from their common parent — a
    // doc.slice through a LIST would wrap the items in a phantom list node
    // (open slice), nesting a list inside the drop target. Works uniformly
    // for top-level blocks (parent = doc) and list items (parent = list).
    const $from = doc.resolve(range.from);
    const parent = $from.depth === 0 ? doc : $from.parent;
    const base = $from.depth === 0 ? 0 : $from.start();
    const moved: ProseNode[] = [];
    parent.forEach((child: ProseNode, offset: number) => {
        const childPos = base + offset;
        if (childPos >= range.from && childPos < range.to) {
            moved.push(child);
        }
    });
    if (moved.length === 0) {
        return false;
    }
    const content = Fragment.from(moved);
    // deleteRange (not delete): removing a list's last item must dissolve
    // the emptied list instead of leaving a schema-invalid empty node.
    const tr = view.state.tr.deleteRange(range.from, range.to);
    const sizeAfterDelete = tr.doc.content.size;
    const insertAt = tr.mapping.map(targetPos);
    tr.insert(insertAt, content);
    if (tr.doc.content.size < sizeAfterDelete + content.size) {
        // tr.insert silently no-ops when the slice can't fit (replaceStep
        // returns null — no throw). Dispatching would commit the DELETE
        // half alone: a failed move must be a no-op, never a deletion.
        return false;
    }
    tr.setMeta(headingFoldPluginKey, {
        type: "move",
        from: range.from,
        to: range.to,
        insertAt,
    } satisfies HeadingFoldMeta);
    // The selection rides the moved content — redo then restores it (and the
    // scroll) at the destination instead of jumping to a stale spot. Multi-
    // block drops keep the whole run selected (the Tiptap post-drop
    // convention) so it stays grabbable for another drag; single moves get a
    // plain caret.
    if (opts?.selectRun) {
        const runEnd = insertAt + content.size;
        // Top-level runs stay selected as a real block range (leaf blocks
        // included); item-level ranges (inside a list) would snap outward
        // to the whole list, so they keep the text-span fallback.
        const runRange = tr.doc.resolve(insertAt).depth === 0
            ? BlockRangeSelection.tryCreate(tr.doc, insertAt, runEnd)
            : null;
        tr.setSelection(
            runRange ??
            TextSelection.between(
                tr.doc.resolve(Math.min(insertAt + 1, tr.doc.content.size)),
                tr.doc.resolve(Math.max(0, Math.min(runEnd - 1, tr.doc.content.size))),
            ),
        );
    } else {
        tr.setSelection(
            TextSelection.near(tr.doc.resolve(Math.min(insertAt + 1, tr.doc.content.size))),
        );
    }
    view.dispatch(tr);
    view.focus();
    // Landing flash at the destination — positions are valid in the new doc.
    flashRange(view, insertAt, insertAt + content.size);
    return true;
}

/**
 * Move the block (heading: its section) one unit up or down. Returns false
 * at a document edge. Exported for unit testing.
 */
export function moveBlockAt(view: EditorView, pos: number, dir: -1 | 1): boolean {
    const range = moveRangeAt(view, pos);
    if (!range) {
        return false;
    }
    const { doc } = view.state;
    const node = doc.nodeAt(pos);
    // Any NESTED block (list item, or a container's child) hops among its
    // siblings via the parent-generic index walk; only top-level blocks use
    // the doc-level walk (which also carries heading sections).
    const nested = doc.resolve(pos).depth > 0;
    const target = nested
        ? moveNestedTarget(view, pos, dir)
        : moveTargetFor(view.state, range, node?.type.name === "heading", dir);
    if (target === null) {
        return false;
    }
    return moveBlockTo(view, range, target);
}

/** Whether a move in `dir` has somewhere to go (drives row disabling). */
function canMove(view: EditorView, pos: number, dir: -1 | 1): boolean {
    const range = moveRangeAt(view, pos);
    if (!range) {
        return false;
    }
    const node = view.state.doc.nodeAt(pos);
    if (view.state.doc.resolve(pos).depth > 0) {
        return moveNestedTarget(view, pos, dir) !== null;
    }
    return moveTargetFor(view.state, range, node?.type.name === "heading", dir) !== null;
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
    const base = slugify(target.textContent);
    let priorDuplicates = 0;
    doc.descendants((node: ProseNode, nodePos: number) => {
        if (node.type.name === "heading" && nodePos < pos && slugify(node.textContent) === base) {
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
const SLASH_ID_BY_KIND: Record<TurnIntoKind, string> = {
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
};

interface TurnIntoRow {
    kind: TurnIntoKind;
    label: string;
    keywords: readonly string[];
    icon: string;
    badge?: string;
    hint?: string;
}

const TURN_INTO_CHOICES: TurnIntoRow[] = (Object.keys(SLASH_ID_BY_KIND) as TurnIntoKind[]).map(
    (kind) => {
        const item = SLASH_MENU_ITEMS.find((entry) => entry.id === SLASH_ID_BY_KIND[kind]);
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

// Only one gutter menu is open at a time; opening (or clicking the same
// marker again) closes the previous one.
let closeActiveBlockMenu: (() => void) | null = null;

/** Closes the currently open block menu, if any (used by the drag handle). */
export function closeBlockMenu(): void {
    closeActiveBlockMenu?.();
}

/**
 * Open the block menu anchored to a gutter marker. Both open modes focus
 * the "Search actions…" input (the Notion pattern); `viaKeyboard` only
 * decides where focus RETURNS on Escape (the marker) vs any other close
 * (the editor).
 */
export function openBlockMenu(
    view: EditorView,
    blockPos: number,
    anchor: HTMLElement,
    viaKeyboard: boolean,
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
    // Section semantics (and the "Move Section" label) are top-level only —
    // a nested heading moves as a single block among its siblings.
    const movesSection = isHeading && view.state.doc.resolve(blockPos).depth === 0;
    const isItem = anchorNode?.type.name === "list_item";
    // An ITEM's marker still offers the LIST-level conversions (turn the
    // whole list ordered/task/prose/…): actions target the item, Turn-into
    // targets its parent list — the list node itself carries no marker.
    const conversionPos = isItem
        ? view.state.doc.resolve(blockPos).before(view.state.doc.resolve(blockPos).depth)
        : blockPos;
    const currentKind = turnIntoKindAt(view, conversionPos);

    const menu = document.createElement("div");
    menu.className = "block-menu";
    menu.setAttribute("role", "menu");

    // ── "Search actions…" (the Notion pattern): a default-focused filter
    // input; typing narrows both sections to one flat ranked list, sharing
    // the slash menu's matcher and the registry's keywords. ──
    const search = document.createElement("input");
    search.type = "text";
    search.className = "block-menu-search";
    search.placeholder = t("Search actions…");
    search.setAttribute("aria-label", t("Search actions"));
    menu.appendChild(search);
    // Rows re-render per keystroke into their own container so the input
    // (and its focus/caret) is never rebuilt.
    const body = document.createElement("div");
    body.className = "block-menu-body";
    menu.appendChild(body);

    const onDocMouseDown = (event: MouseEvent): void => {
        const target = event.target as Node;
        if (!menu.contains(target) && !anchor.contains(target)) {
            close();
        }
    };
    const rowEls = (): HTMLElement[] =>
        Array.from(menu.querySelectorAll<HTMLElement>(".block-menu-item:not([aria-disabled='true'])"));
    // Focus stays in the search input; arrows move a VIRTUAL highlight over
    // the rows (the slash menu's combobox model), mirrored to AT via
    // aria-activedescendant. Mouse hover/click on rows is unchanged.
    let hlIdx = -1;
    let rowIdSeq = 0;
    const clearHl = (): void => {
        hlIdx = -1;
        rowEls().forEach((row) => row.classList.remove("block-menu-item--hl"));
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
        list.forEach((row, i) => row.classList.toggle("block-menu-item--hl", i === hlIdx));
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
        document.removeEventListener("mousedown", onDocMouseDown, true);
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
            /** False for read-only rows (copies) — they must not move the
             * user's caret/selection. Defaults true. */
            mutates?: boolean;
            action: () => void;
        },
    ): HTMLElement => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "block-menu-item";
        row.dataset["mutates"] = opts.mutates === false ? "0" : "1";
        row.setAttribute("role", opts.radio ? "menuitemradio" : opts.check ? "menuitemcheckbox" : "menuitem");
        row.tabIndex = -1;
        if (opts.radio || opts.check) {
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
            hint.className = "block-menu-item-hint";
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
        row.addEventListener("mousedown", (event) => {
            event.preventDefault();
            event.stopPropagation();
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
                if (opts.mutates !== false) {
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
        header.className = "block-menu-header";
        header.textContent = label;
        body.appendChild(header);
    };
    const addDivider = (): void => {
        const divider = document.createElement("div");
        divider.className = "block-menu-divider";
        divider.setAttribute("role", "separator");
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
        section: "turnInto" | "actions" | "gutter";
        build: () => HTMLElement;
    }
    const specs: RowSpec[] = [];
    // Whether the search filter is narrowing (set by renderRows): gutter rows
    // render their full phrase in the flat list, short name under the header.
    let filterActive = false;
    if (currentKind !== null) {
        const offered = TURN_INTO_CHOICES.filter(({ kind }) => canTurnInto(view, conversionPos, kind));
        for (const choice of offered) {
            const active = choice.kind === currentKind;
            specs.push({
                label: choice.label,
                keywords: choice.keywords,
                section: "turnInto",
                build: () => addRow(choice.label, {
                    radio: true,
                    active,
                    icon: choice.icon,
                    ...(choice.badge !== undefined && { badge: choice.badge }),
                    ...(choice.hint !== undefined && { hint: choice.hint }),
                    action: () => {
                        if (!active) {
                            turnBlockInto(view, conversionPos, choice.kind, getEditor);
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
    action(t("Delete"), ["delete", "remove", "trash"], {
        icon: IconTrash2,
        danger: true,
        action: () => deleteBlock(view, blockPos),
    });

    // ── Gutter markers (the `markdownWysiwyg.gutterMarkers` setting) ──
    // A radio trio for which markers stay visible at rest — a display
    // preference surfaced where the markers live, not a block action. Rows
    // render their short name under the section header, but the FULL phrase
    // both in the filtered flat list (where a lone checked "None" without
    // its header would be unreadable) and as the matcher label (so "gutter"
    // prefix-matches, while "head" doesn't drop a bare radio row among the
    // Heading 1–6 conversions).
    // Row art in the menu's own language: eye-off = hidden at rest, the H1
    // badge = the heading badges, eye = everything visible (the eye pair is
    // the same show/hide vocabulary as the editor-switch commands' $(eye)
    // icons) — every other row carries art, so bare slots read as broken.
    const gutterModeRows: Record<GutterMarkersMode, { label: string; icon?: string; badge?: string }> = {
        none: { label: t("None"), icon: IconEyeOff },
        headings: { label: t("Headings"), badge: "H1" },
        all: { label: t("All"), icon: IconEye },
    };
    const activeGutterMode = currentGutterMarkersMode();
    for (const mode of GUTTER_MARKERS_DISPLAY_ORDER) {
        const rowArt = gutterModeRows[mode];
        const fullLabel = `${t("Gutter markers")}: ${rowArt.label}`;
        specs.push({
            label: fullLabel,
            keywords: ["gutter", "markers", "grabbers", "handles", "rest", "visible"],
            section: "gutter",
            build: () => addRow(filterActive ? fullLabel : rowArt.label, {
                radio: true,
                active: mode === activeGutterMode,
                mutates: false,
                ...(rowArt.icon !== undefined && { icon: rowArt.icon }),
                ...(rowArt.badge !== undefined && { badge: rowArt.badge }),
                action: () => {
                    if (mode !== activeGutterMode) {
                        applyGutterMarkers(mode);
                        notifySetGutterMarkers(mode);
                    }
                },
            }),
        });
    }

    // ── Render (and re-render per filter keystroke) ──
    // Empty query: today's grouped sections. Non-empty: one flat ranked
    // list across both sections — ranking beats grouping, the slash menu's
    // rule — with the top row pre-highlighted so Enter always acts.
    const renderRows = (query: string): void => {
        body.textContent = "";
        const q = query.trim();
        filterActive = q !== "";
        if (q === "") {
            const turnInto = specs.filter((spec) => spec.section === "turnInto");
            if (turnInto.length > 0) {
                addHeader(isItem ? t("Turn list into") : t("Turn into"));
                for (const spec of turnInto) {
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
            addDivider();
            addHeader(t("Gutter markers"));
            for (const spec of specs) {
                if (spec.section === "gutter") {
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
        let left = rect.left;
        if (left + mw > window.innerWidth - 8) {
            left = window.innerWidth - 8 - mw;
        }
        left = Math.max(8, left);

        const spaceBelow = window.innerHeight - 8 - (rect.bottom + 4);
        const spaceAbove = rect.top - 4 - (topbarBottom + 8);
        const below = naturalHeight <= spaceBelow || spaceBelow >= spaceAbove;
        const space = Math.max(below ? spaceBelow : spaceAbove, 48);
        menu.style.maxHeight = naturalHeight > space ? `${Math.floor(space)}px` : "";
        const height = Math.min(naturalHeight, space);
        const top = below ? rect.bottom + 4 : rect.top - 4 - height;
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(Math.max(topbarBottom + 8, top))}px`;
    }
    renderRows("");

    closeActiveBlockMenu = close;
    // Synchronous registration is safe: this runs from the marker's `click`,
    // whose mousedown already happened — the next mousedown is genuinely
    // outside. (A deferred add could leak if close() raced the timeout.)
    document.addEventListener("mousedown", onDocMouseDown, true);
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
