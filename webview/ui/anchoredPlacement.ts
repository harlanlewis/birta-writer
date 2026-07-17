/**
 * ui/anchoredPlacement.ts — the anchored-popup positioning engine.
 *
 * Every transient surface that opens next to an anchor (toolbar dropdowns,
 * the link popup, suggest menus, the proofread popup, footnote previews …)
 * must answer the same two questions: which side of the anchor fits, and how
 * far in from the viewport edges may it sit. This module owns that geometry
 * so each surface stops rediscovering `window.innerWidth/innerHeight` and the
 * 8px edge margin by hand (MAR-80).
 *
 * Two engines, matching the two positioning models in the codebase:
 *
 * - `computeAnchoredPosition` — coordinate placement for popups positioned in
 *   viewport/document coordinates (`position: fixed`, or absolute + scroll
 *   offsets added by the caller). Slides horizontally to stay on screen and
 *   flips above/below per a configurable policy.
 * - `computeMenuPlacement` / `placeMenu` — parent-relative corner choice for
 *   menus nested inside their trigger's wrapper (the toolbar hover dropdowns):
 *   the menu is CSS-anchored to the wrap (`left:0`/`right:0`,
 *   `calc(100% + gap)`), so the engine only picks which corner to anchor to.
 *
 * All functions are pure over plain numbers so they unit-test without layout;
 * the thin DOM appliers (`placeMenu`) live beside them.
 */

export interface Rect { left: number; right: number; top: number; bottom: number; }
export interface Size { width: number; height: number; }
export interface Viewport { width: number; height: number; }

/** Default gap between the anchor and the popup. */
export const MENU_GAP = 6;
/** Default minimum distance kept from a viewport edge. */
export const EDGE_MARGIN = 8;

/**
 * Clamp a popup's left edge so it stays on screen: never past the right-edge
 * margin, never left of `minLeft`. `minLeft` defaults to `margin`; pass 0 for
 * surfaces that may hug the left edge (frontmatter suggest menu).
 */
export function clampLeft(
    left: number,
    width: number,
    viewport: Viewport,
    margin: number = EDGE_MARGIN,
    minLeft: number = margin,
): number {
    return Math.max(minLeft, Math.min(left, viewport.width - width - margin));
}

/**
 * What to do when the popup does not fit below the anchor:
 * - `"larger-side"`: flip above only when there is MORE room above than below
 *   (an overflowing popup takes the larger side and clips/scrolls there).
 * - `"overflow"`: always flip above on overflow, even into less room (the
 *   caller typically clamps the resulting top afterwards).
 */
export type FlipPolicy = "larger-side" | "overflow";

export interface AnchoredOptions {
    /** Gap between the anchor edge and the popup edge. Default `MENU_GAP`. */
    gap?: number;
    /** Viewport edge margin for the horizontal clamp. Default `EDGE_MARGIN`. */
    margin?: number;
    /**
     * Free space required below the anchor BEYOND the popup height to count
     * as "fits below". Sites differ (some reserve the edge margin, some the
     * gap, some nothing) — default is `margin`, matching the most common form
     * `spaceBelow >= height + 8`.
     */
    fitSlack?: number;
    /** Vertical flip policy. Default `"larger-side"`. */
    flipPolicy?: FlipPolicy;
    /**
     * Height used for the fits-below check when it differs from the measured
     * `size.height` (frontmatter's suggest menu reserves its max height so it
     * can grow in place as async rows arrive). Defaults to `size.height`.
     */
    fitHeight?: number;
    /** Lower bound for the horizontal clamp. Defaults to `margin`. */
    minLeft?: number;
}

export interface AnchoredPosition {
    /** Clamped left edge, in the anchor rect's coordinate space. */
    left: number;
    /**
     * Top edge: `anchor.bottom + gap` when below, `anchor.top - gap - height`
     * when flipped above.
     */
    top: number;
    /** True when the popup flipped above the anchor. */
    above: boolean;
    /**
     * CSS `bottom` value pinning the popup's bottom edge `gap` above the
     * anchor's top — for above-placements that must grow upward as their
     * content changes (suggest menus anchored via `style.bottom`).
     */
    cssBottom: number;
}

/**
 * Place a popup of `size` against an anchor `rect`: below by default, flipped
 * above per `flipPolicy`, left edge clamped into the viewport. Coordinates are
 * whatever space the anchor rect is in — viewport coords for `position: fixed`
 * consumers; document-coord consumers add their scroll offsets afterwards.
 */
export function computeAnchoredPosition(
    anchor: Rect,
    size: Size,
    viewport: Viewport,
    opts: AnchoredOptions = {},
): AnchoredPosition {
    const gap = opts.gap ?? MENU_GAP;
    const margin = opts.margin ?? EDGE_MARGIN;
    const fitSlack = opts.fitSlack ?? margin;
    const fitHeight = opts.fitHeight ?? size.height;
    const policy = opts.flipPolicy ?? "larger-side";

    const spaceBelow = viewport.height - anchor.bottom;
    const spaceAbove = anchor.top;
    const fitsBelow = spaceBelow >= fitHeight + fitSlack;
    const above = policy === "larger-side"
        ? !fitsBelow && spaceAbove > spaceBelow
        : !fitsBelow;

    return {
        left: clampLeft(anchor.left, size.width, viewport, margin, opts.minLeft),
        top: above ? anchor.top - gap - size.height : anchor.bottom + gap,
        above,
        cssBottom: viewport.height - anchor.top + gap,
    };
}

/**
 * `alignRight`: anchor the menu's right edge to the button's right (open
 * leftward) instead of its left edge (open rightward).
 * `flipUp`: open above the button instead of below.
 */
export interface Placement { alignRight: boolean; flipUp: boolean; }

/**
 * Choose the corner a parent-relative dropdown opens from so it stays
 * on-screen (the toolbar hover menus: Format, Font, Settings, Checks, Debug,
 * overflow — their buttons can be dragged to any zone, so a fixed side
 * inevitably clips at whichever viewport edge the button ends up near).
 * - Horizontal: default open rightward (menu's left edge at the button's left).
 *   Flip to right-aligned only if opening rightward overflows the right edge
 *   AND right-aligning actually fits — otherwise a menu wider than the button's
 *   left offset would just clip the other side instead.
 * - Vertical: default open below; flip above only if below overflows and above
 *   fits (a top-docked toolbar always opens below).
 */
export function computeMenuPlacement(
    anchor: Rect,
    menu: Size,
    viewport: Viewport,
    gap: number = MENU_GAP,
    margin: number = EDGE_MARGIN,
): Placement {
    const overflowsRight = anchor.left + menu.width > viewport.width - margin;
    const rightAlignFits = anchor.right - menu.width >= margin;
    const alignRight = overflowsRight && rightAlignFits;

    const overflowsBottom = anchor.bottom + gap + menu.height > viewport.height - margin;
    const flipUpFits = anchor.top - gap - menu.height >= margin;
    const flipUp = overflowsBottom && flipUpFits;

    return { alignRight, flipUp };
}

/** Measure the live button + menu and set the menu's edges to fit the viewport. */
export function placeMenu(anchor: HTMLElement, menu: HTMLElement): void {
    const r = anchor.getBoundingClientRect();
    // offsetWidth/Height need the menu laid out (display != none) — every caller
    // shows it first. Fall back to the CSS min-width if it hasn't painted yet.
    const width = menu.offsetWidth || parseFloat(getComputedStyle(menu).minWidth) || 160;
    const height = menu.offsetHeight || 0;
    const { alignRight, flipUp } = computeMenuPlacement(
        { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
    );
    menu.style.left = alignRight ? "auto" : "0";
    menu.style.right = alignRight ? "0" : "auto";
    menu.style.top = flipUp ? "auto" : `calc(100% + ${MENU_GAP}px)`;
    menu.style.bottom = flipUp ? `calc(100% + ${MENU_GAP}px)` : "auto";
}

/** The live viewport, as every DOM-side caller measures it. */
export function viewportSize(): Viewport {
    return { width: window.innerWidth, height: window.innerHeight };
}
