/**
 * components/frontmatter/suggestMenu.ts
 *
 * Dropdown menu for adding an item to a list-valued frontmatter key.
 * Opened from the "+" chip button: a filter input on top, workspace-wide
 * suggestions for the SAME key below (frequency-ranked by the Extension,
 * minus values already present in this file's list), and a final
 * `Create "<typed>"` row whenever the typed text is not an exact option.
 *
 * Suggestions arrive asynchronously (requestFmSuggestions → fmSuggestions
 * round-trip through messaging.ts); the input and the create row render
 * immediately so the menu never feels blocked on the scan.
 */

import { t } from "../../i18n";
import { notifyRequestFmSuggestions } from "../../messaging";
import { attachInputUndo } from "../../utils/inputUndo";

// key → callback for the fmSuggestions reply. Only one menu is open at a
// time, so keying by the frontmatter key (mirroring the message shape) is
// unambiguous; stale entries are dropped when the menu closes.
const _pendingSuggestions = new Map<string, (values: string[]) => void>();

/** Called by messageHandlers.ts to route an fmSuggestions reply. */
export function dispatchFmSuggestions(key: string, values: string[]): void {
    const cb = _pendingSuggestions.get(key);
    if (cb) {
        _pendingSuggestions.delete(key);
        cb(values);
    }
}

export type FmSuggestMenuOptions = {
    /** Element the menu is positioned under (the "+" chip button). */
    anchor: HTMLElement;
    /** Frontmatter key the suggestions are collected for. */
    key: string;
    /** Values already present in this file's list (excluded from the options). */
    existing: string[];
    /** Invoked with the chosen (or created) value after the menu closes. */
    onSelect: (value: string) => void;
};

/** One selectable row: an existing workspace value or the create-typed row. */
type MenuRow = { value: string; isCreate: boolean };

/** Close handler of the currently open menu (at most one at a time). */
let closeOpenMenu: (() => void) | null = null;

/** Opens the suggestion dropdown for a list-valued frontmatter key. */
export function openFmSuggestMenu(opts: FmSuggestMenuOptions): void {
    closeOpenMenu?.();

    const menu = document.createElement("div");
    menu.className = "fm-suggest-menu";

    const input = document.createElement("input");
    input.className = "fm-suggest-input";
    input.type = "text";
    input.placeholder = t("Filter or create...");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    // Local undo/redo: VS Code's Electron layer swallows Cmd/Ctrl+Z before
    // native inputs see it (same as the other overlay inputs)
    const detachUndo = attachInputUndo(input);

    const list = document.createElement("ul");
    list.className = "fm-suggest-list";

    menu.appendChild(input);
    menu.appendChild(list);
    document.body.appendChild(menu);

    // Position below the anchor, flipping above when there is more room there.
    const rect = opts.anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow >= 240 || spaceBelow >= rect.top) {
        menu.style.top = `${rect.bottom + 2}px`;
    } else {
        menu.style.bottom = `${window.innerHeight - rect.top + 2}px`;
    }

    // null until the fmSuggestions reply arrives (input + create row show meanwhile)
    let allValues: string[] | null = null;
    let rows: MenuRow[] = [];
    let activeIndex = -1;
    let closed = false;

    function close(): void {
        if (closed) { return; }
        closed = true;
        detachUndo();
        menu.remove();
        _pendingSuggestions.delete(opts.key);
        document.removeEventListener("mousedown", outsideMousedown, true);
        window.removeEventListener("blur", close);
        if (closeOpenMenu === close) { closeOpenMenu = null; }
    }

    function select(value: string): void {
        close();
        opts.onSelect(value);
    }

    function updateActive(): void {
        Array.from(list.children).forEach((li, i) => {
            const isActive = i === activeIndex;
            li.classList.toggle("fm-suggest-item--focused", isActive);
            // Optional call: jsdom (unit tests) does not implement scrollIntoView.
            if (isActive) { (li as HTMLElement).scrollIntoView?.({ block: "nearest" }); }
        });
    }

    function renderList(): void {
        const typed = input.value.trim();
        const query = typed.toLowerCase();
        const existingSet = new Set(opts.existing);
        const options = (allValues ?? [])
            .filter((v) => !existingSet.has(v))
            .filter((v) => v.toLowerCase().includes(query));
        rows = options.map((value) => ({ value, isCreate: false }));
        if (typed !== "" && !options.includes(typed)) {
            rows.push({ value: typed, isCreate: true });
        }

        list.innerHTML = "";
        rows.forEach((row, i) => {
            const li = document.createElement("li");
            li.className = "fm-suggest-item" + (row.isCreate ? " fm-suggest-create" : "");
            li.textContent = row.isCreate ? `${t("Create")} "${row.value}"` : row.value;
            li.title = row.value;
            li.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                select(row.value);
            });
            li.addEventListener("mouseover", () => {
                activeIndex = i;
                updateActive();
            });
            list.appendChild(li);
        });
        // No default highlight: Enter without arrow navigation creates the typed text.
        activeIndex = -1;
        updateActive();
    }

    input.addEventListener("input", () => renderList());

    input.addEventListener("keydown", (e) => {
        if (e.isComposing) { return; }
        // Keep editor-level shortcuts out of the overlay input.
        e.stopPropagation();
        if (e.key === "Escape") {
            e.preventDefault();
            close();
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            if (rows.length > 0) {
                activeIndex = activeIndex >= rows.length - 1 ? 0 : activeIndex + 1;
                updateActive();
            }
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (rows.length > 0) {
                activeIndex = activeIndex <= 0 ? rows.length - 1 : activeIndex - 1;
                updateActive();
            }
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (activeIndex >= 0 && activeIndex < rows.length) {
                select(rows[activeIndex]!.value);
            } else {
                const typed = input.value.trim();
                if (typed !== "") { select(typed); }
            }
        }
    });

    // Row mousedown calls preventDefault, so a blur here always means the
    // focus really left the menu.
    input.addEventListener("blur", () => close());

    function outsideMousedown(e: MouseEvent): void {
        if (!menu.contains(e.target as Node)) { close(); }
    }
    // Deferred so the mousedown that opened the menu can finish dispatching.
    setTimeout(() => {
        if (closed) { return; }
        document.addEventListener("mousedown", outsideMousedown, true);
        window.addEventListener("blur", close);
    }, 0);

    closeOpenMenu = close;

    // Ask the Extension for the workspace-wide values of this key; the menu
    // shows the input + create row immediately and fills in options on reply.
    _pendingSuggestions.set(opts.key, (values) => {
        if (closed) { return; }
        allValues = values;
        renderList();
    });
    notifyRequestFmSuggestions(opts.key);

    renderList();
    input.focus();
}
