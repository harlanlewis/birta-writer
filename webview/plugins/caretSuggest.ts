/**
 * Generic caret-anchored suggestion controller — the machinery shared by the
 * inline link URL autocomplete (`[text](partial`, linkUrlComplete.ts) and the
 * wikilink autocomplete (`[[partial`, wikiLinkComplete.ts): match-context
 * re-evaluation per transaction, 200ms debounce, stale-reply generations,
 * Escape suppression until the caret leaves the construct, additive
 * capture-phase keyboard handling, and IME safety. The construct grammar,
 * suggestion fetch, menu rows, and pick transaction are injected per plugin.
 *
 * Keyboard interception is strictly additive: keys are only consumed while
 * the menu is open with options, from a capture-phase listener on the editor
 * DOM so it runs before ProseMirror's own keymaps (Enter must pick, not
 * split the paragraph). IME composition is never interrupted: updates are
 * skipped while composing and composition keydowns pass through.
 */
import { Plugin, type PluginKey } from "../pm";
import type { EditorView } from "../pm";
import type { LinkSuggestMenu, SuggestMenuAnchor } from "../components/pathLink/linkTargetComplete";

/** The construct ending at the caret that suggestions attach to. */
export interface CaretMatch {
    /** Doc position of the construct's opening character. */
    start: number;
    /** Caret position (right after the partial query). */
    caret: number;
    /** The partial query typed so far. */
    query: string;
    /** The construct's label text where it has one (`[text](…`); else "". */
    label: string;
}

export interface CaretSuggestSpec {
    /**
     * Parses the construct ending at the end of `textBefore` (the last ≤500
     * chars before the caret, atoms as ￼). Returns the matched length +
     * parts, or null when the caret is not in this plugin's construct.
     */
    match(textBefore: string): { length: number; query: string; label?: string } | null;
    /** Whether `query` should trigger a suggestion request at all. */
    shouldSuggest(query: string): boolean;
    /** Requests suggestions for `query`; `cb` may be called once, later. */
    fetch(query: string, cb: (items: unknown) => void): void;
    /** Builds the menu from a reply. Returns null when nothing to show. */
    buildMenu(
        items: unknown,
        match: CaretMatch,
        anchor: SuggestMenuAnchor,
        onPick: (picked: string) => void,
    ): LinkSuggestMenu | null;
    /** Applies a picked suggestion to the document. */
    pick(view: EditorView, match: CaretMatch, picked: string): void;
    /**
     * Pre-highlight the first row the moment the menu opens, so Enter/Tab pick
     * it without an arrow-key first. Used by the inline calc suggestion, where
     * the menu is a single advisory result the user confirms with Return/Tab —
     * an autocomplete list (link/wikilink) leaves this off so plain Enter keeps
     * its normal editing meaning until the user deliberately selects a row.
     */
    autoActivate?: boolean;
}

class CaretSuggestController {
    private view: EditorView;
    private readonly spec: CaretSuggestSpec;
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

    constructor(view: EditorView, spec: CaretSuggestSpec) {
        this.view = view;
        this.spec = spec;
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
        if (this.suppressed || !this.spec.shouldSuggest(match.query)) {
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

    /** The construct ending at the caret, or null. */
    private matchContext(): CaretMatch | null {
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
        const m = this.spec.match(textBefore);
        if (!m || textBefore.slice(-m.length).includes("\uFFFC")) { return null; }
        return {
            start: selection.from - m.length,
            caret: selection.from,
            query: m.query,
            label: m.label ?? "",
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
        if (!match || !this.spec.shouldSuggest(match.query)) {
            this.closeMenu();
            return;
        }
        const requestGeneration = this.closeGeneration;
        this.spec.fetch(match.query, (items) => {
            if (
                !this.destroyed &&
                !this.suppressed &&
                requestGeneration === this.closeGeneration
            ) {
                this.showMenu(items);
            }
        });
    }

    private showMenu(items: unknown): void {
        // Rendering a reply replaces the previous menu without bumping
        // closeGeneration (it is not a user-initiated close). The builder
        // re-ranks against the CURRENT partial query, so a stale (debounced)
        // reply can never show outdated options.
        this.removeMenu();
        if (this.view.composing) { return; }
        const match = this.matchContext();
        if (!match) { return; }
        const coords = this.caretCoords();
        this.menu = this.spec.buildMenu(
            items,
            match,
            {
                left: coords.left,
                top: coords.bottom + 4,
                flipTop: coords.top - 4,
            },
            (picked) => this.pick(picked),
        );
        // Advisory single-result menus (calc) pre-select their row so Return/Tab
        // confirm it directly; moveActive(1) lifts the highlight from -1 to 0.
        if (this.menu && this.spec.autoActivate) { this.menu.moveActive(1); }
    }

    /** Viewport coordinates of the caret (menu anchor). */
    private caretCoords(): { left: number; top: number; bottom: number } {
        try {
            const c = this.view.coordsAtPos(this.view.state.selection.from);
            return { left: c.left, top: c.top, bottom: c.bottom };
        } catch {
            // jsdom (unit tests) cannot measure text positions.
            return { left: 0, top: 0, bottom: 0 };
        }
    }

    // ── Picking ──────────────────────────────────────────────────────────

    private pick(picked: string): void {
        const match = this.matchContext();
        this.closeMenu();
        if (!match) { return; }
        this.spec.pick(this.view, match, picked);
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

        if (e.key === "Enter" || e.key === "Tab") {
            if (this.menu.pickActive()) {
                // A highlighted row exists (always so for an autoActivate menu;
                // for a link/wikilink list only after an arrow key or hover).
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            } else if (e.key === "Enter") {
                // No highlight: Enter keeps its normal editing meaning, but
                // the menu must not outlive the block it was anchored in.
                this.closeMenu();
            }
            // A Tab with no highlight falls through to normal tab handling
            // (indent); the menu survives and the next transaction re-evaluates.
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

/** A ProseMirror plugin whose view runs a CaretSuggestController over `spec`. */
export function caretSuggestPlugin(key: PluginKey, spec: CaretSuggestSpec): Plugin {
    return new Plugin({
        key,
        view: (editorView) => {
            const controller = new CaretSuggestController(editorView, spec);
            return {
                update: (view) => controller.update(view),
                destroy: () => controller.destroy(),
            };
        },
    });
}
