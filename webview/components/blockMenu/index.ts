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
    getHeadingLevel,
    headingFoldPluginKey,
    type HeadingFoldMeta,
} from "../../plugins/headingFold";
import { BlockRangeSelection } from "../../plugins/blockRange";
import { type GetEditor } from "../../editorCommands";
import { notifyClipboardWrite } from "../../messaging";
import { slugify } from "../../utils/slug";
import { getTopbarBottom } from "../../utils/headingUtils";
import { hideTooltip } from "../../ui/tooltip";
import { t } from "../../i18n";
import { SLASH_MENU_ITEMS } from "../slashMenu/registry";
import {
    IconChevronDown,
    IconChevronUp,
    IconCopy,
    IconFileText,
    IconLink,
    IconTrash2,
} from "../../ui/icons";
import { blockMarkdownAt, canTurnInto, selectInto, turnBlockInto, turnIntoKindAt, type TurnIntoKind } from "./turnInto";
import { flashRange } from "./rangeIndicator";
import { TextSelection } from "@milkdown/prose/state";

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

/** Duplicate the node at `pos`, inserting the copy right after it. */
function duplicateBlock(view: EditorView, pos: number): boolean {
    const node = view.state.doc.nodeAt(pos);
    if (!node) {
        return false;
    }
    view.dispatch(view.state.tr.insert(pos + node.nodeSize, node));
    view.focus();
    return true;
}

/** Delete the node at `pos` (deleteRange fills the schema-required empty
 * paragraph when the last block goes). The fold meta stops a collapsed
 * heading's fold entry from transferring to whatever fills the gap. */
function deleteBlock(view: EditorView, pos: number): boolean {
    const node = view.state.doc.nodeAt(pos);
    if (!node) {
        return false;
    }
    const tr = view.state.tr.deleteRange(pos, pos + node.nodeSize);
    tr.setMeta(headingFoldPluginKey, {
        type: "delete",
        from: pos,
        to: pos + node.nodeSize,
    } satisfies HeadingFoldMeta);
    view.dispatch(tr);
    view.focus();
    return true;
}

/**
 * Where a move in `dir` would land, or null at a document edge.
 *
 * A non-heading block hops exactly one top-level block. A heading (moving as
 * a section) hops a whole neighboring UNIT, so sections never interleave:
 *   - down: if the next block is a heading, hop its entire fold range;
 *   - up: hop to the start of the outermost section that ends exactly where
 *     this one starts (candidates whose fold range ends at `range.from`;
 *     ancestors don't qualify — their ranges extend past us).
 */
function moveTargetFor(
    doc: ProseNode,
    range: { from: number; to: number },
    isHeading: boolean,
    dir: -1 | 1,
): number | null {
    if (dir === 1) {
        const nextNode = doc.nodeAt(range.to);
        if (!nextNode) {
            return null;
        }
        let hopEnd = range.to + nextNode.nodeSize;
        if (isHeading && nextNode.type.name === "heading") {
            const section = findHeadingFoldRange(doc, range.to, getHeadingLevel(nextNode));
            if (section) {
                hopEnd = section.to;
            }
        }
        return hopEnd;
    }
    let prevStart: number | null = null;
    doc.forEach((node: ProseNode, offset: number) => {
        if (offset + node.nodeSize <= range.from) {
            prevStart = offset; // last one wins — the block just before
        }
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
 * Sibling-hop target for a LIST ITEM move: the previous sibling's start or
 * the next sibling's end, null at the list's edge. Items move within their
 * own list from the menu (drag handles cross-list refile).
 */
function moveItemTarget(view: EditorView, itemPos: number, dir: -1 | 1): number | null {
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
    const insertAt = tr.mapping.map(targetPos);
    tr.insert(insertAt, content);
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
        ? moveItemTarget(view, pos, dir)
        : moveTargetFor(doc, range, node?.type.name === "heading", dir);
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
        return moveItemTarget(view, pos, dir) !== null;
    }
    return moveTargetFor(view.state.doc, range, node?.type.name === "heading", dir) !== null;
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
 * Open the block menu anchored to a gutter marker. `viaKeyboard` moves focus
 * onto the current-type row so arrows/Enter can drive it; a mouse open leaves
 * focus in the editor (mirrors the toolbar dropdowns).
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

    const onDocMouseDown = (event: MouseEvent): void => {
        const target = event.target as Node;
        if (!menu.contains(target) && !anchor.contains(target)) {
            close();
        }
    };
    const rowEls = (): HTMLElement[] =>
        Array.from(menu.querySelectorAll<HTMLElement>(".block-menu-item:not([aria-disabled='true'])"));
    const focusRow = (el: HTMLElement | undefined): void => {
        el?.focus();
    };
    // Keyboard model mirrors the toolbar dropdowns: arrows rove over rows,
    // Enter/Space activate by replaying the mousedown the row listens for,
    // Escape closes and restores marker focus. Document-level capture so
    // Escape works whether the menu was opened by mouse or keyboard.
    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
            // Keyboard users get their focus back on the marker; a mouse
            // open never moved focus, so return it to the editor (the marker
            // may also have been destroyed by a decoration rebuild).
            if (viaKeyboard && anchor.isConnected) {
                anchor.focus();
            } else {
                view.focus();
            }
            return;
        }
        const list = rowEls();
        const idx = list.indexOf(event.target as HTMLElement);
        if (idx === -1) {
            return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            focusRow(list[(idx + delta + list.length) % list.length]);
        } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            list[idx]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
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
        row.setAttribute("role", opts.radio ? "menuitemradio" : "menuitem");
        row.tabIndex = -1;
        if (opts.radio) {
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
        menu.appendChild(row);
        return row;
    };
    const addHeader = (label: string): void => {
        const header = document.createElement("div");
        header.className = "block-menu-header";
        header.textContent = label;
        menu.appendChild(header);
    };
    const addDivider = (): void => {
        const divider = document.createElement("div");
        divider.className = "block-menu-divider";
        divider.setAttribute("role", "separator");
        menu.appendChild(divider);
    };

    // ── Turn into ──
    // Blocks with no nameable kind (tables, HR, image/html paragraphs, raw
    // blocks) get an actions-only menu; conversions the matrix can't perform
    // for THIS source (e.g. anything from a code block) are hidden rather
    // than disabled — a never-possible row is noise, unlike the move rows'
    // temporarily-impossible edges below.
    let activeRow: HTMLElement | null = null;
    if (currentKind !== null) {
        addHeader(isItem ? t("Turn list into") : t("Turn into"));
        const offered = TURN_INTO_CHOICES.filter(({ kind }) => canTurnInto(view, conversionPos, kind));
        for (const choice of offered) {
            const active = choice.kind === currentKind;
            const row = addRow(choice.label, {
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
            });
            if (active) {
                activeRow = row;
            }
        }
        addDivider();
    }

    // ── Actions ──
    addHeader(t("Actions"));
    addRow(t("Duplicate"), { icon: IconCopy, action: () => duplicateBlock(view, blockPos) });
    // Direct block serialization — the shared copyAsMarkdown command prefers
    // a non-empty ambient selection, which would violate this menu's
    // by-position contract (select text in block A, copy block B → get A).
    addRow(t("Copy as Markdown"), {
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
        addRow(t("Copy Link"), {
            icon: IconLink,
            mutates: false,
            action: () => copyHeadingLink(view, blockPos),
        });
    }
    addRow(isHeading ? t("Move Section Up") : t("Move Up"), {
        icon: IconChevronUp,
        disabled: !canMove(view, blockPos, -1),
        action: () => moveBlockAt(view, blockPos, -1),
    });
    addRow(isHeading ? t("Move Section Down") : t("Move Down"), {
        icon: IconChevronDown,
        disabled: !canMove(view, blockPos, 1),
        action: () => moveBlockAt(view, blockPos, 1),
    });
    addRow(t("Delete"), { icon: IconTrash2, danger: true, action: () => deleteBlock(view, blockPos) });

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
    position();

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

    if (viaKeyboard) {
        focusRow(activeRow ?? rowEls()[0]);
    }
}
