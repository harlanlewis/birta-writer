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
import type { EditorState } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { $prose } from "@milkdown/utils";
import type { EditorCommandId } from "../../shared/editorCommands";
import {
    createSlashMenu,
    SLASH_MENU_DOM_ID,
    type SlashMenuHandle,
} from "../components/slashMenu";
import type { SlashMenuItem } from "../components/slashMenu/registry";

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

export interface SlashMenuHost {
    /** Executes a registry editor command (webview/editorCommands.ts). */
    runCommand(id: EditorCommandId, args?: unknown): void;
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

const slashMenuKey = new PluginKey("MD_SLASH_MENU");

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
            // Open only when this update actually changed the document:
            // clicking the caret into pre-existing "/text" must not open
            // the menu; typing inside it must.
            const docChanged =
                prevState !== undefined && !prevState.doc.eq(view.state.doc);
            if (!docChanged) {
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
        this.menu = createSlashMenu({
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
        this.positionMenu();

        this.view.dom.setAttribute("aria-haspopup", "listbox");
        this.view.dom.setAttribute("aria-expanded", "true");
        this.view.dom.setAttribute("aria-controls", SLASH_MENU_DOM_ID);

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
        document.removeEventListener("mousedown", this.onDocMousedown, true);
        window.removeEventListener("blur", this.onWindowBlur);
        window.removeEventListener("scroll", this.onScroll, { capture: true });
        this.view.dom.removeAttribute("aria-haspopup");
        this.view.dom.removeAttribute("aria-expanded");
        this.view.dom.removeAttribute("aria-controls");
        this.view.dom.removeAttribute("aria-activedescendant");
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
        // then run the same registry action the toolbar would.
        const { state } = this.view;
        this.view.dispatch(state.tr.delete(match.slashPos, match.caret));
        _host.runCommand(item.commandId, item.args);
        this.view.focus();
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
    new Plugin({
        key: slashMenuKey,
        view: (editorView) => {
            const controller = new SlashMenuController(editorView);
            return {
                update: (view, prevState) => controller.update(view, prevState),
                destroy: () => controller.destroy(),
            };
        },
    }),
);
