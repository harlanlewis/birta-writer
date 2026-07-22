/**
 * Roving-tabindex keyboard navigation for the review sidebar's lists.
 *
 * The sidebar used to be entirely mouse-only (every control at tabIndex -1). This
 * makes a list keyboard-reachable and navigable without stealing the editor's
 * focus model: exactly ONE item in the list is tabbable (tabIndex 0), so Tab
 * lands on the list once; the arrows then move focus among the items and carry
 * the tabbable slot with them. Enter/Space activate — natively for <button>
 * items, or by synthesizing a click for non-button rows (the outline's divs).
 * Escape hands focus back (onEscape, e.g. to the editor).
 *
 * `items()` is recomputed on every key so it always reflects the current DOM
 * (rows shown/hidden by a fold or a show-more), and `refresh()` re-seeds the
 * roving slot after the list rebuilds.
 */
export interface RovingOptions {
    /** The element to listen on (the scrolling list body). */
    container: HTMLElement;
    /** Ordered, currently-focusable items, in visual order. */
    items: () => HTMLElement[];
    /** Where Escape (or a caller) sends focus — typically the editor. */
    onEscape?: () => void;
    /** Left/Right handling (e.g. tree fold). Return true when handled so the
     *  default does nothing. */
    onHorizontal?: (item: HTMLElement, dir: -1 | 1) => boolean;
}

export interface RovingHandle {
    /** Re-establish the single tabbable item after the list rebuilt. */
    refresh: () => void;
    /** Move focus to the first item (e.g. entering the list deliberately). */
    focusFirst: () => void;
    dispose: () => void;
}

export function wireRoving(opts: RovingOptions): RovingHandle {
    const { container } = opts;

    /** Make `active` the sole tabbable item; if none, keep the first tabbable so
     *  Tab can still enter the list. */
    function setRoving(active: HTMLElement | null): void {
        const list = opts.items();
        let seeded = false;
        for (const el of list) {
            const on = el === active;
            el.tabIndex = on ? 0 : -1;
            seeded = seeded || on;
        }
        if (!seeded && list.length) { list[0]!.tabIndex = 0; }
    }

    function currentIndex(): number {
        return opts.items().indexOf(document.activeElement as HTMLElement);
    }

    function focusIndex(i: number): void {
        const list = opts.items();
        if (!list.length) { return; }
        const el = list[Math.max(0, Math.min(list.length - 1, i))]!;
        setRoving(el);
        el.focus();
    }

    function onKeydown(e: KeyboardEvent): void {
        if (e.key === "Escape") { opts.onEscape?.(); return; }

        if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && opts.onHorizontal) {
            const cur = opts.items()[currentIndex()];
            if (cur && opts.onHorizontal(cur, e.key === "ArrowLeft" ? -1 : 1)) {
                e.preventDefault();
                return;
            }
        }
        if (e.key === "Enter" || e.key === " ") {
            const cur = opts.items()[currentIndex()];
            // Buttons activate natively; synthesize a click for other rows.
            if (cur && cur.tagName !== "BUTTON") {
                e.preventDefault();
                cur.click();
            }
            return;
        }
        const idx = currentIndex();
        if (e.key === "ArrowDown") { e.preventDefault(); focusIndex(idx < 0 ? 0 : idx + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); focusIndex(idx < 0 ? 0 : idx - 1); }
        else if (e.key === "Home") { e.preventDefault(); focusIndex(0); }
        else if (e.key === "End") { e.preventDefault(); focusIndex(opts.items().length - 1); }
    }

    // A mouse click that focuses an item makes it the roving one.
    function onFocusin(e: FocusEvent): void {
        const t = e.target as HTMLElement;
        if (opts.items().includes(t)) { setRoving(t); }
    }

    container.addEventListener("keydown", onKeydown);
    container.addEventListener("focusin", onFocusin);
    setRoving(null);

    return {
        refresh: () => {
            const active = document.activeElement as HTMLElement;
            setRoving(opts.items().includes(active) ? active : null);
        },
        focusFirst: () => focusIndex(0),
        dispose: () => {
            container.removeEventListener("keydown", onKeydown);
            container.removeEventListener("focusin", onFocusin);
        },
    };
}
