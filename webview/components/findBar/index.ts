import "./findBar.css";
import type { EditorView } from "@milkdown/prose/view";
import { createButton } from "@/ui/dom";
import {
    IconChevronUp,
    IconChevronDown,
    IconChevronRight,
    IconReplace,
    IconReplaceAll,
    IconX,
} from "@/ui/icons";
import { t, kbd } from "@/i18n";

// TypeScript declarations: CSS Custom Highlight API (Chromium 105+ / Electron 22+)
declare class Highlight {
    constructor(...ranges: Range[]);
}
declare namespace CSS {
    const highlights: Map<string, Highlight>;
}

export interface FindBarController {
    open(initialQuery?: string, opts?: { showReplace?: boolean }): void;
    close(): void;
    isOpen(): boolean;
}

export function initFindBar(
    getEditorEl: () => HTMLElement | null,
    getEditorView: () => EditorView | null,
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

    const btnCase = createButton({
        className: "find-bar__btn",
        label: "Aa",
        title: t("Match Case"),
    });
    btnCase.setAttribute("aria-label", t("Match Case"));
    btnCase.setAttribute("aria-pressed", "false");

    const btnClose = createButton({
        className: "find-bar__btn",
        icon: IconX,
        title: `${t("Close")} (Esc)`,
    });
    btnClose.setAttribute("aria-label", t("Close"));

    findRow.append(input, count, btnPrev, btnNext, sep, btnCase, btnClose);

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

    rows.append(findRow, replaceRow);
    bar.append(btnToggleReplace, rows);
    document.body.appendChild(bar);

    // ── State ────────────────────────────────────────────
    let visible = false;
    let replaceVisible = false;
    let caseSensitive = false;
    let matchRanges: Range[] = [];
    let currentIdx = 0;
    let debounceTimer = 0;

    // ── Highlight updates ────────────────────────────────
    const supportsHighlights = () => typeof CSS !== "undefined" && "highlights" in CSS;

    function updateHighlights() {
        if (!supportsHighlights()) { return; }
        if (!matchRanges.length) {
            CSS.highlights.delete("find-highlight");
            CSS.highlights.delete("find-highlight-current");
            return;
        }
        CSS.highlights.set("find-highlight", new Highlight(...matchRanges));
        if (matchRanges[currentIdx]) {
            CSS.highlights.set("find-highlight-current", new Highlight(matchRanges[currentIdx]));
        }
    }

    function clearHighlights() {
        if (!supportsHighlights()) { return; }
        CSS.highlights.delete("find-highlight");
        CSS.highlights.delete("find-highlight-current");
    }

    // ── Search ───────────────────────────────────────────
    function search(query: string) {
        matchRanges = [];
        currentIdx = 0;

        if (!query) {
            count.textContent = "";
            bar.classList.remove("find-bar--no-results");
            updateHighlights();
            return;
        }

        const editorEl = getEditorEl();
        if (!editorEl) { return; }

        const q = caseSensitive ? query : query.toLowerCase();
        const walker = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT);
        let node: Text | null;
        while ((node = walker.nextNode() as Text | null)) {
            const text = caseSensitive ? node.textContent! : node.textContent!.toLowerCase();
            let idx = 0;
            while (idx < text.length) {
                const found = text.indexOf(q, idx);
                if (found === -1) { break; }
                const r = new Range();
                r.setStart(node, found);
                r.setEnd(node, found + query.length);
                matchRanges.push(r);
                // Advance past the whole match: overlapping matches would
                // corrupt positions when replacing all in one transaction
                idx = found + q.length;
            }
        }

        if (matchRanges.length) {
            count.textContent = `1/${matchRanges.length}`;
            bar.classList.remove("find-bar--no-results");
            scrollToMatch(0);
        } else {
            count.textContent = t("No results");
            bar.classList.add("find-bar--no-results");
        }
        updateHighlights();
    }

    function scrollToMatch(idx: number) {
        if (!matchRanges[idx]) { return; }
        currentIdx = idx;
        count.textContent = `${currentIdx + 1}/${matchRanges.length}`;
        updateHighlights();
        const r = matchRanges[idx];
        const node = r.startContainer;
        const el = node instanceof Element ? node : (node as ChildNode).parentElement;
        if (el) {
            const topbarH = document.querySelector(".editor-topbar")?.getBoundingClientRect().height ?? 40;
            const rect = el.getBoundingClientRect();
            if (rect.top < topbarH + 8 || rect.bottom > window.innerHeight - 8) {
                window.scrollTo({ top: rect.top + window.scrollY - topbarH - 60 });
            }
        }
    }

    function goNext() {
        if (!matchRanges.length) { return; }
        scrollToMatch((currentIdx + 1) % matchRanges.length);
    }

    function goPrev() {
        if (!matchRanges.length) { return; }
        scrollToMatch((currentIdx - 1 + matchRanges.length) % matchRanges.length);
    }

    // ── Replace ──────────────────────────────────────────

    /**
     * Map a DOM match range to ProseMirror document positions.
     * Returns null for text that is not part of the document (e.g. text
     * inside decoration widgets), which must not be replaced.
     */
    function toPmRange(view: EditorView, r: Range): { from: number; to: number } | null {
        try {
            const from = view.posAtDOM(r.startContainer, r.startOffset);
            const to = view.posAtDOM(r.endContainer, r.endOffset);
            if (from < 0 || to < from) { return null; }
            return { from, to };
        } catch {
            return null;
        }
    }

    function replaceCurrent() {
        const view = getEditorView();
        if (!view || !matchRanges.length) { return; }
        const pos = toPmRange(view, matchRanges[currentIdx]);
        if (!pos) { return; }
        const replacement = replaceInput.value;
        view.dispatch(view.state.tr.insertText(replacement, pos.from, pos.to));

        // Rescan the updated document, then advance to the first match after
        // the inserted text (so a replacement containing the query does not
        // get matched again immediately)
        const nextTarget = pos.from + replacement.length;
        search(input.value);
        if (matchRanges.length) {
            const idx = matchRanges.findIndex((m) => {
                const p = toPmRange(view, m);
                return p !== null && p.from >= nextTarget;
            });
            scrollToMatch(idx === -1 ? 0 : idx);
        }
    }

    function replaceAll() {
        const view = getEditorView();
        if (!view || !matchRanges.length) { return; }
        const replacement = replaceInput.value;
        const positions = matchRanges
            .map((r) => toPmRange(view, r))
            .filter((p): p is { from: number; to: number } => p !== null);
        if (!positions.length) { return; }

        // Apply in reverse document order so earlier positions stay valid;
        // a single transaction keeps the whole operation one undo step
        let tr = view.state.tr;
        for (let i = positions.length - 1; i >= 0; i--) {
            tr = tr.insertText(replacement, positions[i].from, positions[i].to);
        }
        view.dispatch(tr);
        search(input.value);
    }

    function setReplaceVisible(show: boolean) {
        replaceVisible = show;
        bar.classList.toggle("find-bar--replace-visible", show);
        btnToggleReplace.innerHTML = show ? IconChevronDown : IconChevronRight;
        btnToggleReplace.setAttribute("aria-expanded", String(show));
    }

    // ── Event bindings ───────────────────────────────────
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

    btnCase.addEventListener("click", () => {
        caseSensitive = !caseSensitive;
        btnCase.classList.toggle("find-bar__btn--active", caseSensitive);
        btnCase.setAttribute("aria-pressed", String(caseSensitive));
        search(input.value);
    });

    // Stop mousedown inside the bar from bubbling into the editor
    bar.addEventListener("mousedown", (e) => e.stopPropagation());

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
    function open(initialQuery?: string, opts?: { showReplace?: boolean }) {
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
        input.focus();
        input.select();
        search(input.value);
    }

    function close() {
        visible = false;
        bar.classList.remove("find-bar--visible");
        bar.classList.remove("find-bar--no-results");
        clearHighlights();
        matchRanges = [];
        count.textContent = "";
    }

    return { open, close, isOpen: () => visible };
}
