/**
 * Inline link URL autocompletion at the caret.
 *
 * While the user is typing inside an unclosed `[text](partial` construct in
 * the document body, the same workspace-file dropdown as the link popup /
 * insert-link prompt URL fields opens anchored at the caret
 * (view.coordsAtPos). ArrowUp/Down move the highlight, Enter converts the
 * whole construct into a real link with the picked path (the same
 * transaction the ")" input rule in linkInputRule.ts would produce — input
 * rules only run on real typing, so the pick applies it directly), Escape
 * dismisses the menu until the caret leaves the construct.
 *
 * Keyboard interception is strictly additive: keys are only consumed while
 * the menu is open with options, from a capture-phase listener on the editor
 * DOM so it runs before ProseMirror's own keymaps (Enter must pick, not
 * split the paragraph). IME composition is never interrupted: updates are
 * skipped while composing and composition keydowns pass through.
 *
 * External targets (http/https/mailto/#anchor) never trigger suggestions —
 * the shared isLocalPathQuery guard from shared/linkTargetSuggest.ts.
 */
import { Plugin, PluginKey } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { $prose } from "@milkdown/utils";
import {
    createLinkSuggestMenu,
    requestLinkTargetSuggestions,
    type LinkSuggestMenu,
} from "../components/pathLink/linkTargetComplete";
import { isLocalPathQuery } from "../../shared/linkTargetSuggest";
import { createLinkifyTr } from "./linkInputRule";

/** Unclosed inline link construct ending at the caret. */
export const PARTIAL_LINK_REGEX = /\[([^\[\]]*)\]\(([^()\s]*)$/;

/** The `[text](partial` construct the caret currently sits at the end of. */
interface MatchContext {
    /** Doc position of the opening "[". */
    start: number;
    /** Caret position (right after the partial url). */
    caret: number;
    /** Link label (may be empty — the construct regex allows `[]`). */
    text: string;
    /** The partial url typed so far — the suggestion query. */
    url: string;
}

const linkUrlCompleteKey = new PluginKey("MD_LINK_URL_COMPLETE");

class LinkUrlCompleteController {
    private view: EditorView;
    private menu: LinkSuggestMenu | null = null;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private destroyed = false;
    // Bumped on every deliberate close (Escape, blur, pick, context exit):
    // replies to requests issued before the last close are stale and must
    // not re-open a menu the user already dismissed.
    private closeGeneration = 0;
    // Set by Escape; stays set until the caret leaves the match context, so
    // the menu does not pop right back while typing in the same construct.
    private suppressed = false;

    private readonly onKeydown = (e: KeyboardEvent): void => {
        this.handleKeydown(e);
    };
    private readonly onBlur = (): void => {
        this.closeMenu();
    };

    constructor(view: EditorView) {
        this.view = view;
        // Capture phase: runs before ProseMirror's own (bubble-phase) keydown
        // handling for keys targeting the content, so an open menu can claim
        // Enter/arrows before any keymap sees them.
        view.dom.addEventListener("keydown", this.onKeydown, true);
        view.dom.addEventListener("blur", this.onBlur);
    }

    /** Plugin-view update: re-evaluate the match context on every transaction. */
    update(view: EditorView): void {
        this.view = view;
        if (view.composing) { return; } // IME: never react mid-composition

        const match = this.matchContext();
        if (!match) {
            // Leaving the construct also lifts an Escape dismissal.
            this.suppressed = false;
            this.closeMenu();
            return;
        }
        if (this.suppressed || !isLocalPathQuery(match.url)) {
            this.closeMenu();
            return;
        }

        // Same 200ms debounce as the input-field autocompletion.
        if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            if (!this.destroyed) { this.request(); }
        }, 200);
    }

    destroy(): void {
        this.destroyed = true;
        if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
        this.closeMenu();
        this.view.dom.removeEventListener("keydown", this.onKeydown, true);
        this.view.dom.removeEventListener("blur", this.onBlur);
    }

    // ── Match context ────────────────────────────────────────────────────

    /** The unclosed link construct ending at the caret, or null. */
    private matchContext(): MatchContext | null {
        const { selection } = this.view.state;
        if (!selection.empty) { return null; }
        const $from = selection.$from;
        if (!$from.parent.isTextblock) { return null; }
        if ($from.parent.type.spec.code) { return null; } // code block
        if ($from.marks().some((m) => m.type.spec.code)) { return null; } // inline code
        const textBefore = $from.parent.textBetween(
            Math.max(0, $from.parentOffset - 500),
            $from.parentOffset,
            undefined,
            "\uFFFC",
        );
        const m = PARTIAL_LINK_REGEX.exec(textBefore);
        if (!m || m[0].includes("\uFFFC")) { return null; }
        return {
            start: selection.from - m[0].length,
            caret: selection.from,
            text: m[1] ?? "",
            url: m[2] ?? "",
        };
    }

    // ── Menu lifecycle ───────────────────────────────────────────────────

    private removeMenu(): void {
        this.menu?.destroy();
        this.menu = null;
    }

    private closeMenu(): void {
        this.closeGeneration++;
        this.removeMenu();
    }

    private request(): void {
        const match = this.matchContext();
        if (!match || !isLocalPathQuery(match.url)) {
            this.closeMenu();
            return;
        }
        const requestGeneration = this.closeGeneration;
        requestLinkTargetSuggestions(match.url, (items) => {
            if (
                !this.destroyed &&
                !this.suppressed &&
                requestGeneration === this.closeGeneration
            ) {
                this.showMenu(items);
            }
        });
    }

    private showMenu(items: Parameters<typeof createLinkSuggestMenu>[0]): void {
        // Rendering a reply replaces the previous menu without bumping
        // closeGeneration (it is not a user-initiated close). The builder
        // re-ranks against the CURRENT partial url, so a stale (debounced)
        // reply can never show outdated options.
        this.removeMenu();
        if (this.view.composing) { return; }
        const match = this.matchContext();
        if (!match) { return; }
        const coords = this.caretCoords();
        this.menu = createLinkSuggestMenu(
            items,
            match.url,
            { left: coords.left, top: coords.bottom + 4 },
            (picked) => this.pick(picked),
        );
    }

    /** Viewport coordinates of the caret (menu anchor). */
    private caretCoords(): { left: number; bottom: number } {
        try {
            const c = this.view.coordsAtPos(this.view.state.selection.from);
            return { left: c.left, bottom: c.bottom };
        } catch {
            // jsdom (unit tests) cannot measure text positions.
            return { left: 0, bottom: 0 };
        }
    }

    // ── Picking ──────────────────────────────────────────────────────────

    private pick(picked: string): void {
        const match = this.matchContext();
        this.closeMenu();
        if (!match) { return; }
        const { state } = this.view;
        // Convert `[text](picked` straight into a real link — exactly what
        // the ")" input rule would do if the path had been typed.
        const tr = createLinkifyTr(state, match.start, match.caret, match.text, picked);
        if (tr) {
            this.view.dispatch(tr.scrollIntoView());
        } else {
            // No usable label (e.g. `[](partial`): just complete the partial
            // path in place and let the user keep editing the literal text.
            this.view.dispatch(
                state.tr.insertText(picked, match.caret - match.url.length, match.caret),
            );
        }
        this.view.focus();
    }

    // ── Keyboard ─────────────────────────────────────────────────────────

    private handleKeydown(e: KeyboardEvent): void {
        // Only ever intercept while the menu is open with options, and never
        // during IME composition.
        if (!this.menu || e.isComposing) { return; }

        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            this.menu.moveActive(e.key === "ArrowDown" ? 1 : -1);
            return;
        }

        if (e.key === "Enter") {
            if (this.menu.pickActive()) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            } else {
                // No highlight: Enter keeps its normal editing meaning, but
                // the menu must not outlive the block it was anchored in.
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
export const linkUrlCompletePlugin = $prose(() =>
    new Plugin({
        key: linkUrlCompleteKey,
        view: (editorView) => {
            const controller = new LinkUrlCompleteController(editorView);
            return {
                update: (view) => controller.update(view),
                destroy: () => controller.destroy(),
            };
        },
    }),
);
