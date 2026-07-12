/**
 * Notion-style slash-command menu at the caret (MAR-18).
 *
 * Typing "/" at the start of a block (or after whitespace) opens a
 * filterable menu of insertable blocks anchored at the slash; the
 * characters typed after "/" are literal document text AND the filter
 * query. Enter/Tab/click deletes the "/query" text and runs the picked
 * editor command; Escape dismisses and keeps the typed text, suppressing
 * the menu until the caret leaves the construct.
 *
 * Structure mirrors linkUrlComplete.ts: all work happens in the plugin
 * view, which re-evaluates the caret context on every transaction and owns
 * the menu DOM/listeners. Keyboard interception is strictly additive —
 * keys are only consumed while the menu is open AND visible (≥1 match),
 * from a capture-phase listener on the editor DOM so it runs before
 * ProseMirror's keymaps, the document-level shortcut guard, and VS Code's
 * key forwarder. IME composition is never interrupted.
 *
 * Command execution is injected via setSlashMenuHost from webview/index.ts
 * (the setEditorCommandHost wiring precedent) so this module never imports
 * webview/editorCommands.ts — plugins/index.ts is imported BY that module's
 * consumers and a value import back would create a cycle.
 */
import { Plugin, PluginKey } from "@milkdown/prose/state";
import type { EditorState, Transaction } from "@milkdown/prose/state";
import type { ResolvedPos } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";
import { $prose } from "@milkdown/utils";
import type { EditorCommandId } from "../../shared/editorCommands";
import {
    createSlashMenu,
    SLASH_MENU_DOM_ID,
    type SlashMenuHandle,
} from "../components/slashMenu";
import {
    SLASH_MENU_ITEMS,
    type SlashMenuItem,
    type SlashMenuState,
} from "../components/slashMenu/registry";
import { setPendingRange } from "./pendingRange";

/**
 * A slash construct ending at the caret: "/" at block start or after
 * whitespace, followed by a query with no spaces and no second slash.
 * Whitespace or "/" in the query ends the construct (paths like /usr/bin
 * stop triggering); `(?:^|\s)` keeps it disjoint from linkUrlComplete's
 * `[text](…` context, whose "/" is never preceded by whitespace-or-start.
 */
export const SLASH_CONTEXT_REGEX = /(?:^|\s)\/([^\s/]*)$/;

/** The slash construct in `textBefore`, or null. Pure — exported for tests. */
export function slashContext(textBefore: string): { query: string } | null {
    const m = SLASH_CONTEXT_REGEX.exec(textBefore);
    return m ? { query: m[1] ?? "" } : null;
}

/**
 * True when a transaction is the kind of edit that should OPEN the menu:
 * actual typing. Undo/redo restoring a "/query" (history meta), external
 * file-sync rewrites (addToHistory: false), and paste/drop that happen to
 * end in "/word" must not pop the menu — the user didn't ask for it.
 * Exported for tests.
 */
export function opensSlashMenu(tr: Transaction): boolean {
    if (!tr.docChanged) {
        return false;
    }
    if (tr.getMeta("history$")) {
        return false; // undo/redo
    }
    if (tr.getMeta("addToHistory") === false) {
        return false; // external/synthetic rewrite
    }
    const uiEvent = tr.getMeta("uiEvent") as string | undefined;
    if (uiEvent === "paste" || uiEvent === "drop") {
        return false;
    }
    return true;
}

/**
 * Registry item ids hidden for the caret's current ancestors. The menu's
 * vocabulary is "insert/turn into", but the list/quote actions are TOGGLES —
 * picking "Bullet List" while already in one would REMOVE it. Hiding the
 * same-type item keeps every visible row an insertion. (Cross-type rows
 * stay: "Ordered List" inside a bullet list genuinely converts.)
 * Exported for tests.
 */
/**
 * Block-conversion items that cannot apply inside a table cell: the cell
 * schema only allows paragraph content, so setBlockType/wrap commands
 * silently no-op — AFTER the pick has consumed the "/query" text. Table
 * and divider technically "work" by inserting after the whole table,
 * which reads as an accident from inside a cell; the inline insertions
 * (image, link, math, footnote) genuinely apply and stay offered.
 */
/**
 * Every callout registry id — the always-browsable base row plus the five
 * search-only per-type rows. They share the base callout's context rules
 * (hidden inside a callout; hidden in a table cell), so this one list keeps
 * both call sites in lockstep.
 */
const CALLOUT_ITEM_IDS = [
    "callout",
    "callout-note",
    "callout-tip",
    "callout-important",
    "callout-warning",
    "callout-caution",
] as const;

const HIDDEN_IN_TABLE_CELL = [
    "paragraph",
    "heading1",
    "heading2",
    "heading3",
    "heading4",
    "heading5",
    "heading6",
    "bulletList",
    "orderedList",
    "taskList",
    "blockquote",
    ...CALLOUT_ITEM_IDS,
    "divider",
    "codeBlock",
    "mermaid",
    "mathBlock",
    "table",
] as const;

export function contextHiddenItemIds($from: ResolvedPos): Set<string> {
    const hidden = new Set<string>();
    for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth);
        switch (node.type.name) {
            case "bullet_list":
                // Lifting out is the toolbar's job, in task lists too.
                hidden.add("bulletList");
                break;
            case "ordered_list":
                hidden.add("orderedList");
                break;
            case "blockquote":
                hidden.add("blockquote");
                break;
            // Callout rows stay AVAILABLE inside callouts: insertCallout is
            // wrapIn — it NESTS (callouts are block+ at any depth, and the
            // typed `[!tip] ` input rule already nests), unlike the
            // list/quote toggles above, which would lift. Nesting
            // flexibility is the policy; table cells below stay the one
            // hard restriction (cells are paragraph-only).
            case "list_item":
            case "task_list_item":
                if (node.attrs["checked"] != null) {
                    hidden.add("taskList");
                }
                break;
            case "table_cell":
            case "table_header":
                for (const id of HIDDEN_IN_TABLE_CELL) {
                    hidden.add(id);
                }
                break;
        }
    }
    return hidden;
}

export interface SlashMenuHost {
    /** Executes a registry editor command (webview/editorCommands.ts). */
    runCommand(id: EditorCommandId, args?: unknown): void;
    /** Snapshot of toggleable UI state for dynamic toggle-row labels. */
    getState?(): SlashMenuState;
}

let _host: SlashMenuHost | null = null;

/** Wired once from webview/index.ts after the editor exists. */
export function setSlashMenuHost(host: SlashMenuHost): void {
    _host = host;
}

interface MatchContext {
    /** Doc position of the "/". */
    slashPos: number;
    /** Caret position (right after the query). */
    caret: number;
    /** The filter query typed after "/". */
    query: string;
}

const slashMenuKey = new PluginKey<{ openEligible: boolean }>("MD_SLASH_MENU");

class SlashMenuController {
    private view: EditorView;
    private menu: SlashMenuHandle | null = null;
    private lastQuery: string | null = null;
    // Set by Escape; stays set until the caret leaves the slash construct,
    // so the menu does not pop right back while typing in the same text.
    private suppressed = false;

    private readonly onKeydown = (e: KeyboardEvent): void => {
        this.handleKeydown(e);
    };
    private readonly onBlur = (): void => {
        this.closeMenu();
    };
    private readonly onWindowBlur = (): void => {
        this.closeMenu();
    };
    private readonly onScroll = (): void => {
        this.positionMenu();
    };
    // Capture phase (linkTargetComplete precedent): toolbar/TOC buttons stop
    // mousedown propagation, so a bubble-phase document listener would never
    // see clicks on them and the menu would linger. Menu-internal clicks are
    // excluded by the contains() guard before their own handlers run.
    private readonly onDocMousedown = (e: MouseEvent): void => {
        if (this.menu && !this.menu.el.contains(e.target as Node)) {
            this.closeMenu();
        }
    };

    constructor(view: EditorView) {
        this.view = view;
        // Capture phase: runs before ProseMirror's own (bubble-phase)
        // keydown handling, so an open menu can claim Enter/Tab/arrows
        // before any keymap sees them.
        view.dom.addEventListener("keydown", this.onKeydown, true);
        view.dom.addEventListener("blur", this.onBlur);
    }

    /** Plugin-view update: re-evaluate the slash context per transaction. */
    update(view: EditorView, prevState: EditorState | undefined): void {
        this.view = view;
        if (view.composing) {
            return; // IME: never react mid-composition
        }

        const match = this.matchContext();
        if (!match) {
            // Leaving the construct also lifts an Escape dismissal.
            this.suppressed = false;
            this.closeMenu();
            return;
        }
        if (this.suppressed) {
            this.closeMenu();
            return;
        }

        if (!this.menu) {
            // Open only when (a) THIS update changed the document — clicking
            // the caret into pre-existing "/text" must not open — and (b)
            // the change was real typing (see opensSlashMenu) — undoing back
            // to "/query" or pasting text ending in "/word" must not either.
            // (a) compares across the whole update; (b) reads the plugin
            // state written by the batch's last doc-changing transaction.
            const docChanged =
                prevState !== undefined && !prevState.doc.eq(view.state.doc);
            if (!docChanged || !slashMenuKey.getState(view.state)?.openEligible) {
                return;
            }
            this.openMenu(match);
            return;
        }

        // Already open: re-filter only when the query changed (unrelated
        // transactions must not reset the keyboard highlight), but always
        // re-anchor — edits above can move the slash's caret rect.
        if (match.query !== this.lastQuery) {
            this.lastQuery = match.query;
            this.menu.setQuery(match.query);
            this.syncQueryPill(match);
            this.syncAriaExpanded();
        }
        this.positionMenu();
    }

    destroy(): void {
        this.closeMenu();
        this.view.dom.removeEventListener("keydown", this.onKeydown, true);
        this.view.dom.removeEventListener("blur", this.onBlur);
    }

    // ── Match context ────────────────────────────────────────────────────

    /** The slash construct ending at the caret, or null. */
    private matchContext(): MatchContext | null {
        const { selection } = this.view.state;
        if (!selection.empty) {
            return null;
        }
        const $from = selection.$from;
        if (!$from.parent.isTextblock) {
            return null;
        }
        if ($from.parent.type.spec.code) {
            return null; // code block
        }
        if ($from.marks().some((m) => m.type.spec.code)) {
            return null; // inline code
        }
        const textBefore = $from.parent.textBetween(
            Math.max(0, $from.parentOffset - 500),
            $from.parentOffset,
            undefined,
            "￼",
        );
        const m = SLASH_CONTEXT_REGEX.exec(textBefore);
        if (!m || m[0].includes("￼")) {
            return null;
        }
        const query = m[1] ?? "";
        return {
            slashPos: selection.from - query.length - 1,
            caret: selection.from,
            query,
        };
    }

    // ── Menu lifecycle ───────────────────────────────────────────────────

    private openMenu(match: MatchContext): void {
        this.lastQuery = match.query;
        // Block-level context can't change while the query is typed within
        // the same block, so the visible item set is fixed per open.
        const hidden = contextHiddenItemIds(this.view.state.selection.$from);
        // Snapshot the toggle state once per open — it can't change while the
        // query is typed, so dynamic labels resolve against this fixed state.
        const state = _host?.getState?.();
        this.menu = createSlashMenu({
            items: SLASH_MENU_ITEMS.filter((it) => !hidden.has(it.id)),
            labelFor: state
                ? (item) => item.dynamicLabel?.(state) ?? item.label
                : undefined,
            onPick: (item) => this.apply(item),
            onActiveChange: (id) => {
                if (id) {
                    this.view.dom.setAttribute("aria-activedescendant", id);
                } else {
                    this.view.dom.removeAttribute("aria-activedescendant");
                }
            },
        });
        this.menu.setQuery(match.query);
        this.syncQueryPill(match);
        this.positionMenu();

        this.view.dom.setAttribute("aria-haspopup", "listbox");
        this.view.dom.setAttribute("aria-controls", SLASH_MENU_DOM_ID);
        this.syncAriaExpanded();

        document.addEventListener("mousedown", this.onDocMousedown, true);
        window.addEventListener("blur", this.onWindowBlur);
        // Capture phase reaches scrolls of any ancestor (the editor
        // scroller is not `window`); passive — reposition only.
        window.addEventListener("scroll", this.onScroll, {
            capture: true,
            passive: true,
        });
    }

    private closeMenu(): void {
        if (!this.menu) {
            return;
        }
        this.menu.destroy();
        this.menu = null;
        this.lastQuery = null;
        this.syncQueryPill(null);
        document.removeEventListener("mousedown", this.onDocMousedown, true);
        window.removeEventListener("blur", this.onWindowBlur);
        window.removeEventListener("scroll", this.onScroll, { capture: true });
        this.view.dom.removeAttribute("aria-haspopup");
        this.view.dom.removeAttribute("aria-expanded");
        this.view.dom.removeAttribute("aria-controls");
        this.view.dom.removeAttribute("aria-activedescendant");
    }

    /** The Notion affordance: the "/query" text feeding the filter reads
     *  as UI input, not document prose, while the menu is open. Reuses the
     *  pendingRange decoration plugin with a dedicated class. Deferred a
     *  microtask: this runs from the plugin view's update(), and a
     *  re-entrant dispatch inside applyTransaction breaks Milkdown's own
     *  state plumbing. */
    private syncQueryPill(match: MatchContext | null): void {
        const range = match === null
            ? null
            : { from: match.slashPos, to: match.caret, class: "slash-query" };
        queueMicrotask(() => {
            if (!this.view.isDestroyed) {
                setPendingRange(this.view, range);
            }
        });
    }

    /** aria-expanded must track real visibility — the zero-match state
     *  keeps the menu alive but display:none, which AT must not hear as
     *  an expanded popup. */
    private syncAriaExpanded(): void {
        this.view.dom.setAttribute(
            "aria-expanded",
            String(this.menu?.isVisible() ?? false),
        );
    }

    private positionMenu(): void {
        const match = this.matchContext();
        if (!this.menu || !match) {
            return;
        }
        // Anchor at the "/" itself — stable while the query grows.
        let coords: { left: number; top: number; bottom: number };
        try {
            const c = this.view.coordsAtPos(match.slashPos);
            coords = { left: c.left, top: c.top, bottom: c.bottom };
        } catch {
            // jsdom (unit tests) cannot measure text positions.
            coords = { left: 0, top: 0, bottom: 0 };
        }
        this.menu.position({
            left: coords.left,
            top: coords.bottom + 4,
            flipTop: coords.top - 4,
        });
    }

    // ── Picking ──────────────────────────────────────────────────────────

    private apply(item: SlashMenuItem): void {
        const match = this.matchContext();
        this.closeMenu();
        if (!match || !_host) {
            return;
        }
        // Delete the "/query" text FIRST so the block command acts on a
        // clean block ("/head" must never end up inside the new heading),
        // then run the same registry command the toolbar/palette would. No
        // view.focus() afterwards: the editor is necessarily focused at
        // pick time (blur closes the menu; row mousedown preventDefaults),
        // and host-panel commands (link, image) focus their own inputs —
        // grabbing focus back would break them.
        const { state } = this.view;
        this.view.dispatch(state.tr.delete(match.slashPos, match.caret));
        _host.runCommand(item.commandId, item.args);
    }

    // ── Keyboard ─────────────────────────────────────────────────────────

    private handleKeydown(e: KeyboardEvent): void {
        // Only intercept while the menu is open AND visible (≥1 match) and
        // never during IME composition — a hidden menu (no matches) leaves
        // every key its normal editing meaning.
        if (!this.menu || !this.menu.isVisible() || e.isComposing) {
            return;
        }

        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            this.menu.moveActive(e.key === "ArrowDown" ? 1 : -1);
            return;
        }

        if (e.key === "Enter" || e.key === "Tab") {
            if (this.menu.pickActive()) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            } else {
                this.closeMenu();
            }
            return;
        }

        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            this.suppressed = true;
            this.closeMenu();
            return;
        }
    }
}

/**
 * The composable plugin. All work happens in the plugin view: it re-checks
 * the caret context on every transaction and owns the menu DOM/listeners.
 */
export const slashMenuPlugin = $prose(() =>
    new Plugin<{ openEligible: boolean }>({
        key: slashMenuKey,
        // Per-transaction gate the view update reads: was the last DOC
        // change real typing? (The plugin view has no access to
        // transactions.) Selection-only transactions preserve the previous
        // verdict — other plugins append fix-up transactions to the same
        // dispatch batch, and the view updates once at the end.
        state: {
            init: () => ({ openEligible: false }),
            apply: (tr, prev) =>
                tr.docChanged ? { openEligible: opensSlashMenu(tr) } : prev,
        },
        view: (editorView) => {
            const controller = new SlashMenuController(editorView);
            return {
                update: (view, prevState) => controller.update(view, prevState),
                destroy: () => controller.destroy(),
            };
        },
    }),
);
