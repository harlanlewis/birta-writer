/**
 * Shared placement for every toolbar hover-dropdown (Format, Font, Settings,
 * Checks, Debug, and the overflow menu). Toolbar items can be dragged to any
 * zone, so a menu's fixed side (left:0 or right:0) inevitably clips at whichever
 * viewport edge its button ends up near. This picks the side and vertical
 * direction that fit, measured per-open.
 *
 * The geometry is a pure function (`computeMenuPlacement`) so it can be unit
 * tested with plain numbers; `placeMenu` is the thin DOM wrapper that measures
 * the live button + menu and applies the result.
 */

export interface Rect { left: number; right: number; top: number; bottom: number; }
export interface Size { width: number; height: number; }
export interface Viewport { width: number; height: number; }

/**
 * `alignRight`: anchor the menu's right edge to the button's right (open
 * leftward) instead of its left edge (open rightward).
 * `flipUp`: open above the button instead of below.
 */
export interface Placement { alignRight: boolean; flipUp: boolean; }

/** Gap between the button and the menu, and the min margin from a viewport edge. */
export const MENU_GAP = 6;
const EDGE_MARGIN = 8;

/**
 * Choose the corner a dropdown opens from so it stays on-screen.
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
