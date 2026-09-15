/**
 * Roving-tabindex keyboard navigation for the review sidebar's rows of controls.
 *
 * The sidebar used to be entirely mouse-only (every control at tabIndex -1). This
 * makes a region keyboard-reachable and navigable without stealing the editor's
 * focus model: exactly ONE item in the region is tabbable (tabIndex 0), so Tab
 * lands on it once; the arrows then move focus among the items and carry
 * the tabbable slot with them. Enter/Space activate — natively for <button>
 * items, or by synthesizing a click for non-button rows (the outline's divs).
 * Escape hands focus back (onEscape, e.g. to the editor).
 *
 * ONE GROUP PER REGION, one Tab stop each, arrows along the region's own axis —
 * that is the model every WIRED region follows: the outline tree and the review
 * list bodies vertically, the sort / highlight toolbar horizontally. Merging a
 * horizontal row into a vertical list's group instead would put two axes in one
 * linear sequence — ArrowDown from "By type" would land on "In order", which
 * sits beside it, not below.
 *
 * Two things this does NOT cover, so the model is not the whole sidebar's:
 * - The TAB STRIP (toc/index.ts) hand-rolls the same roving-SLOT shape but with
 *   the tablist conventions instead — its arrows auto-activate (they switch the
 *   tab as focus moves) and WRAP, where this helper moves focus only and CLAMPS
 *   at both ends. Both are the APG convention for their own role; don't
 *   "harmonize" one into the other without deciding which role wins.
 * - The flip/hide controls and the per-row actions (Ignore / Add to dictionary)
 *   are still outside any group (MAR-295), and nothing focuses the sidebar from
 *   the editor in the first place — Tab is the editor's own indent key, so the
 *   entry gesture has to be chosen rather than assumed (MAR-294).
 *
 * `items()` is recomputed on every key so it always reflects the current DOM
 * (rows shown/hidden by a fold or a show-more), and `refresh()` re-seeds the
 * roving slot after the list rebuilds.
 */
export interface RovingOptions {
    /** The element to listen on (the scrolling list body, or a control row). */
    container: HTMLElement;
    /** Ordered, currently-focusable items, in visual order. */
    items: () => HTMLElement[];
    /** Which arrows move focus: "vertical" (Up/Down, the default) or
     *  "horizontal" (Left/Right, for a toolbar row). Home/End work in both. */
    orientation?: "vertical" | "horizontal";
    /** Where Escape (or a caller) sends focus — typically the editor. */
    onEscape?: () => void;
    /** Left/Right handling (e.g. tree fold) in a VERTICAL group. Return true when
     *  handled so the default does nothing. Ignored when horizontal, where
     *  Left/Right are the movement keys. */
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
    const horizontal = opts.orientation === "horizontal";
    const prevKey = horizontal ? "ArrowLeft" : "ArrowUp";
    const nextKey = horizontal ? "ArrowRight" : "ArrowDown";

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

        if (!horizontal && (e.key === "ArrowLeft" || e.key === "ArrowRight") && opts.onHorizontal) {
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
        if (e.key === nextKey) { e.preventDefault(); focusIndex(idx < 0 ? 0 : idx + 1); }
        else if (e.key === prevKey) { e.preventDefault(); focusIndex(idx < 0 ? 0 : idx - 1); }
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
