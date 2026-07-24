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
import type { EditorState, EditorView } from "../pm";
import type { LinkSuggestMenu, SuggestMenuAnchor } from "../components/pathLink/linkTargetComplete";
import { setPendingRange } from "./pendingRange";

/**
 * How far back from the caret the match window reaches, in characters. Every
 * consumer of a `match(textBefore)` spec sees at most this much context, and
 * anything that re-derives the same context elsewhere (the calc auto-insert
 * input rule, the refresh scanner's run cap) must use the SAME number — a
 * mismatch would let one surface validate what another refuses.
 */
export const CARET_CONTEXT_WINDOW = 500;

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
     * `ctx.truncated` is true when the window was cut short of the real
     * block start — position 0 is then NOT a line boundary; specs whose
     * grammar depends on line-start context (calc) must not trust it.
     * Exactly one of `match` / `matchState` must be provided.
     */
    match?(
        textBefore: string,
        ctx?: { truncated: boolean },
    ): { length: number; query: string; label?: string } | null;
    /**
     * STRUCTURAL alternative to `match`, for suggestions whose trigger is
     * the caret's position in the document tree rather than a text construct
     * (the list-merge advisory: caret in the first item of a list with a
     * same-type sibling above). Called with the same cadence as `match` —
     * every transaction, empty selections only — and its non-null span keeps
     * the same contract: the menu anchors at `caret`, and Escape suppression
     * lifts when this returns null (the caret left the context). Runs
     * per-transaction on the typing path, so it must be allocation-light.
     */
    matchState?(state: EditorState): CaretMatch | null;
    /** Whether `query` should trigger a suggestion request at all. */
    shouldSuggest(query: string): boolean;
    /**
     * Requests suggestions for `query`; `cb` may be called once, later. `ctx`
     * exposes the live editor state for suggestions that need document-wide
     * context beyond the current construct — the `=>` calc reads it to resolve
     * variables defined elsewhere in the document. Most specs ignore it.
     */
    fetch(query: string, cb: (items: unknown) => void, ctx?: { state: EditorState }): void;
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
     * Pre-highlight the first row the moment the menu opens, so Tab picks it
     * without an arrow-key first. Used by the inline calc suggestion, where the
     * menu is a single advisory result the user confirms with Tab; Enter is
     * deliberately NOT an accept key for an autoActivate menu — it keeps its
     * newline meaning (see handleKeydown), so a pre-highlighted row can never
     * capture the user's first Enter. An autocomplete list (link/wikilink)
     * leaves this off so plain Enter keeps its normal editing meaning until the
     * user deliberately selects a row (and Tab then accepts that row).
     */
    autoActivate?: boolean;
    /**
     * Decorate the live construct (match.start → caret) with this class while
     * the menu is open — the slash menu's "/query" pill affordance, shared:
     * the typed filter text reads as UI input, not prose, and reverts to
     * plain text the moment the menu closes. Rides the pendingRange
     * decoration plugin; omit for menus whose construct should stay looking
     * like ordinary text (link/wikilink/calc).
     */
    queryChipClass?: string;
    /**
     * Never open while ANOTHER caret suggestion's menu is up. The
     * text-construct menus (calc, link, wikilink) are mutually exclusive by
     * grammar, but a STRUCTURAL suggestion (the list-merge advisory) can
     * coincide with any of them — typing `2+3=` in the first item of a split
     * list matches both — and two menus would stack at the same caret, both
     * claiming Tab. The construct the user is actively typing wins; the
     * structural offer returns on the next transaction after that menu
     * closes.
     */
    yieldsToOpenMenus?: boolean;
}

// Controllers whose menu is currently OPEN — the registry `yieldsToOpenMenus`
// consults. Module-level because the controllers are independent plugin views
// that otherwise cannot see one another.
const openControllers = new Set<CaretSuggestController>();

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
        // The open menu already reflects this exact construct: nothing to
        // refetch. This guard is load-bearing for menu stability — meta-only
        // transactions (this controller's own chip sync, other plugins'
        // decorations) land here constantly, and restarting the debounce for
        // them rebuilds the menu every 200ms, resetting the arrow highlight
        // and the list's scroll position. (Cost: a doc change that alters
        // the SUGGESTIONS without touching the construct — an external sync
        // adding a heading — won't refresh an already-open menu until the
        // user types; acceptable for an advisory list.)
        if (
            this.menu && this.shownFor &&
            match.start === this.shownFor.start &&
            match.caret === this.shownFor.caret &&
            match.query === this.shownFor.query
        ) {
            return;
        }
        // An open menu's chip tracks the construct as it grows/shrinks —
        // waiting for the debounced re-fetch would leave freshly typed
        // characters outside the chip for 200ms.
        if (this.menu) { this.syncChip(match); }

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
        if (this.spec.matchState) { return this.spec.matchState(this.view.state); }
        const specMatch = this.spec.match;
        if (!specMatch) { return null; }
        const $from = selection.$from;
        if (!$from.parent.isTextblock) { return null; }
        if ($from.parent.type.spec.code) { return null; } // code block
        if ($from.marks().some((m) => m.type.spec.code)) { return null; } // inline code
        const textBefore = $from.parent.textBetween(
            Math.max(0, $from.parentOffset - CARET_CONTEXT_WINDOW),
            $from.parentOffset,
            undefined,
            "\uFFFC",
        );
        const m = specMatch(textBefore, { truncated: $from.parentOffset > CARET_CONTEXT_WINDOW });
        if (!m || textBefore.slice(-m.length).includes("\uFFFC")) { return null; }
        return {
            start: selection.from - m.length,
            caret: selection.from,
            query: m.query,
            label: m.label ?? "",
        };
    }

    // ── Menu lifecycle ───────────────────────────────────────────────────

    // The construct the current menu was built for (see the update() guard).
    private shownFor: { start: number; caret: number; query: string } | null = null;

    /** Tears down the menu DOM only — the chip survives, because every
     * caller either rebuilds immediately (showMenu) or is a deliberate
     * close that clears it itself (closeMenu). */
    private removeMenu(): void {
        this.menu?.destroy();
        this.menu = null;
        this.shownFor = null;
        openControllers.delete(this);
    }

    // The last chip range applied (-1 = none), so update()'s per-transaction
    // re-sync is a no-op unless the range really moved — syncChip itself
    // dispatches a transaction, and an unconditional re-dispatch would loop.
    private chipFrom = -1;
    private chipTo = -1;

    /** Applies/clears the query-chip decoration (see spec.queryChipClass).
     * Deferred a microtask: this runs from the plugin view's update(), and a
     * re-entrant dispatch inside applyTransaction breaks Milkdown's own state
     * plumbing (the slash menu's syncQueryPill discipline). */
    private syncChip(match: CaretMatch | null): void {
        if (!this.spec.queryChipClass) { return; }
        if (match === null && this.chipFrom === -1) { return; }
        if (match !== null && match.start === this.chipFrom && match.caret === this.chipTo) {
            return;
        }
        this.chipFrom = match === null ? -1 : match.start;
        this.chipTo = match === null ? -1 : match.caret;
        const range = match === null
            ? null
            : { from: match.start, to: match.caret, class: this.spec.queryChipClass };
        queueMicrotask(() => {
            if (this.destroyed || this.view.isDestroyed) { return; }
            // The positions were captured before the deferral — a same-task
            // transaction (a pick replacing the construct) can shrink the doc
            // under them, and an out-of-range decoration throws.
            if (range && range.to > this.view.state.doc.content.size) { return; }
            setPendingRange(this.view, range);
        });
    }

    private closeMenu(): void {
        this.closeGeneration++;
        this.removeMenu();
        this.syncChip(null);
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
        }, { state: this.view.state });
    }

    private showMenu(items: unknown): void {
        // Rendering a reply replaces the previous menu without bumping
        // closeGeneration (it is not a user-initiated close). The builder
        // re-ranks against the CURRENT partial query, so a stale (debounced)
        // reply can never show outdated options.
        this.removeMenu();
        if (this.view.composing) { this.syncChip(null); return; }
        // A yielding suggestion stands down while any OTHER menu is open —
        // two menus would stack at the same caret, both claiming Tab.
        if (this.spec.yieldsToOpenMenus && openControllers.size > 0) { this.syncChip(null); return; }
        const match = this.matchContext();
        if (!match) { this.syncChip(null); return; }
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
        if (this.menu) {
            openControllers.add(this);
            this.shownFor = { start: match.start, caret: match.caret, query: match.query };
            this.syncChip(match);
        } else {
            // Nothing to show (zero rows, composing, yielded): a construct
            // with no menu must not keep wearing the query chip.
            this.syncChip(null);
        }
        // Advisory single-result menus (calc) pre-select their row so Tab
        // confirms it directly; moveActive(1) lifts the highlight from -1 to 0.
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

        if (e.key === "Enter" && this.spec.autoActivate) {
            // An autoActivate menu (calc) pre-highlights its lone row, but Enter
            // must keep its editing meaning — a newline, not a confirm. The repo
            // principle is that a suggestion applies only on explicit consent, and
            // a pre-highlighted row would make the FIRST Enter after the menu
            // appears silently insert the result. So here Enter is NOT captured:
            // close the menu (it must not outlive the block it anchored in) and
            // return without preventDefault, letting Enter reach ProseMirror.
            // Explicit acceptance for autoActivate is Tab, handled below.
            this.closeMenu();
            return;
        }

        if (e.key === "Enter" || e.key === "Tab") {
            if (this.menu.pickActive()) {
                // A highlighted row exists (always so for an autoActivate menu,
                // where only Tab reaches here now; for a link/wikilink list only
                // after an arrow key or hover). Tab accepts it, and for a
                // non-autoActivate list Enter accepts a user-highlighted row.
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
