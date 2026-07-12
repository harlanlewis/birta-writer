import "./findBar.css";
import type { EditorView } from "@milkdown/prose/view";
import { TextSelection, type Transaction } from "@milkdown/prose/state";
import { createButton } from "@/ui/dom";
import {
    IconChevronUp,
    IconChevronDown,
    IconChevronRight,
    IconReplace,
    IconReplaceAll,
    IconFindSelection,
    IconX,
} from "@/ui/icons";
import { t, kbd } from "@/i18n";
import { attachInputUndo } from "@/utils/inputUndo";
import { getTopbarBottom, scrollElementBelowTopbar } from "@/utils/headingUtils";
import type { EventManager } from "@/eventManager";
import { computeLineMap } from "../../../shared/lineMap";
import {
    buildQuery,
    collectSegments,
    searchSegments,
    searchSourceFallback,
    computeBlockPositions,
    expandReplacement,
    type SearchMatch,
    type SegmentMatch,
    type TextMatch,
    type NodeAttrMatch,
    type MarkAttrMatch,
} from "./sourceSearch";

// TypeScript declarations: CSS Custom Highlight API (Chromium 105+ / Electron 22+)
declare class Highlight {
    constructor(...ranges: Range[]);
}
declare namespace CSS {
    const highlights: Map<string, Highlight>;
}

export interface FindBarController {
    open(
        initialQuery?: string,
        opts?: { showReplace?: boolean; focusReplace?: boolean },
    ): void;
    close(): void;
    isOpen(): boolean;
    /** Cmd+G / F3: next match while the editor keeps focus. */
    findNext(): void;
    /** Cmd+Shift+G / Shift+F3: previous match while the editor keeps focus. */
    findPrev(): void;
    /**
     * Cmd+D: seed the query from the selection/word on the first press and
     * select the occurrence at the caret; repeated presses advance the
     * document selection to the next occurrence (wrapping). Re-seeds when the
     * live selection no longer equals the active query.
     */
    cycleOccurrence(): void;
    /**
     * Shift+Cmd+L: seed the query from the selection/word, open with the
     * replace row focused and every occurrence highlighted — one keystroke
     * from Replace All.
     */
    selectAllOccurrences(): void;
}

/** Document-order sort position of a match. */
function sortPos(m: SearchMatch): number {
    switch (m.kind) {
        case "text":
        case "mark-attr":
            return m.from;
        case "node-attr":
            return m.nodePos;
        case "block":
            return m.blockPos;
    }
}

/**
 * Query for the find-selection command (Cmd/Ctrl+D): the selected text, or
 * the word around the caret when the selection is empty (mirroring how
 * VS Code's "add selection to next find match" seeds its query).
 */
export function selectionOrWordQuery(view: EditorView): string | undefined {
    const { selection } = view.state;
    if (!selection.empty) {
        const text = view.state.doc.textBetween(selection.from, selection.to);
        return text.trim() ? text : undefined;
    }
    const $pos = selection.$from;
    if (!$pos.parent.isTextblock) {
        return undefined;
    }
    // Leaf nodes (images, math) map to a placeholder so offsets stay aligned
    const text = $pos.parent.textBetween(0, $pos.parent.content.size, undefined, "￼");
    const off = $pos.parentOffset;
    const isWordChar = (ch: string | undefined) =>
        ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
    let start = off;
    let end = off;
    while (isWordChar(text[start - 1])) { start--; }
    while (isWordChar(text[end])) { end++; }
    return start < end ? text.slice(start, end) : undefined;
}

/** Secondary sort key: offset inside the attribute string (or the line for block hits). */
function sortSub(m: SearchMatch): number {
    switch (m.kind) {
        case "text":
            return -1;
        case "node-attr":
        case "mark-attr":
            return m.start;
        case "block":
            return m.line;
    }
}

export function initFindBar(
    getEditorView: () => EditorView | null,
    getMarkdownSource: () => string,
    eventManager: EventManager,
): FindBarController {
    // ── DOM structure ────────────────────────────────────
    const bar = document.createElement("div");
    bar.className = "find-bar";
    bar.setAttribute("role", "search");

    const btnToggleReplace = createButton({
        className: "find-bar__btn find-bar__toggle",
        icon: IconChevronRight,
        title: t("Toggle Replace"),
    });
    btnToggleReplace.setAttribute("aria-label", t("Toggle Replace"));
    btnToggleReplace.setAttribute("aria-expanded", "false");

    const rows = document.createElement("div");
    rows.className = "find-bar__rows";

    // Find row
    const findRow = document.createElement("div");
    findRow.className = "find-bar__row";

    const input = document.createElement("input");
    input.className = "find-bar__input";
    input.type = "text";
    input.placeholder = t("Find");
    input.setAttribute("aria-label", t("Find"));
    input.spellcheck = false;
    input.autocomplete = "off";

    const count = document.createElement("span");
    count.className = "find-bar__count";

    // Tooltips name only the bar-local keys (Enter / Shift+Enter): the
    // find-next/previous commands are user-rebindable contributed
    // keybindings, and the webview cannot query their effective binding,
    // so printing a default here could show a wrong shortcut.
    const btnPrev = createButton({
        className: "find-bar__btn",
        icon: IconChevronUp,
        title: `${t("Previous Match")} (${kbd("Shift-Enter")})`,
    });
    btnPrev.setAttribute("aria-label", t("Previous Match"));

    const btnNext = createButton({
        className: "find-bar__btn",
        icon: IconChevronDown,
        title: `${t("Next Match")} (Enter)`,
    });
    btnNext.setAttribute("aria-label", t("Next Match"));

    const sep = document.createElement("div");
    sep.className = "find-bar__sep";

    // Toggle accelerators follow VS Code's find widget: Alt+C/W/R, except on
    // macOS where a bare Option chord types a dead character, so ⌘⌥ instead.
    const isMac = window.__i18n?.isMac ?? /Mac/.test(navigator.platform);
    const toggleKbd = (letter: string) =>
        kbd(isMac ? `Mod-Alt-${letter}` : `Alt-${letter}`);

    const btnCase = createButton({
        className: "find-bar__btn",
        label: "Aa",
        title: `${t("Match Case")} (${toggleKbd("C")})`,
    });
    btnCase.setAttribute("aria-label", t("Match Case"));
    btnCase.setAttribute("aria-pressed", "false");

    const btnWord = createButton({
        className: "find-bar__btn",
        label: "ab",
        title: `${t("Match Whole Word")} (${toggleKbd("W")})`,
    });
    btnWord.setAttribute("aria-label", t("Match Whole Word"));
    btnWord.setAttribute("aria-pressed", "false");

    const btnRegex = createButton({
        className: "find-bar__btn",
        label: ".*",
        title: `${t("Use Regular Expression")} (${toggleKbd("R")})`,
    });
    btnRegex.setAttribute("aria-label", t("Use Regular Expression"));
    btnRegex.setAttribute("aria-pressed", "false");

    const btnInSelection = createButton({
        className: "find-bar__btn",
        icon: IconFindSelection,
        title: `${t("Find in Selection")} (${toggleKbd("L")})`,
    });
    btnInSelection.setAttribute("aria-label", t("Find in Selection"));
    btnInSelection.setAttribute("aria-pressed", "false");

    const btnClose = createButton({
        className: "find-bar__btn",
        icon: IconX,
        title: `${t("Close")} (Esc)`,
    });
    btnClose.setAttribute("aria-label", t("Close"));

    findRow.append(input, count, btnPrev, btnNext, sep, btnCase, btnWord, btnRegex, btnInSelection, btnClose);

    // Replace row (hidden until toggled)
    const replaceRow = document.createElement("div");
    replaceRow.className = "find-bar__row find-bar__row--replace";

    const replaceInput = document.createElement("input");
    replaceInput.className = "find-bar__input";
    replaceInput.type = "text";
    replaceInput.placeholder = t("Replace");
    replaceInput.setAttribute("aria-label", t("Replace"));
    replaceInput.spellcheck = false;
    replaceInput.autocomplete = "off";

    const btnReplace = createButton({
        className: "find-bar__btn",
        icon: IconReplace,
        title: `${t("Replace")} (Enter)`,
    });
    btnReplace.setAttribute("aria-label", t("Replace"));

    const btnReplaceAll = createButton({
        className: "find-bar__btn",
        icon: IconReplaceAll,
        title: `${t("Replace All")} (${kbd("Mod-Enter")})`,
    });
    btnReplaceAll.setAttribute("aria-label", t("Replace All"));

    replaceRow.append(replaceInput, btnReplace, btnReplaceAll);

    // Hint row: shown when raw-source (syntax) matches exist — they are find-only
    const hint = document.createElement("div");
    hint.className = "find-bar__hint";
    hint.hidden = true;

    rows.append(findRow, replaceRow, hint);
    bar.append(btnToggleReplace, rows);
    document.body.appendChild(bar);

    // ── State ────────────────────────────────────────────
    let visible = false;
    let replaceVisible = false;
    let caseSensitive = false;
    let wholeWord = false;
    let regexMode = false;
    /** Find-in-selection scope: search + replace-all stay within this range. */
    let inSelection = false;
    /**
     * The document range captured when Find-in-Selection was switched on
     * (null = whole document). Contiguous single-range only; positions are
     * NOT remapped across edits, so a replace-all that shifts the document
     * leaves the range approximate for the subsequent rescan (see notes on
     * the toggle handler).
     */
    let selectionScope: { from: number; to: number } | null = null;
    let matches: SearchMatch[] = [];
    let currentIdx = 0;
    let debounceTimer = 0;
    /**
     * Editor selection observed after the last search/navigation. While the
     * selection stays here, next/prev step through matches in order; once it
     * moves (the user clicked or typed elsewhere), navigation re-seeks from
     * the caret — matching VS Code's Cmd+G behavior.
     */
    let lastNavSel: { from: number; to: number } | null = null;
    /** Elements carrying attr/block highlight classes, for cleanup. */
    let markedEls: HTMLElement[] = [];

    // ── Highlight updates ────────────────────────────────
    const supportsHighlights = () => typeof CSS !== "undefined" && "highlights" in CSS;

    /** Convert a text match's PM range to a DOM Range (null if unmappable). */
    function textMatchRange(view: EditorView, m: TextMatch): Range | null {
        try {
            const start = view.domAtPos(m.from);
            const end = view.domAtPos(m.to);
            const r = new Range();
            r.setStart(start.node, start.offset);
            r.setEnd(end.node, end.offset);
            return r;
        } catch {
            return null;
        }
    }

    /** DOM element to reveal/outline for an attr or block match. */
    function matchElement(view: EditorView, m: SearchMatch): HTMLElement | null {
        try {
            if (m.kind === "node-attr") {
                const dom = view.nodeDOM(m.nodePos);
                if (dom instanceof HTMLElement) {
                    return dom;
                }
                return dom?.parentElement ?? null;
            }
            if (m.kind === "mark-attr") {
                const { node } = view.domAtPos(m.from);
                const el = node instanceof Element ? node : node.parentElement;
                return (el?.closest("a") as HTMLElement | null) ?? (el as HTMLElement | null);
            }
            if (m.kind === "block") {
                return (view.dom.children[m.blockIndex] as HTMLElement | undefined) ?? null;
            }
            if (m.kind === "text") {
                const { node } = view.domAtPos(m.from);
                return node instanceof HTMLElement ? node : node.parentElement;
            }
        } catch {
            /* decoration widgets / detached nodes: nothing to reveal */
        }
        return null;
    }

    function clearElementHighlights() {
        for (const el of markedEls.splice(0)) {
            el.classList.remove("find-match-el", "find-match-el--current");
        }
    }

    function updateHighlights() {
        const view = getEditorView();
        clearElementHighlights();

        if (view) {
            for (let i = 0; i < matches.length; i++) {
                const m = matches[i];
                if (m.kind === "text") {
                    continue;
                }
                const el = matchElement(view, m);
                if (!el) {
                    continue;
                }
                el.classList.add("find-match-el");
                el.classList.toggle("find-match-el--current", i === currentIdx);
                markedEls.push(el);
            }
        }

        if (!supportsHighlights()) {
            return;
        }
        const ranges: Range[] = [];
        let currentRange: Range | null = null;
        if (view) {
            for (let i = 0; i < matches.length; i++) {
                const m = matches[i];
                if (m.kind !== "text") {
                    continue;
                }
                const r = textMatchRange(view, m);
                if (!r) {
                    continue;
                }
                ranges.push(r);
                if (i === currentIdx) {
                    currentRange = r;
                }
            }
        }
        if (!ranges.length) {
            CSS.highlights.delete("find-highlight");
            CSS.highlights.delete("find-highlight-current");
            return;
        }
        CSS.highlights.set("find-highlight", new Highlight(...ranges));
        if (currentRange) {
            CSS.highlights.set("find-highlight-current", new Highlight(currentRange));
        } else {
            CSS.highlights.delete("find-highlight-current");
        }
    }

    function clearHighlights() {
        clearElementHighlights();
        if (!supportsHighlights()) {
            return;
        }
        CSS.highlights.delete("find-highlight");
        CSS.highlights.delete("find-highlight-current");
    }

    function updateHint() {
        const syntaxCount = matches.filter((m) => m.kind === "block").length;
        if (syntaxCount > 0) {
            hint.textContent = `${syntaxCount} ${t("syntax matches (find only, not replaceable)")}`;
            hint.hidden = false;
        } else {
            hint.textContent = "";
            hint.hidden = true;
        }
    }

    // ── Search ───────────────────────────────────────────
    /**
     * Run a search for `query`. When `opts.literal` is set the query is matched
     * as literal text regardless of the persisted Regex toggle — used by the
     * seed paths (Cmd+D / Shift+Cmd+L) so selecting `a.b` or `foo(` matches the
     * selection verbatim rather than as a regex pattern (VS Code always seeds a
     * literal). The Regex toggle still governs whatever the user types by hand.
     */
    function search(query: string, opts: { literal?: boolean } = {}) {
        matches = [];
        currentIdx = 0;
        bar.classList.remove("find-bar--invalid");

        if (!query) {
            count.textContent = "";
            bar.classList.remove("find-bar--no-results");
            updateHighlights();
            updateHint();
            return;
        }

        const compiled = buildQuery(query, {
            regex: opts.literal ? false : regexMode,
            wholeWord,
            caseSensitive,
        });
        if (compiled.error !== undefined) {
            count.textContent = t("Invalid pattern");
            bar.classList.add("find-bar--invalid");
            bar.classList.remove("find-bar--no-results");
            input.setAttribute("aria-invalid", "true");
            updateHighlights();
            updateHint();
            return;
        }
        input.removeAttribute("aria-invalid");

        const view = getEditorView();
        if (!view) {
            count.textContent = "";
            lastNavSel = null;
            updateHint();
            return;
        }

        // Tier 1: precise, replace-capable matches over doc text + attributes
        const doc = view.state.doc;
        const segMatches: SegmentMatch[] = searchSegments(collectSegments(doc), compiled.re);

        // Tier 2: raw markdown source fallback for pure-syntax hits (find-only)
        const source = getMarkdownSource();
        const blockPositions = computeBlockPositions(doc);
        const blockMatches = source
            ? searchSourceFallback(source, computeLineMap(source), compiled.re, segMatches, blockPositions)
            : [];

        matches = [...segMatches, ...blockMatches].sort(
            (a, b) => sortPos(a) - sortPos(b) || sortSub(a) - sortSub(b),
        );

        // Find-in-selection: keep only matches inside the captured range.
        if (inSelection && selectionScope) {
            const { from, to } = selectionScope;
            matches = matches.filter((m) => {
                if (m.kind === "text") {
                    return m.from >= from && m.to <= to;
                }
                const pos = sortPos(m);
                return pos >= from && pos <= to;
            });
        }

        if (matches.length) {
            count.textContent = `1/${matches.length}`;
            bar.classList.remove("find-bar--no-results");
            scrollToMatch(0);
        } else {
            count.textContent = t("No results");
            bar.classList.add("find-bar--no-results");
        }
        // Baseline for caret-relative navigation (see lastNavSel)
        const sel = view.state.selection;
        lastNavSel = { from: sel.from, to: sel.to };
        updateHighlights();
        updateHint();
    }

    function scrollToMatch(idx: number) {
        if (!matches[idx]) {
            return;
        }
        currentIdx = idx;
        count.textContent = `${currentIdx + 1}/${matches.length}`;
        updateHighlights();
        const view = getEditorView();
        if (!view) {
            return;
        }
        const el = matchElement(view, matches[idx]);
        if (el) {
            const topbarH = getTopbarBottom();
            const rect = el.getBoundingClientRect();
            if (rect.top < topbarH + 8 || rect.bottom > window.innerHeight - 8) {
                scrollElementBelowTopbar(el, 60, "auto");
            }
        }
    }

    /** Index of the first match after (dir=1) / last match before (dir=-1) `sel`, wrapping around. */
    function seekFromCaret(sel: { from: number; to: number }, dir: 1 | -1): number {
        if (dir === 1) {
            const idx = matches.findIndex((m) => sortPos(m) >= sel.to);
            return idx === -1 ? 0 : idx;
        }
        for (let i = matches.length - 1; i >= 0; i--) {
            if (sortPos(matches[i]) < sel.from) {
                return i;
            }
        }
        return matches.length - 1;
    }

    /**
     * Move the editor caret to the end of `m` so navigation and typing agree
     * on where the user is (text matches only — attr/block matches have no
     * addressable caret position). Records the navigation baseline either way.
     */
    function placeCaret(m: SearchMatch) {
        const view = getEditorView();
        if (!view) {
            lastNavSel = null;
            return;
        }
        if (m.kind === "text") {
            try {
                view.dispatch(
                    view.state.tr.setSelection(TextSelection.create(view.state.doc, m.to)),
                );
            } catch {
                /* unmappable position (stale match): keep the old caret */
            }
        }
        const sel = view.state.selection;
        lastNavSel = { from: sel.from, to: sel.to };
    }

    function navigate(dir: 1 | -1) {
        if (!matches.length) {
            return;
        }
        const view = getEditorView();
        const sel = view?.state.selection;
        const moved =
            sel !== undefined &&
            lastNavSel !== null &&
            (sel.from !== lastNavSel.from || sel.to !== lastNavSel.to);
        const idx = moved
            ? seekFromCaret(sel, dir)
            : (currentIdx + dir + matches.length) % matches.length;
        scrollToMatch(idx);
        placeCaret(matches[idx]);
    }

    function goNext() {
        navigate(1);
    }

    function goPrev() {
        navigate(-1);
    }

    /**
     * Editor-focused navigation (Cmd+G / F3): when the bar is hidden, reopen
     * it with the last query (or the current selection) WITHOUT stealing
     * focus, landing on the first match at/after the caret.
     */
    function findFrom(dir: 1 | -1) {
        if (visible) {
            navigate(dir);
            return;
        }
        if (!input.value) {
            const sel = selectionQuery();
            if (sel !== undefined) {
                input.value = sel;
            }
        }
        if (!input.value) {
            open(); // nothing to search for: behave like Cmd+F
            return;
        }
        visible = true;
        bar.classList.add("find-bar--visible");
        search(input.value);
        const view = getEditorView();
        if (view && matches.length) {
            const idx = seekFromCaret(view.state.selection, dir);
            scrollToMatch(idx);
            placeCaret(matches[idx]);
        }
    }

    // ── Occurrence cycling (Cmd+D / Shift+Cmd+L) ─────────

    /**
     * Index of the match at the caret — the one containing `sel.from`, else
     * the first at/after it, wrapping to 0. Unlike seekFromCaret (which lands
     * on the NEXT match, for "find next"), Cmd+D's first press selects the
     * occurrence the user is already sitting in.
     */
    function seekCurrent(sel: { from: number; to: number }): number {
        for (let i = 0; i < matches.length; i++) {
            const m = matches[i];
            const start = sortPos(m);
            const end = m.kind === "text" ? m.to : start;
            if (start <= sel.from && sel.from <= end) { return i; }
            if (start >= sel.from) { return i; }
        }
        return 0;
    }

    /**
     * Move the document selection to span match `idx` (text matches only —
     * attr/block matches have no addressable range, so they only scroll into
     * view). Selecting the whole match lets the user type to replace it, which
     * is the point of Cmd+D. Refocuses the editor and records the nav baseline.
     */
    function selectMatch(idx: number) {
        if (!matches[idx]) { return; }
        scrollToMatch(idx);
        const view = getEditorView();
        if (!view) {
            lastNavSel = null;
            return;
        }
        const m = matches[idx];
        if (m.kind === "text") {
            try {
                view.dispatch(
                    view.state.tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to)),
                );
                view.focus();
            } catch {
                /* unmappable position (stale match): keep the old selection */
            }
        }
        const sel = view.state.selection;
        lastNavSel = { from: sel.from, to: sel.to };
    }

    /**
     * Cmd+D. Re-seed rule: seed a fresh query (from the selection or the word
     * at the caret) whenever the bar is not already searching that exact text
     * — i.e. the bar is closed/empty, or the live selection text differs from
     * the active query. Otherwise advance to the next occurrence. Because each
     * step SELECTS its match, the selection equals the query on the following
     * press, so repeated Cmd+D naturally cycles.
     */
    function cycleOccurrence() {
        const view = getEditorView();
        if (!view) { return; }
        const sel = view.state.selection;
        const selText = sel.empty ? "" : view.state.doc.textBetween(sel.from, sel.to);
        const active = input.value;
        const searching = visible && active !== "" && matches.length > 0;
        const shouldSeed = !searching || selText !== active;

        if (shouldSeed) {
            const query = selectionOrWordQuery(view);
            if (query === undefined) {
                // Nothing under the caret to seed: fall back to plain Find.
                open();
                return;
            }
            // A fresh occurrence hunt is a new global search: drop any active
            // find-in-selection scope (and reset its toggle) so seeding a word
            // outside the old scope isn't silently filtered to nothing.
            setInSelection(false);
            visible = true;
            bar.classList.add("find-bar--visible");
            input.value = query;
            // Seed literally: the raw selection is text to find, not a regex
            // pattern, even if the Regex toggle was left on (see search()).
            search(query, { literal: true });
            if (matches.length) {
                selectMatch(seekCurrent(sel));
            }
            return;
        }

        if (!matches.length) { return; }
        const moved =
            lastNavSel !== null &&
            (sel.from !== lastNavSel.from || sel.to !== lastNavSel.to);
        const idx = moved ? seekCurrent(sel) : (currentIdx + 1) % matches.length;
        selectMatch(idx);
    }

    /**
     * Shift+Cmd+L. Seed from the selection/word and open with the replace row
     * focused, every occurrence highlighted — the pragmatic "change every X"
     * entry point (type a replacement, Cmd+Enter to replace all).
     */
    function selectAllOccurrences() {
        const view = getEditorView();
        // A fresh occurrence hunt: drop any active find-in-selection scope so
        // the seeded query searches the whole document.
        setInSelection(false);
        open(view ? selectionOrWordQuery(view) : undefined, {
            showReplace: true,
            focusReplace: true,
            // Seed literally regardless of the Regex toggle (see search()).
            seedLiteral: true,
        });
    }

    // ── Replace ──────────────────────────────────────────

    /** Replacement text for a match: expands $n groups in regex mode. */
    function replacementFor(m: SegmentMatch): string {
        const template = replaceInput.value;
        return regexMode ? expandReplacement(template, m.exec) : template;
    }

    /** Current value of the attribute an attr match points at. */
    function currentAttrValue(view: EditorView, m: NodeAttrMatch | MarkAttrMatch): string | null {
        if (m.kind === "node-attr") {
            const node = view.state.doc.nodeAt(m.nodePos);
            if (!node) {
                return null;
            }
            const value = node.attrs[m.attr];
            return typeof value === "string" ? value : null;
        }
        const value = m.mark.attrs[m.attr];
        return typeof value === "string" ? value : null;
    }

    /**
     * Add the attribute rewrite for `m` (with `newValue`) to the transaction.
     * Attr rewrites never shift document positions. Node attrs are read from
     * `tr.doc` so earlier rewrites to other attrs of the same node (e.g.
     * image src + alt in one Replace All) are preserved.
     */
    function applyAttrRewrite(
        tr: Transaction,
        m: NodeAttrMatch | MarkAttrMatch,
        newValue: string,
    ): Transaction {
        if (m.kind === "node-attr") {
            const node = tr.doc.nodeAt(m.nodePos);
            if (!node) {
                return tr;
            }
            return tr.setNodeMarkup(m.nodePos, null, { ...node.attrs, [m.attr]: newValue });
        }
        const newMark = m.mark.type.create({ ...m.mark.attrs, [m.attr]: newValue });
        return tr.removeMark(m.from, m.to, m.mark).addMark(m.from, m.to, newMark);
    }

    /** Lexicographic key used to pick the next match after a replacement. */
    function matchKey(m: SearchMatch): [number, number] {
        return [sortPos(m), sortSub(m)];
    }

    function keyGte(a: [number, number], b: [number, number]): boolean {
        return a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);
    }

    function flashHint() {
        if (hint.hidden) {
            return;
        }
        hint.classList.add("find-bar__hint--flash");
        window.setTimeout(() => hint.classList.remove("find-bar__hint--flash"), 600);
    }

    function replaceCurrent() {
        const view = getEditorView();
        if (!view || !matches.length) {
            return;
        }
        const m = matches[currentIdx];
        if (m.kind === "block") {
            // Pure-syntax matches live only in the raw source; skip past them
            flashHint();
            goNext();
            return;
        }

        const replacement = replacementFor(m);
        let nextKey: [number, number];
        if (m.kind === "text") {
            view.dispatch(view.state.tr.insertText(replacement, m.from, m.to));
            // Advance past the inserted text so a replacement containing the
            // query does not get matched again immediately
            nextKey = [m.from + replacement.length, -1];
        } else {
            const value = currentAttrValue(view, m);
            if (value === null) {
                return;
            }
            const newValue = value.slice(0, m.start) + replacement + value.slice(m.end);
            view.dispatch(applyAttrRewrite(view.state.tr, m, newValue));
            nextKey = [sortPos(m), m.start + replacement.length];
        }

        // Rescan the updated document, then advance to the first match at or
        // after the replacement
        search(input.value);
        if (matches.length) {
            const idx = matches.findIndex((mm) => keyGte(matchKey(mm), nextKey));
            scrollToMatch(idx === -1 ? 0 : idx);
        }
    }

    function replaceAll() {
        const view = getEditorView();
        if (!view || !matches.length) {
            return;
        }
        const texts: TextMatch[] = [];
        const attrGroups = new Map<string, (NodeAttrMatch | MarkAttrMatch)[]>();
        for (const m of matches) {
            if (m.kind === "text") {
                texts.push(m);
            } else if (m.kind === "node-attr" || m.kind === "mark-attr") {
                const key = m.kind === "node-attr" ? `n:${m.nodePos}:${m.attr}` : `m:${m.from}:${m.attr}`;
                const group = attrGroups.get(key);
                if (group) {
                    group.push(m);
                } else {
                    attrGroups.set(key, [m]);
                }
            }
            // block matches are raw-source syntax and intentionally skipped
        }
        if (!texts.length && !attrGroups.size) {
            flashHint();
            return;
        }

        let tr = view.state.tr;

        // Attribute rewrites first — they do not shift positions. Multiple
        // hits on the same attribute value are folded right-to-left into one
        // rewrite so each offset stays valid against the original string.
        for (const group of attrGroups.values()) {
            const value = currentAttrValue(view, group[0]);
            if (value === null) {
                continue;
            }
            let next = value;
            for (const m of [...group].sort((a, b) => b.start - a.start)) {
                next = next.slice(0, m.start) + replacementFor(m) + next.slice(m.end);
            }
            tr = applyAttrRewrite(tr, group[0], next);
        }

        // Text replacements in reverse document order keep earlier positions
        // valid; the single transaction keeps everything one undo step.
        for (let i = texts.length - 1; i >= 0; i--) {
            tr = tr.insertText(replacementFor(texts[i]), texts[i].from, texts[i].to);
        }
        view.dispatch(tr);

        const hadSyntax = matches.some((m) => m.kind === "block");
        search(input.value);
        if (hadSyntax) {
            flashHint();
        }
    }

    function setReplaceVisible(show: boolean) {
        replaceVisible = show;
        bar.classList.toggle("find-bar--replace-visible", show);
        btnToggleReplace.innerHTML = show ? IconChevronDown : IconChevronRight;
        btnToggleReplace.setAttribute("aria-expanded", String(show));
    }

    // ── Event bindings ───────────────────────────────────
    // Local undo/redo: VS Code intercepts Cmd+Z before native inputs see it.
    // The bar is long-lived (never torn down), so attaching once is fine.
    attachInputUndo(input);
    attachInputUndo(replaceInput);

    input.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => search(input.value), 150);
    });

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) { goPrev(); } else { goNext(); }
        } else if (e.key === "Escape") {
            e.preventDefault();
            close();
        } else if ((e.metaKey || e.ctrlKey) && e.code === "KeyF") {
            e.preventDefault();
        } else if (e.key === "Tab" && !e.shiftKey && replaceVisible) {
            // VS Code find-widget convention: Tab jumps straight to the
            // replace input, skipping the find row's buttons.
            e.preventDefault();
            e.stopPropagation();
            replaceInput.focus();
            replaceInput.select();
        }
    });

    replaceInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            if (e.metaKey || e.ctrlKey) { replaceAll(); } else { replaceCurrent(); }
        } else if (e.key === "Escape") {
            e.preventDefault();
            close();
        } else if (e.key === "Tab" && e.shiftKey) {
            // Mirror of Tab-from-find: back to the find input, not the
            // close button that precedes this row in DOM order.
            e.preventDefault();
            e.stopPropagation();
            input.focus();
            input.select();
        }
    });

    // The input shortcuts above skip the find row's buttons, so close the
    // Tab loop at the widget's edges or those buttons become unreachable
    // by keyboard while the replace row is open: forward wraps after
    // Replace All to the first find-row button, backward mirrors it.
    // Escape remains the way out (it returns focus to the editor).
    btnReplaceAll.addEventListener("keydown", (e) => {
        if (e.key === "Tab" && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            btnPrev.focus();
        }
    });
    btnPrev.addEventListener("keydown", (e) => {
        if (e.key === "Tab" && e.shiftKey && replaceVisible) {
            e.preventDefault();
            e.stopPropagation();
            btnReplaceAll.focus();
        }
    });

    btnNext.addEventListener("click", goNext);
    btnPrev.addEventListener("click", goPrev);
    btnClose.addEventListener("click", close);
    btnReplace.addEventListener("click", replaceCurrent);
    btnReplaceAll.addEventListener("click", replaceAll);
    btnToggleReplace.addEventListener("click", () => {
        setReplaceVisible(!replaceVisible);
        if (replaceVisible) { replaceInput.focus(); }
    });

    function bindToggle(btn: HTMLButtonElement, get: () => boolean, set: (v: boolean) => void) {
        btn.addEventListener("click", () => {
            set(!get());
            btn.classList.toggle("find-bar__btn--active", get());
            btn.setAttribute("aria-pressed", String(get()));
            search(input.value);
        });
    }
    bindToggle(btnCase, () => caseSensitive, (v) => { caseSensitive = v; });
    bindToggle(btnWord, () => wholeWord, (v) => { wholeWord = v; });
    bindToggle(btnRegex, () => regexMode, (v) => { regexMode = v; });

    // Find-in-selection captures the editor selection AT toggle time (VS
    // Code's widget behavior); switching off drops the scope. Toggling on with
    // a collapsed caret has no range to scope, so we stay OFF rather than latch
    // a pressed-but-inert toggle (a button that looks active but doesn't
    // restrict the search).
    function setInSelection(on: boolean) {
        if (on) {
            const view = getEditorView();
            const sel = view?.state.selection;
            if (sel && !sel.empty) {
                selectionScope = { from: sel.from, to: sel.to };
                inSelection = true;
            } else {
                selectionScope = null;
                inSelection = false;
            }
        } else {
            selectionScope = null;
            inSelection = false;
        }
        btnInSelection.classList.toggle("find-bar__btn--active", inSelection);
        btnInSelection.setAttribute("aria-pressed", String(inSelection));
    }
    btnInSelection.addEventListener("click", () => {
        setInSelection(!inSelection);
        search(input.value);
    });

    // Toggle accelerators (see toggleKbd above) work from anywhere in the
    // bar, mirroring VS Code's find widget.
    bar.addEventListener("keydown", (e) => {
        const chord = isMac
            ? e.metaKey && e.altKey && !e.ctrlKey
            : e.altKey && !e.ctrlKey && !e.metaKey;
        if (!chord || e.shiftKey) { return; }
        const btn = e.code === "KeyC" ? btnCase
            : e.code === "KeyW" ? btnWord
            : e.code === "KeyR" ? btnRegex
            : e.code === "KeyL" ? btnInSelection
            : null;
        if (btn) {
            e.preventDefault();
            e.stopPropagation();
            btn.click();
        }
    });

    // Stop mousedown inside the bar from bubbling into the editor
    bar.addEventListener("mousedown", (e) => e.stopPropagation());

    // Esc with focus in the editor content closes the bar (the input handlers
    // above cover Esc while the bar itself has focus — relevant since find
    // navigation leaves focus in the editor). Bubble phase so overlays that
    // claim Escape first (menus, lightbox) win via preventDefault;
    // stopPropagation keeps the chord from also reaching the workbench.
    eventManager.onDocument("keydown", (e) => {
        if (
            visible &&
            e.key === "Escape" &&
            !e.defaultPrevented &&
            e.target instanceof Element &&
            e.target.closest(".ProseMirror") !== null
        ) {
            e.stopPropagation();
            close();
        }
    });

    /** Current editor selection text, used to pre-fill the find input. */
    function selectionQuery(): string | undefined {
        const view = getEditorView();
        if (!view) { return undefined; }
        const { selection, doc } = view.state;
        if (selection.empty) { return undefined; }
        const text = doc.textBetween(selection.from, selection.to);
        return text.trim() ? text : undefined;
    }

    // ── Public API ───────────────────────────────────────
    function open(
        initialQuery?: string,
        opts?: { showReplace?: boolean; focusReplace?: boolean; seedLiteral?: boolean },
    ) {
        visible = true;
        bar.classList.add("find-bar--visible");
        if (opts?.showReplace !== undefined) {
            setReplaceVisible(opts.showReplace);
        }
        if (initialQuery === undefined) {
            initialQuery = selectionQuery();
        }
        if (initialQuery !== undefined && initialQuery !== input.value) {
            input.value = initialQuery;
        }
        if (opts?.focusReplace) {
            replaceInput.focus();
            replaceInput.select();
        } else {
            input.focus();
            input.select();
        }
        // seedLiteral: the query was seeded from a selection, so match it
        // verbatim regardless of the Regex toggle (see search()).
        search(input.value, { literal: opts?.seedLiteral });
    }

    function close() {
        visible = false;
        bar.classList.remove("find-bar--visible");
        bar.classList.remove("find-bar--no-results");
        bar.classList.remove("find-bar--invalid");
        clearHighlights();
        matches = [];
        count.textContent = "";
        hint.textContent = "";
        hint.hidden = true;
        // Drop the find-in-selection scope so a later reopen never searches a
        // stale range from a previous selection.
        if (inSelection) {
            setInSelection(false);
        }
        // Hand focus back to the editor (VS Code convention on closing find)
        getEditorView()?.focus();
    }

    return {
        open,
        close,
        isOpen: () => visible,
        findNext: () => findFrom(1),
        findPrev: () => findFrom(-1),
        cycleOccurrence,
        selectAllOccurrences,
    };
}
