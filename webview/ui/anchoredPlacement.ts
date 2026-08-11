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
 * A third, smaller engine answers a different question for chrome that is not
 * a popup at all: a block's OWN controls, which have a resting place on the
 * block (a table's column grips on its top edge, a control column at its
 * top-right) rather than a side to open on. Those cannot flip; they slide.
 * `pinIntoView` is that rule, and `viewportSpan` its live measurement.
 *
 * All functions are pure over plain numbers so they unit-test without layout;
 * the thin DOM appliers (`placeMenu`) live beside them.
 *
 * The viewport these engines fit against is asymmetric: its top edge is
 * `safeAreaTop()`, not 0, because the topbar and sticky heading are fixed and
 * opaque and nearly every popup paints beneath them. See `Viewport.top`.
 */
import { safeAreaTop } from "../utils/headingUtils";

export interface Rect { left: number; right: number; top: number; bottom: number; }
export interface Size { width: number; height: number; }
export interface Viewport {
    width: number;
    height: number;
    /**
     * Where the usable area STARTS, in viewport coords — not 0. The topbar and
     * the sticky heading title are fixed and opaque, and nearly every popup
     * paints below them, so space in that band is not space at all. Optional
     * and defaulting to 0 so the pure functions stay callable from tests
     * without a DOM; `viewportSize()` fills it in for every live caller.
     */
    top?: number;
}

/** Default gap between the anchor and the popup. */
export const MENU_GAP = 6;
/** Default minimum distance kept from a viewport edge. */
export const EDGE_MARGIN = 8;
/**
 * Floor for the reported `maxHeight`. A popup squeezed below this is better off
 * scrolling internally at a useless-but-honest size than collapsing to nothing.
 */
export const MIN_POPUP_HEIGHT = 48;

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
    /**
     * Space actually available on the chosen side, for callers to apply as a
     * `max-height`. A popup that cannot fit either side should SCROLL at this
     * height rather than overflow an edge — clamping a full-height popup after
     * the fact moves it without shrinking it, which just pushes the overflow
     * to the opposite edge (the bug recorded at blockMenu/menu.ts:1176-1181).
     */
    maxHeight: number;
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

    const safeTop = viewport.top ?? 0;

    // Both measurements start at the safe edge, not at 0: an anchor that has
    // scrolled under the fixed chrome has no room above it, however large its
    // `top` reads. The below-side start line is likewise clamped BEFORE the
    // space is measured, so a squeezed popup shrinks instead of sliding down.
    const belowTop = Math.max(anchor.bottom + gap, safeTop);
    const spaceBelow = viewport.height - Math.max(anchor.bottom, safeTop);
    const spaceAbove = anchor.top - safeTop;
    const fitsBelow = spaceBelow >= fitHeight + fitSlack;
    const above = policy === "larger-side"
        ? !fitsBelow && spaceAbove > spaceBelow
        : !fitsBelow;

    return {
        left: clampLeft(anchor.left, size.width, viewport, margin, opts.minLeft),
        top: above ? Math.max(safeTop, anchor.top - gap - size.height) : belowTop,
        above,
        cssBottom: viewport.height - anchor.top + gap,
        maxHeight: Math.max(
            MIN_POPUP_HEIGHT,
            above ? spaceAbove - gap : viewport.height - margin - belowTop,
        ),
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
    const flipUpFits = anchor.top - gap - menu.height >= (viewport.top ?? 0) + margin;
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
        viewportSize(),
    );
    menu.style.left = alignRight ? "auto" : "0";
    menu.style.right = alignRight ? "0" : "auto";
    menu.style.top = flipUp ? "auto" : `calc(100% + ${MENU_GAP}px)`;
    menu.style.bottom = flipUp ? `calc(100% + ${MENU_GAP}px)` : "auto";
}

/**
 * The live usable area, as every DOM-side caller measures it.
 *
 * `top` is the single seam through which the fixed chrome reaches the geometry:
 * every surface already passing this to `computeAnchoredPosition` becomes
 * topbar-aware without touching its own call site.
 */
export function viewportSize(): Viewport {
    return { width: window.innerWidth, height: window.innerHeight, top: safeAreaTop() };
}

/** A one-dimensional extent, in viewport coordinates. */
export interface Span { start: number; end: number; }

/**
 * Keep a block's own chrome on screen while the block scrolls past.
 *
 * A popup can flip to the other side of its anchor; a block's controls cannot,
 * because their anchor IS the block — a table's column grips belong on its top
 * edge, a control column at its top-right. When the block is taller than the
 * viewport, that edge scrolls away while the block is still the whole of what
 * the reader is looking at, and chrome pinned to it leaves with it. There is no
 * side to flip to; the strip slides along the block instead.
 *
 * Two clamps, and the ORDER between them is the whole rule. First fit the
 * viewport, then re-fit the block, so the block wins: chrome for a block that
 * has itself scrolled off must go off screen with it rather than sit at the
 * viewport edge pointing at nothing.
 *
 * @param preferred the resting coordinate — where the chrome sits when the
 *                  whole block is in view
 * @param size      the chrome's extent along the same axis
 * @param block     the range the chrome may occupy; it never leaves its block
 * @param view      the usable viewport band (see `viewportSpan`)
 */
export function pinIntoView(
    preferred: number,
    size: number,
    block: Span,
    view: Span,
): number {
    const inView = Math.min(Math.max(preferred, view.start), view.end - size);
    return Math.min(Math.max(inView, block.start), Math.max(block.start, block.end - size));
}

/**
 * The vertical band a block's chrome may occupy: below the fixed chrome, above
 * the bottom edge margin. The `pinIntoView` counterpart of `viewportSize`.
 */
export function viewportSpan(margin: number = EDGE_MARGIN): Span {
    return { start: safeAreaTop(), end: window.innerHeight - margin };
}
