/**
 * components/frontmatter/suggestMenu.ts
 *
 * Dropdown menu offering workspace-wide values for a list-valued frontmatter
 * key. Two modes share the same option list, highlight logic, and the
 * fmSuggestions callback registry:
 *
 * - "+" mode (openFmSuggestMenu): opened from the "+" chip button. A filter
 *   input on top, suggestions for the SAME key below (frequency-ranked by the
 *   Extension, minus values already present in this file's list), and a final
 *   `Create "<typed>"` row whenever the typed text is not an exact option.
 * - chip-edit mode (openFmChipSuggestMenu): opened when an existing chip's
 *   contenteditable text gains focus. The chip's own text is the filter query
 *   (no input row) and there is no Create row — plain Enter already commits
 *   the typed text. The caller drives the menu through the returned
 *   controller from the chip's input/keydown/blur handlers.
 *
 * Suggestions arrive asynchronously (requestFmSuggestions → fmSuggestions
 * round-trip through messaging.ts); the menu renders immediately and fills in
 * options on reply, so it never feels blocked on the workspace scan.
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

/** One selectable row: an existing workspace value or the create-typed row. */
type MenuRow = { value: string; isCreate: boolean };

/** Close handler of the currently open menu (at most one at a time). */
let closeOpenMenu: (() => void) | null = null;

/**
 * Closes the currently open suggest menu, if any. Called when the panel is
 * re-rendered (e.g. an external revert) so no zombie menu stays anchored to a
 * detached element and no late pick can act on stale entries.
 */
export function closeActiveFmSuggestMenu(): void {
    closeOpenMenu?.();
}

/** Handle the chip-edit caller uses to drive an open suggestion menu. */
export type FmSuggestController = {
    /** Re-filters the option list (case-insensitive substring). */
    setQuery(query: string): void;
    /** Moves the highlight down (+1) or up (-1), wrapping; no-op without rows. */
    moveHighlight(delta: 1 | -1): void;
    /** The highlighted row's value, or null when nothing is highlighted. */
    activeValue(): string | null;
    /** True when at least one row is currently rendered. */
    hasOptions(): boolean;
    /** True until the menu is closed. */
    isOpen(): boolean;
    /** Closes the menu and invokes onPick with the value. */
    pick(value: string): void;
    /** Closes the menu without picking anything. */
    close(): void;
};

type SuggestCoreOptions = {
    /** Element the menu is positioned under. */
    anchor: HTMLElement;
    /** Frontmatter key the suggestions are collected for. */
    key: string;
    /** Values already present in this file's list (excluded from the options). */
    existing: string[];
    /** Append a `Create "<typed>"` row when the query is not an exact option ("+" mode). */
    allowCreate: boolean;
    /** Hide the option equal to the query itself (chip mode: it is already typed). */
    excludeExactQuery: boolean;
    /** Initial filter query (chip mode: the chip's current text). */
    initialQuery?: string;
    /** Element rendered inside the menu above the list ("+" mode filter input). */
    topElement?: HTMLElement;
    /** Mousedowns inside this element must not close the menu (the edited chip). */
    keepOpenFor?: HTMLElement;
    /** Invoked with the chosen (or created) value after the menu closes. */
    onPick: (value: string) => void;
    /** Invoked exactly once when the menu closes (for any reason). */
    onClose?: () => void;
};

/** Builds the dropdown shared by both modes and returns its controller. */
function createSuggestMenuCore(opts: SuggestCoreOptions): FmSuggestController {
    closeOpenMenu?.();

    const menu = document.createElement("div");
    menu.className = "fm-suggest-menu";

    const list = document.createElement("ul");
    list.className = "fm-suggest-list";

    if (opts.topElement) { menu.appendChild(opts.topElement); }
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

    // null until the fmSuggestions reply arrives (the menu renders meanwhile)
    let allValues: string[] | null = null;
    let rows: MenuRow[] = [];
    let activeIndex = -1;
    let closed = false;
    let query = opts.initialQuery ?? "";

    function close(): void {
        if (closed) { return; }
        closed = true;
        menu.remove();
        _pendingSuggestions.delete(opts.key);
        document.removeEventListener("mousedown", outsideMousedown, true);
        window.removeEventListener("blur", close);
        if (closeOpenMenu === close) { closeOpenMenu = null; }
        opts.onClose?.();
    }

    function pick(value: string): void {
        close();
        opts.onPick(value);
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
        const typed = query.trim();
        const q = typed.toLowerCase();
        const existingSet = new Set(opts.existing);
        const options = (allValues ?? [])
            .filter((v) => !existingSet.has(v))
            .filter((v) => !(opts.excludeExactQuery && v === typed))
            .filter((v) => v.toLowerCase().includes(q));
        rows = options.map((value) => ({ value, isCreate: false }));
        if (opts.allowCreate && typed !== "" && !options.includes(typed)) {
            rows.push({ value: typed, isCreate: true });
        }

        // Without a top element (chip mode) an option-less menu is an empty
        // box floating under the chip; hide it until there is something to show.
        menu.style.display = rows.length === 0 && !opts.topElement ? "none" : "";

        list.innerHTML = "";
        rows.forEach((row, i) => {
            const li = document.createElement("li");
            li.className = "fm-suggest-item" + (row.isCreate ? " fm-suggest-create" : "");
            li.textContent = row.isCreate ? `${t("Create")} "${row.value}"` : row.value;
            li.title = row.value;
            li.addEventListener("mousedown", (e) => {
                // preventDefault keeps focus where it is (the "+" input or the
                // edited chip), so the pick applies before any blur commit.
                e.preventDefault();
                e.stopPropagation();
                pick(row.value);
            });
            li.addEventListener("mouseover", () => {
                activeIndex = i;
                updateActive();
            });
            list.appendChild(li);
        });
        // No default highlight: Enter without arrow navigation commits the typed text.
        activeIndex = -1;
        updateActive();
    }

    function outsideMousedown(e: MouseEvent): void {
        const target = e.target as Node;
        if (menu.contains(target)) { return; }
        if (opts.keepOpenFor?.contains(target)) { return; }
        close();
    }
    // Deferred so the mousedown that opened the menu can finish dispatching.
    setTimeout(() => {
        if (closed) { return; }
        document.addEventListener("mousedown", outsideMousedown, true);
        window.addEventListener("blur", close);
    }, 0);

    closeOpenMenu = close;

    // Ask the Extension for the workspace-wide values of this key; the menu
    // renders immediately and fills in options on reply (the Extension caches
    // its workspace scan, so repeated opens are cheap).
    _pendingSuggestions.set(opts.key, (values) => {
        if (closed) { return; }
        allValues = values;
        renderList();
    });
    notifyRequestFmSuggestions(opts.key);

    renderList();

    return {
        setQuery(next: string): void {
            if (closed) { return; }
            query = next;
            renderList();
        },
        moveHighlight(delta: 1 | -1): void {
            if (closed || rows.length === 0) { return; }
            if (delta === 1) {
                activeIndex = activeIndex >= rows.length - 1 ? 0 : activeIndex + 1;
            } else {
                activeIndex = activeIndex <= 0 ? rows.length - 1 : activeIndex - 1;
            }
            updateActive();
        },
        activeValue(): string | null {
            return activeIndex >= 0 && activeIndex < rows.length ? rows[activeIndex]!.value : null;
        },
        hasOptions(): boolean {
            return rows.length > 0;
        },
        isOpen(): boolean {
            return !closed;
        },
        pick,
        close,
    };
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

/** Opens the "+" suggestion dropdown for a list-valued frontmatter key. */
export function openFmSuggestMenu(opts: FmSuggestMenuOptions): void {
    const input = document.createElement("input");
    input.className = "fm-suggest-input";
    input.type = "text";
    input.placeholder = t("Filter or create...");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    // Local undo/redo: VS Code's Electron layer swallows Cmd/Ctrl+Z before
    // native inputs see it (same as the other overlay inputs)
    const detachUndo = attachInputUndo(input);

    const core = createSuggestMenuCore({
        anchor: opts.anchor,
        key: opts.key,
        existing: opts.existing,
        allowCreate: true,
        excludeExactQuery: false,
        topElement: input,
        onPick: opts.onSelect,
        onClose: detachUndo,
    });

    input.addEventListener("input", () => core.setQuery(input.value));

    input.addEventListener("keydown", (e) => {
        if (e.isComposing) { return; }
        // Keep editor-level shortcuts out of the overlay input.
        e.stopPropagation();
        if (e.key === "Escape") {
            e.preventDefault();
            core.close();
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            core.moveHighlight(1);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            core.moveHighlight(-1);
        } else if (e.key === "Enter") {
            e.preventDefault();
            const active = core.activeValue();
            if (active !== null) {
                core.pick(active);
            } else {
                const typed = input.value.trim();
                if (typed !== "") { core.pick(typed); }
            }
        }
    });

    // Row mousedown calls preventDefault, so a blur here always means the
    // focus really left the menu.
    input.addEventListener("blur", () => core.close());

    input.focus();
}

export type FmChipSuggestMenuOptions = {
    /** The chip element the menu is anchored under (mousedowns inside it keep the menu open). */
    anchor: HTMLElement;
    /** Frontmatter key the suggestions are collected for. */
    key: string;
    /** All values currently in this file's list (including the chip's own). */
    existing: string[];
    /** The chip's current text — the initial filter query. */
    query: string;
    /** Invoked with the chosen value after the menu closes. */
    onPick: (value: string) => void;
};

/**
 * Opens the suggestion dropdown for an existing chip being edited in place.
 * Unlike the "+" mode there is no filter input (the chip's contenteditable
 * text is the query) and no Create row (plain Enter already commits the typed
 * text). The chip's handlers drive the menu through the returned controller.
 */
export function openFmChipSuggestMenu(opts: FmChipSuggestMenuOptions): FmSuggestController {
    return createSuggestMenuCore({
        anchor: opts.anchor,
        key: opts.key,
        existing: opts.existing,
        allowCreate: false,
        excludeExactQuery: true,
        initialQuery: opts.query,
        keepOpenFor: opts.anchor,
        onPick: opts.onPick,
    });
}
