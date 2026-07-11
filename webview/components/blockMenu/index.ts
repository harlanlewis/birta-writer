/**
 * components/blockMenu/index.ts
 *
 * The gutter block menu (MAR-78) — opened by clicking a block's gutter marker
 * (`#`..`######`, `P`, …). Two sections:
 *   - **Turn into**: real markdown conversions — P / H1–H6, the three list
 *     types, blockquote, callout, code block — with the block's current type
 *     filled (the shared check glyph). Turning a block into a code block
 *     preserves its literal markdown source inside the fence.
 *   - **Block actions**: Duplicate, Delete, Move Up/Down, Copy as Markdown,
 *     and Copy Link on headings (slug anchors are the only block identity
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
import type { Node as ProseNode } from "@milkdown/prose/model";
import { findHeadingFoldRange, getHeadingLevel } from "../../plugins/headingFold";
import { runEditorCommand, type GetEditor } from "../../editorCommands";
import { notifyClipboardWrite } from "../../messaging";
import { slugify } from "../../utils/slug";
import { hideTooltip } from "../../ui/tooltip";
import { t } from "../../i18n";
import { canTurnInto, turnBlockInto, turnIntoKindAt, type TurnIntoKind } from "./turnInto";

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
    if (node.type.name === "heading") {
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
 * paragraph when the last block goes). */
function deleteBlock(view: EditorView, pos: number): boolean {
    const node = view.state.doc.nodeAt(pos);
    if (!node) {
        return false;
    }
    view.dispatch(view.state.tr.deleteRange(pos, pos + node.nodeSize));
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
 * Move the block (heading: its section) one unit up or down, as a single
 * undoable transaction. Returns false at a document edge.
 * Exported for unit testing and reuse by the drag handle (MAR-19).
 */
export function moveBlockAt(view: EditorView, pos: number, dir: -1 | 1): boolean {
    const range = moveRangeAt(view, pos);
    if (!range) {
        return false;
    }
    const { doc } = view.state;
    const isHeading = doc.nodeAt(pos)?.type.name === "heading";
    const target = moveTargetFor(doc, range, isHeading, dir);
    if (target === null) {
        return false;
    }
    const slice = doc.slice(range.from, range.to);
    const tr = view.state.tr.delete(range.from, range.to);
    // Upward: the insertion point precedes the deleted range, unaffected by
    // the delete. Downward: map the old end through the deletion.
    const insertAt = dir === -1 ? target : tr.mapping.map(target);
    tr.insert(insertAt, slice.content);
    view.dispatch(tr);
    view.focus();
    return true;
}

/** Whether a move in `dir` has somewhere to go (drives row disabling). */
function canMove(view: EditorView, pos: number, dir: -1 | 1): boolean {
    const range = moveRangeAt(view, pos);
    if (!range) {
        return false;
    }
    const isHeading = view.state.doc.nodeAt(pos)?.type.name === "heading";
    return moveTargetFor(view.state.doc, range, isHeading, dir) !== null;
}

/** Copy `[text](#slug)` for the heading at `pos` (its TOC anchor). */
function copyHeadingLink(view: EditorView, pos: number): void {
    const node = view.state.doc.nodeAt(pos);
    if (!node || node.type.name !== "heading") {
        return;
    }
    const text = node.textContent.trim();
    notifyClipboardWrite("markdown", `[${text}](#${slugify(text)})`);
}

// ── The menu ────────────────────────────────────────────────────────────────

const TURN_INTO_CHOICES: { kind: TurnIntoKind; label: string }[] = [
    { kind: "paragraph", label: "P" },
    { kind: "h1", label: "H1" },
    { kind: "h2", label: "H2" },
    { kind: "h3", label: "H3" },
    { kind: "h4", label: "H4" },
    { kind: "h5", label: "H5" },
    { kind: "h6", label: "H6" },
    { kind: "bulletList", label: "Bullet List" },
    { kind: "orderedList", label: "Ordered List" },
    { kind: "taskList", label: "Task List" },
    { kind: "blockquote", label: "Blockquote" },
    { kind: "callout", label: "Callout" },
    { kind: "codeBlock", label: "Code Block" },
];

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

    const currentKind = turnIntoKindAt(view, blockPos);
    const isHeading = view.state.doc.nodeAt(blockPos)?.type.name === "heading";

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
            close();
            anchor.focus();
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
    function close(): void {
        if (closeActiveBlockMenu === close) {
            closeActiveBlockMenu = null;
        }
        anchor.classList.remove("heading-fold-marker--menu-open");
        document.removeEventListener("mousedown", onDocMouseDown, true);
        document.removeEventListener("keydown", onKeyDown, true);
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
            action: () => void;
        },
    ): HTMLElement => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "block-menu-item";
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
        const check = document.createElement("span");
        check.className = "menu-check";
        check.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.className = "block-menu-item-label";
        text.textContent = label;
        row.append(check, text);
        row.addEventListener("mousedown", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (opts.disabled) {
                return;
            }
            close();
            opts.action();
        });
        menu.appendChild(row);
        return row;
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
        const offered = TURN_INTO_CHOICES.filter(({ kind }) => canTurnInto(view, blockPos, kind));
        for (const { kind, label } of offered) {
            const active = kind === currentKind;
            const row = addRow(t(label), {
                radio: true,
                active,
                action: () => {
                    if (!active) {
                        turnBlockInto(view, blockPos, kind, getEditor);
                    }
                },
            });
            if (active) {
                activeRow = row;
            }
            // The wordy conversions start after H6 — visually split them from
            // the compact level radio the menu grew out of.
            if (kind === "h6" && offered.some((c) => !c.kind.startsWith("h") && c.kind !== "paragraph")) {
                addDivider();
            }
        }
        addDivider();
    }

    // ── Block actions ──
    addRow(t("Duplicate"), { action: () => duplicateBlock(view, blockPos) });
    addRow(t("Copy as Markdown"), {
        action: () => runEditorCommand("copyAsMarkdown", getEditor, { blockPos }),
    });
    if (isHeading) {
        addRow(t("Copy Link"), { action: () => copyHeadingLink(view, blockPos) });
    }
    addRow(isHeading ? t("Move Section Up") : t("Move Up"), {
        disabled: !canMove(view, blockPos, -1),
        action: () => moveBlockAt(view, blockPos, -1),
    });
    addRow(isHeading ? t("Move Section Down") : t("Move Down"), {
        disabled: !canMove(view, blockPos, 1),
        action: () => moveBlockAt(view, blockPos, 1),
    });
    addRow(t("Delete"), { danger: true, action: () => deleteBlock(view, blockPos) });

    document.body.appendChild(menu);
    anchor.classList.add("heading-fold-marker--menu-open");
    menu.addEventListener("focusout", onFocusOut);

    // Position below the marker, flipping/clamping to stay on screen.
    const rect = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = rect.left;
    if (left + mw > window.innerWidth - 8) {
        left = window.innerWidth - 8 - mw;
    }
    left = Math.max(8, left);
    let top = rect.bottom + 4;
    if (top + mh > window.innerHeight - 8) {
        top = rect.top - 4 - mh;
    }
    top = Math.max(8, top);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;

    closeActiveBlockMenu = close;
    // Defer the outside-click listener so the opening click doesn't close it.
    setTimeout(() => document.addEventListener("mousedown", onDocMouseDown, true), 0);
    document.addEventListener("keydown", onKeyDown, true);
    hideTooltip();

    if (viaKeyboard) {
        focusRow(activeRow ?? rowEls()[0]);
    }
}
