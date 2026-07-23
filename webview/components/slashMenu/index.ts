/**
 * components/slashMenu/index.ts
 *
 * The slash-command dropdown DOM — rendering, highlight tracking, and
 * anchored placement only. It knows nothing about ProseMirror: the plugin
 * controller (webview/plugins/slashMenu.ts) owns when to open/close it,
 * feeds it the query, and executes picks.
 *
 * Focus never enters the menu (WAI-ARIA combobox pattern, the same as
 * VS Code's own suggest widget): query characters are literal document
 * text, so the editor keeps focus and the controller mirrors the highlight
 * through aria-activedescendant on the editor DOM.
 */
import { t } from "@/i18n";
import { clampLeft, computeAnchoredPosition, viewportSize } from "@/ui/anchoredPlacement";
import {
    filterSlashItems,
    SLASH_GROUPS,
    SLASH_MENU_ITEMS,
    type SlashMenuItem,
} from "./registry";

/** Viewport anchor, in the shape createLinkSuggestMenu uses. */
export interface SlashMenuAnchor {
    left: number;
    /** Menu top (viewport y) when placed below the anchor. */
    top: number;
    /** Viewport y the menu's BOTTOM edge sits at when flipped above. */
    flipTop: number;
}

export interface SlashMenuHandle {
    /** The menu root, appended to document.body. */
    el: HTMLDivElement;
    /** Re-filters the rows; hides the menu when nothing matches. */
    setQuery(query: string): void;
    /** Moves the keyboard highlight down (+1) or up (-1), wrapping. */
    moveActive(delta: 1 | -1): void;
    /** Applies onPick to the highlighted row; false when none/hidden. */
    pickActive(): boolean;
    /** False while the current query matches nothing (menu hidden). */
    isVisible(): boolean;
    /** DOM id of the highlighted row (aria-activedescendant), or null. */
    activeRowId(): string | null;
    /** Places the menu at the anchor, flipping above when it overflows. */
    position(anchor: SlashMenuAnchor): void;
    /** Removes the menu DOM. */
    destroy(): void;
}

export interface SlashMenuOptions {
    onPick(item: SlashMenuItem): void;
    /** Highlight moved (keyboard or hover); id is the active row's DOM id. */
    onActiveChange?(id: string | null): void;
    /** Registry override for tests. */
    items?: readonly SlashMenuItem[];
    /** Display label for a row (dynamic toggle labels); falls back to item.label. */
    labelFor?(item: SlashMenuItem): string;
}

export const SLASH_MENU_DOM_ID = "md-slash-menu";

/** The DOM id a registry item's row renders with. */
export function slashRowDomId(itemId: string): string {
    return `md-slash-item-${itemId}`;
}

export function createSlashMenu(opts: SlashMenuOptions): SlashMenuHandle {
    const items = opts.items ?? SLASH_MENU_ITEMS;

    const root = document.createElement("div");
    root.className = "slash-menu";
    root.id = SLASH_MENU_DOM_ID;
    root.setAttribute("role", "listbox");
    root.addEventListener("mousedown", (e) => {
        // preventDefault keeps focus in the editor (a blur would close the
        // menu before the pick applies); stopPropagation keeps document-
        // level outside-click handlers from reacting to menu clicks.
        e.preventDefault();
        e.stopPropagation();
    });

    const list = document.createElement("div");
    list.className = "slash-menu-list";
    root.appendChild(list);

    // Discoverability footer (Notion convention). Decorative for AT — the
    // keyboard model is announced through the combobox aria wiring. The left
    // slot is a "Show all commands" toggle on the unfiltered list (reveals the
    // search-only rows — fonts, checks, view controls — for mouse browsers);
    // while filtering it reverts to the plain "Type to filter" hint.
    const footer = document.createElement("div");
    footer.className = "slash-menu-footer";
    footer.setAttribute("aria-hidden", "true");
    const footerHint = document.createElement("span");
    footerHint.className = "slash-menu-footer-hint";
    const footerEsc = document.createElement("span");
    footerEsc.className = "slash-menu-footer-key";
    footerEsc.textContent = "esc";
    footer.appendChild(footerHint);
    footer.appendChild(footerEsc);
    root.appendChild(footer);

    let visible: SlashMenuItem[] = [];
    let rows: HTMLElement[] = [];
    let activeIndex = -1;
    let lastAnchor: SlashMenuAnchor | null = null;
    let lastQuery = "";
    // Sticky (until the menu closes) reveal of the search-only rows in the
    // unfiltered view — the "Show all commands" footer toggle.
    let showAll = false;

    function updateFooter(grouped: boolean): void {
        if (grouped) {
            footerHint.textContent = showAll ? t("Show fewer") : t("Show all commands");
            footerHint.classList.add("slash-menu-footer-action");
        } else {
            footerHint.textContent = t("Type to filter");
            footerHint.classList.remove("slash-menu-footer-action");
        }
    }
    // Toggle on mousedown (preventDefault keeps editor focus; the query is
    // necessarily empty here, so re-render the unfiltered list and reposition).
    footerHint.addEventListener("mousedown", (e) => {
        if (lastQuery.trim() !== "") { return; }
        e.preventDefault();
        e.stopPropagation();
        showAll = !showAll;
        render("");
        if (lastAnchor) { positionMenu(lastAnchor); }
    });

    function setActive(index: number): void {
        activeIndex = index;
        rows.forEach((row, i) => {
            const isActive = i === activeIndex;
            row.classList.toggle("slash-menu-item--focused", isActive);
            row.setAttribute("aria-selected", String(isActive));
            // Optional call: jsdom (unit tests) has no scrollIntoView.
            if (isActive) {
                row.scrollIntoView?.({ block: "nearest" });
            }
        });
        opts.onActiveChange?.(
            activeIndex >= 0 ? slashRowDomId(visible[activeIndex].id) : null,
        );
    }

    function renderRow(item: SlashMenuItem, index: number): HTMLElement {
        const row = document.createElement("div");
        row.className = "ui-menu-row slash-menu-item";
        row.id = slashRowDomId(item.id);
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", "false");

        const iconSlot = document.createElement("span");
        if (item.badge) {
            iconSlot.className = "slash-menu-item-badge";
            iconSlot.textContent = item.badge;
        } else {
            iconSlot.className = "slash-menu-item-icon";
            iconSlot.innerHTML = item.icon;
        }
        row.appendChild(iconSlot);

        const label = document.createElement("span");
        label.className = "slash-menu-item-label";
        label.textContent = opts.labelFor?.(item) ?? item.label;
        row.appendChild(label);

        if (item.hint) {
            const hint = document.createElement("span");
            hint.className = "slash-menu-item-hint";
            hint.textContent = item.hint;
            row.appendChild(hint);
        }

        row.addEventListener("mousedown", () => opts.onPick(item));
        row.addEventListener("mouseover", () => setActive(index));
        return row;
    }

    function render(query: string): void {
        lastQuery = query;
        // Group headers only in the unfiltered view; a filtered view is a flat
        // ranked list (Notion behavior — ranking beats grouping). "Show all"
        // widens the unfiltered view to include the search-only rows.
        const grouped = query.trim() === "";
        if (grouped) {
            visible = showAll ? [...items] : items.filter((it) => !it.searchOnly);
        } else {
            visible = filterSlashItems(items, query);
        }
        list.textContent = "";
        rows = [];

        if (visible.length === 0) {
            // Hidden but alive: backspacing to a matching query re-shows it
            // and the controller stays anchored to the same slash context.
            root.style.display = "none";
            setActive(-1);
            updateFooter(grouped);
            return;
        }
        root.style.display = "";

        if (grouped) {
            for (const group of SLASH_GROUPS) {
                const groupItems = visible.filter((it) => it.group === group.id);
                if (groupItems.length === 0) {
                    continue;
                }
                const header = document.createElement("div");
                header.className = "ui-heading ui-menu-heading slash-menu-group-label";
                header.setAttribute("role", "presentation");
                header.textContent = group.label;
                list.appendChild(header);
                for (const item of groupItems) {
                    const row = renderRow(item, rows.length);
                    rows.push(row);
                    list.appendChild(row);
                }
            }
            // Rows were appended in group order — keep `visible` in the same
            // order so index-based highlight/pick line up.
            visible = SLASH_GROUPS.flatMap((g) =>
                visible.filter((it) => it.group === g.id),
            );
        } else {
            for (const item of visible) {
                const row = renderRow(item, rows.length);
                rows.push(row);
                list.appendChild(row);
            }
        }

        // First row highlighted on open and after every re-filter: Enter
        // always does something (command-palette semantics).
        setActive(0);
        updateFooter(grouped);
    }

    function positionMenu(anchor: SlashMenuAnchor): void {
        lastAnchor = anchor;
        if (visible.length === 0) {
            return;
        }
        root.style.top = `${anchor.top}px`;
        const width = root.getBoundingClientRect().width;
        root.style.left = `${clampLeft(anchor.left, width, viewportSize())}px`;
        // Measured after placement (height depends on the rendered rows):
        // flip above the anchor when the menu would overflow the bottom
        // edge and there is more room above (createLinkSuggestMenu rule).
        // The anchor is a drop point (`top`) plus a separate flip line
        // (`flipTop`), so it maps to a zero-gap rect between the two.
        const height = root.getBoundingClientRect().height;
        const placed = computeAnchoredPosition(
            { left: anchor.left, right: anchor.left, top: anchor.flipTop, bottom: anchor.top },
            { width, height },
            viewportSize(),
            { gap: 0, fitSlack: 0 },
        );
        if (placed.above) {
            root.style.top = `${Math.max(0, placed.top)}px`;
        }
    }

    render("");
    document.body.appendChild(root);

    return {
        el: root,
        setQuery(query: string): void {
            render(query);
            if (lastAnchor) {
                positionMenu(lastAnchor);
            }
        },
        moveActive(delta: 1 | -1): void {
            if (rows.length === 0) {
                return;
            }
            setActive(
                delta > 0
                    ? (activeIndex >= rows.length - 1 ? 0 : activeIndex + 1)
                    : (activeIndex <= 0 ? rows.length - 1 : activeIndex - 1),
            );
        },
        pickActive(): boolean {
            if (activeIndex < 0 || activeIndex >= visible.length) {
                return false;
            }
            opts.onPick(visible[activeIndex]);
            return true;
        },
        isVisible(): boolean {
            return visible.length > 0;
        },
        activeRowId(): string | null {
            return activeIndex >= 0 ? slashRowDomId(visible[activeIndex].id) : null;
        },
        position(anchor: SlashMenuAnchor): void {
            positionMenu(anchor);
        },
        destroy(): void {
            root.remove();
        },
    };
}
