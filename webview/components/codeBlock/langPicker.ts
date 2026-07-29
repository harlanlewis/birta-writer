/**
 * components/codeBlock/langPicker.ts
 *
 * The language pill in a code block's floating chrome row, and the searchable
 * dropdown behind it. Self-contained: it owns its own open/close, filter,
 * keyboard navigation and escape/outside-click layers, and reports a choice
 * back through the `onSelect` callback — it never touches ProseMirror.
 *
 * The dropdown is body-mounted (not a child of the pill) so a code block with
 * `overflow: hidden` can't clip it; `destroy()` is therefore mandatory.
 */
import { IconChevronDown } from "@/ui/icons";
import { t } from "@/i18n";
import { CODE_LANGUAGES, normalizeCodeLanguage } from "@/codeLanguages";
import { attachInputUndo } from "@/utils/inputUndo";
import { registerEscapeLayer } from "@/ui/escapeLayers";
import { computeAnchoredPosition, viewportSize } from "@/ui/anchoredPlacement";
import { onOutsideClick } from "@/ui/outsideClick";
import { escapeHtml } from "./escapeHtml";

export function getLangLabel(val: string): string {
    const normalized = normalizeCodeLanguage(val);
    const label = CODE_LANGUAGES.find(([v]) => v === normalized)?.[1] ?? val;
    return label === "Plain Text" ? t("Plain Text") : label;
}

export function isSameLanguage(a: string, b: string): boolean {
    return normalizeCodeLanguage(a) === normalizeCodeLanguage(b);
}

// Builds the language-picker button's inner HTML. The language token comes from the
// fenced-code-block info string (document-controlled), so getLangLabel's raw fallback
// MUST be escaped before it reaches innerHTML — otherwise a crafted fence such as
// ```<img/src=x/onerror=...> would execute on render. Exported so tests drive the real render.
export function langLabelHtml(lang: string): string {
    return `<span class="lang-picker-label">${escapeHtml(getLangLabel(lang))}</span>${IconChevronDown}`;
}

/**
 * Build one language-picker row: a leading shared check column (visible only
 * when this is the current language, via `.lang-picker-item--active .menu-check`)
 * plus the label. Mirrors the toolbar menus' selected-row treatment so both use
 * the same check glyph and a checkmark — not a color/weight change — marks the
 * current selection, matching VS Code's own picker.
 */
export function createLangPickerItem(
    value: string,
    label: string,
    selected: boolean,
): HTMLLIElement {
    const item = document.createElement("li");
    item.className = "ui-menu-row lang-picker-item";
    item.dataset["value"] = value;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", selected ? "true" : "false");
    if (selected) item.classList.add("lang-picker-item--active");

    const check = document.createElement("span");
    check.className = "menu-check";
    check.setAttribute("aria-hidden", "true");

    const labelEl = document.createElement("span");
    labelEl.className = "lang-picker-item-label";
    labelEl.textContent = label === "Plain Text" ? t("Plain Text") : label;

    item.append(check, labelEl);
    return item;
}

export type LangPicker = {
    el: HTMLElement;
    update: (lang: string) => void;
    destroy: () => void;
};

// ─── Language-picker dropdown component ────────────────────────────────────────
export function createLangPicker(
    currentLang: string,
    onSelect: (lang: string) => void,
): LangPicker {
    const wrapper = document.createElement("div");
    wrapper.className = "lang-picker";

    const triggerBtn = document.createElement("button");
    triggerBtn.className = "lang-picker-btn";
    triggerBtn.tabIndex = -1;
    triggerBtn.innerHTML = langLabelHtml(currentLang);

    const dropdown = document.createElement("div");
    dropdown.className = "lang-picker-dropdown";
    dropdown.style.display = "none";
    document.body.appendChild(dropdown);

    const searchInput = document.createElement("input");
    searchInput.className = "lang-picker-search";
    searchInput.type = "text";
    searchInput.placeholder = t("Search language...");
    searchInput.setAttribute("autocomplete", "off");
    searchInput.setAttribute("spellcheck", "false");
    // Local undo/redo: VS Code's Electron layer swallows Cmd/Ctrl+Z before
    // native inputs see it (same as the other overlay inputs)
    const detachSearchUndo = attachInputUndo(searchInput);

    const listEl = document.createElement("ul");
    listEl.className = "lang-picker-list";

    dropdown.appendChild(searchInput);
    dropdown.appendChild(listEl);
    wrapper.appendChild(triggerBtn);

    let isOpen = false;
    let activeIndex = -1;
    /** Escape-layer unregister handle (null while the dropdown is closed). */
    let escapeLayerOff: (() => void) | null = null;

    function scrollListItemIntoView(item: HTMLElement): void {
        const itemTop = item.offsetTop;
        const itemBottom = itemTop + item.offsetHeight;
        const visibleTop = listEl.scrollTop;
        const visibleBottom = visibleTop + listEl.clientHeight;

        if (itemTop < visibleTop) {
            listEl.scrollTop = itemTop;
        } else if (itemBottom > visibleBottom) {
            listEl.scrollTop = itemBottom - listEl.clientHeight;
        }
    }

    function setActiveIdx(idx: number): void {
        const items = listEl.querySelectorAll<HTMLElement>(".lang-picker-item");
        if (items.length === 0) {
            activeIndex = -1;
            return;
        }

        const nextIdx = Math.max(0, Math.min(idx, items.length - 1));
        items.forEach((el, i) =>
            el.classList.toggle("lang-picker-item--focused", i === nextIdx),
        );
        scrollListItemIntoView(items[nextIdx]);
        activeIndex = nextIdx;
    }

    function renderList(filter = ""): void {
        const q = filter.trim().toLowerCase();
        const filtered = CODE_LANGUAGES.filter(
            ([val, label, aliases]) =>
                label.toLowerCase().includes(q) ||
                val.toLowerCase().includes(q) ||
                (aliases?.some((alias) => alias.toLowerCase().includes(q)) ?? false),
        );
        listEl.innerHTML = "";
        activeIndex = -1;
        filtered.forEach(([val, label], i) => {
            const selected = isSameLanguage(val, currentLang);
            const item = createLangPickerItem(val, label, selected);
            item.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                selectLang(val);
            });
            listEl.appendChild(item);
            if (selected) activeIndex = i;
        });
        if (filtered.length > 0) {
            setActiveIdx(activeIndex >= 0 ? activeIndex : 0);
        }
    }

    let outsideOff: (() => void) | null = null;
    function closeOnScroll(e: Event): void {
        if (dropdown.contains(e.target as Node)) return;
        close();
    }

    function open(): void {
        isOpen = true;
        // Escape layer: search-input Esc self-closes, but an editor-focused
        // Esc while the picker is open must close it before block-selecting.
        escapeLayerOff ??= registerEscapeLayer(close);
        const rect = triggerBtn.getBoundingClientRect();
        const dropW = Math.max(rect.width, 160);
        dropdown.style.left = `${rect.left}px`;
        dropdown.style.width = `${dropW}px`;
        dropdown.style.top = "";
        dropdown.style.bottom = "";

        dropdown.style.visibility = "hidden";
        dropdown.style.display = "block";
        const dropH = dropdown.offsetHeight;
        dropdown.style.display = "none";
        dropdown.style.visibility = "";

        // Below by default, above when that's the larger side; an above
        // placement pins `bottom` so the list grows upward as it re-filters.
        const placed = computeAnchoredPosition(
            rect,
            { width: dropW, height: dropH },
            viewportSize(),
            { gap: 2 },
        );
        if (placed.above) {
            dropdown.style.bottom = `${placed.cssBottom}px`;
        } else {
            dropdown.style.top = `${placed.top}px`;
        }

        dropdown.style.display = "block";
        triggerBtn.classList.add("lang-picker-btn--open");
        searchInput.value = "";
        renderList();
        searchInput.focus();

        setTimeout(() => {
            // Bubble phase (capture: false), preserved from the original
            // listener: chrome elsewhere that swallows its own mousedowns
            // (stopPropagation) has always left this picker open, and a
            // capture-phase listener would start closing it on those.
            outsideOff = onOutsideClick([wrapper, dropdown], close, { capture: false });
            window.addEventListener("scroll", closeOnScroll, { capture: true });
        }, 0);
    }

    function close(): void {
        escapeLayerOff?.();
        escapeLayerOff = null;
        isOpen = false;
        dropdown.style.display = "none";
        triggerBtn.classList.remove("lang-picker-btn--open");
        outsideOff?.();
        outsideOff = null;
        window.removeEventListener("scroll", closeOnScroll, true);
    }

    function selectLang(val: string): void {
        currentLang = val;
        triggerBtn.querySelector(".lang-picker-label")!.textContent = getLangLabel(val);
        close();
        onSelect(val);
    }

    triggerBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        isOpen ? close() : open();
    });

    searchInput.addEventListener("input", () => renderList(searchInput.value));
    // Stop propagation only for keys the picker actually consumes (list
    // navigation and plain filter typing). Modifier chords it does not
    // handle (Cmd+Shift+M, other workbench keybindings, ...) must keep
    // propagating; undo/redo chords are stopped by attachInputUndo itself.
    searchInput.addEventListener("keydown", (e) => {
        if (e.isComposing) return;
        const items = listEl.querySelectorAll<HTMLElement>(".lang-picker-item");
        if (e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            setActiveIdx(Math.min(activeIndex + 1, items.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            setActiveIdx(Math.max(activeIndex - 1, 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            const focused = listEl.querySelector<HTMLElement>(".lang-picker-item--focused");
            if (focused) selectLang(focused.dataset["value"] ?? "");
            else if (items[0]) selectLang(items[0].dataset["value"] ?? "");
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
        } else if (
            !e.metaKey && !e.ctrlKey && !e.altKey &&
            (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete")
        ) {
            // Plain typing/editing that mutates the filter: keep it inside
            // the picker so document-level shortcut handlers never see it
            e.stopPropagation();
        }
    });

    return {
        el: wrapper,
        update(lang: string) {
            currentLang = lang;
            triggerBtn.querySelector(".lang-picker-label")!.textContent = getLangLabel(lang);
        },
        destroy() {
            close();
            detachSearchUndo();
            if (document.body.contains(dropdown)) document.body.removeChild(dropdown);
        },
    };
}
