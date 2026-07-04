/**
 * Responsive toolbar overflow (MAR-10).
 *
 * Pure width math (`computeOverflow`) plus a small DOM controller
 * (`createOverflowController`) that physically reparents whole toolbar
 * groups into an overflow panel when the pane is too narrow, and moves
 * them back when space returns. Reparenting (rather than re-creating)
 * keeps every button's event listeners intact.
 */

/** Flex gap between toolbar items; keep in sync with `.toolbar { gap }` in toolbar.css. */
const TOOLBAR_GAP = 2;

/** Width assumed for the ⋯ button before it has ever been laid out. */
const FALLBACK_MORE_WIDTH = 30;

export interface OverflowGroup {
    /** Stable group name (mirrors the wrapper's `data-group` attribute). */
    name: string;
    /** The `.tb-group` wrapper element living in the toolbar. */
    el: HTMLElement;
    /** Separator rendered immediately before this group, if any. */
    sepBefore: HTMLElement | null;
}

/**
 * Decide which groups must collapse into the overflow menu.
 *
 * @param groupWidths   Natural width of each group (indexed by group index).
 *                      A width of 0 means the group is absent/hidden and is skipped.
 * @param collapseOrder Group indices in collapse order (first to overflow first).
 *                      Indices not listed here never collapse.
 * @param available     Width available to the toolbar.
 * @param moreWidth     Width of the ⋯ button, reserved once anything collapses.
 * @returns Set of group indices that should be collapsed into the panel.
 */
export function computeOverflow(
    groupWidths: number[],
    collapseOrder: number[],
    available: number,
    moreWidth = 0,
): Set<number> {
    const collapsed = new Set<number>();
    let total = groupWidths.reduce((sum, w) => sum + w, 0);
    if (total <= available) {
        return collapsed;
    }
    // Once anything collapses the ⋯ button itself takes up room.
    const budget = Math.max(0, available - moreWidth);
    for (const idx of collapseOrder) {
        if (total <= budget) {
            break;
        }
        const w = groupWidths[idx] ?? 0;
        if (w <= 0) {
            continue; // hidden or absent group — nothing to collapse
        }
        collapsed.add(idx);
        total -= w;
    }
    return collapsed;
}

export interface OverflowControllerOptions {
    /** The `.toolbar` flex container owning the groups. */
    toolbar: HTMLElement;
    /** Groups in toolbar DOM order. */
    groups: OverflowGroup[];
    /** Indices into `groups`, first-to-collapse first. */
    collapseOrder: number[];
    /** Wrapper of the ⋯ button (already appended to the toolbar). */
    moreWrap: HTMLElement;
    /** Dropdown panel that collapsed groups are reparented into. */
    panel: HTMLElement;
    /** Width measurement, injectable for tests (jsdom has no layout). */
    measure?: (el: HTMLElement) => number;
}

export interface OverflowController {
    /** Recompute for the given available width and apply reparenting. */
    update(available: number): void;
    /** Re-run with the last known width (e.g. after a group is shown/hidden). */
    refresh(): void;
    /** Names of the currently collapsed groups (for tests/debugging). */
    collapsedNames(): string[];
}

export function createOverflowController(
    options: OverflowControllerOptions,
): OverflowController {
    const { toolbar, groups, collapseOrder, moreWrap, panel } = options;
    const measure =
        options.measure ?? ((el: HTMLElement) => el.getBoundingClientRect().width);

    // Hysteresis: cache each group's natural width at its first successful
    // measure, so collapse and restore decisions use the same numbers and
    // width jitter around the boundary cannot oscillate.
    const naturalWidths: (number | null)[] = groups.map(() => null);
    let moreWidth: number | null = null;
    let lastAvailable = 0;
    let collapsedSet = new Set<number>();

    // Comment markers pin each group's home slot so it can be reparented
    // back to the exact position (comments are invisible to flex layout).
    const markers = groups.map((g) => {
        const marker = document.createComment(`tb-slot-${g.name}`);
        g.el.parentNode?.insertBefore(marker, g.el);
        return marker;
    });

    function isGroupHidden(group: OverflowGroup): boolean {
        return group.el.style.display === "none";
    }

    function widthOf(index: number): number {
        const group = groups[index]!;
        if (isGroupHidden(group)) {
            return 0;
        }
        if (naturalWidths[index] == null) {
            // Only measure in natural (toolbar) layout — panel layout differs.
            if (group.el.parentElement !== toolbar) {
                return 0;
            }
            const own = measure(group.el);
            if (own <= 0) {
                return 0; // not laid out yet — don't cache a bogus width
            }
            const sepW = group.sepBefore
                ? measure(group.sepBefore) + TOOLBAR_GAP
                : 0;
            naturalWidths[index] = own + TOOLBAR_GAP + sepW;
        }
        return naturalWidths[index]!;
    }

    function measureMore(): number {
        if (moreWidth == null) {
            const prevDisplay = moreWrap.style.display;
            moreWrap.style.display = "";
            const w = measure(moreWrap);
            moreWrap.style.display = prevDisplay;
            if (w <= 0) {
                return FALLBACK_MORE_WIDTH; // not laid out yet — don't cache
            }
            moreWidth = w + TOOLBAR_GAP;
        }
        return moreWidth;
    }

    function update(available: number): void {
        lastAvailable = available;
        const widths = groups.map((_, i) => widthOf(i));
        collapsedSet = computeOverflow(
            widths,
            collapseOrder,
            available,
            measureMore(),
        );

        groups.forEach((group, i) => {
            const shouldCollapse = collapsedSet.has(i);
            if (!shouldCollapse && group.el.parentElement === panel) {
                toolbar.insertBefore(group.el, markers[i]!.nextSibling);
            }
            if (group.sepBefore) {
                group.sepBefore.style.display =
                    shouldCollapse || isGroupHidden(group) ? "none" : "";
            }
        });

        // Append collapsed groups in ascending index order so the panel's
        // rows mirror the toolbar order (appendChild moves existing nodes,
        // preserving their event listeners).
        [...collapsedSet]
            .sort((a, b) => a - b)
            .forEach((i) => panel.appendChild(groups[i]!.el));

        moreWrap.style.display = collapsedSet.size > 0 ? "" : "none";
    }

    return {
        update,
        refresh(): void {
            update(lastAvailable);
        },
        collapsedNames(): string[] {
            return [...collapsedSet]
                .sort((a, b) => a - b)
                .map((i) => groups[i]!.name);
        },
    };
}
