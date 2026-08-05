/**
 * A block's control column mounts EMPTY and attaches its buttons on first
 * reveal (ui/blockControls.ts, MAR-251), so a test that reaches for
 * `.bc-btn` straight after building a NodeView finds nothing — exactly as a
 * user who has never hovered the block would.
 *
 * Drive the production trigger rather than reaching past it: `pointerenter`
 * on the host is what the pointer arriving over the block (or over the
 * column's hit strip, a DOM descendant of the host) actually fires. jsdom has
 * no layout and runs no CSS transitions, so the other two triggers —
 * `focusin`, and the `transitionrun` that catches the pointer-free reveals
 * (`bc-active`, `bc-col--shown`) — are not observable here; those are covered
 * in Chromium by e2e/blockWidth.
 */
export function revealBlockControls(host: HTMLElement): void {
    host.dispatchEvent(new Event("pointerenter"));
}
