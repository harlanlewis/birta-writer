/**
 * Typewriter mode (birta.typewriterMode): hold the line being edited at a
 * fixed vertical anchor so the document scrolls under a stationary caret.
 *
 * There is no scrolling code here, and that is the point. ProseMirror already
 * settles the viewport after every transaction-driven scroll, reading the
 * `scrollThreshold` and `scrollMargin` props that plugins/caretScrollMargin.ts
 * owns. Typewriter mode is the degenerate case of those bands: make the
 * no-scroll window exactly one caret tall in the middle of the viewport and
 * every scroll ProseMirror already performs lands the caret centered. So this
 * module computes insets and nothing else - no rAF loop, no scroll listener,
 * and no feedback-loop guard, because it never scrolls anything itself.
 *
 * That also decides which gestures move the viewport. ProseMirror applies
 * these props only to transaction-driven scrolls, so typing and keyboard
 * navigation recenter and a mouse click does not, which is the behavior the
 * mode wants: it must not yank the page out from under a pointer.
 *
 * The overscroll band that lets the LAST line reach the anchor is not ours
 * either. `#editor` already carries `padding-bottom: 50vh` (see style.css,
 * where it is documented as overscroll rather than spacing), so the end of the
 * document can already be brought up the screen. Nothing here needs to pad it.
 */

import type { CaretScrollBand } from "./caretScrollMargin";

/**
 * Vertical slack between the caret and the bottom edge of the no-scroll band.
 *
 * Without it the band is exactly the caret's height, and a caret settled
 * against one edge sits on an exact equality with the other. `coordsAtPos`
 * reports subpixel heights, so that equality is a floating-point one and does
 * not reliably hold: the caret satisfies the top branch, is moved to where it
 * satisfies the bottom branch, and alternates on every keystroke - the viewport
 * jitter caretScrollMargin's own clamp exists to prevent. One pixel of slack
 * makes both corrections fixed points instead. Setting this to 0 fails
 * `typewriterScroll.test.ts`, which sweeps fractional caret heights for exactly
 * that reason; whole-pixel heights alone do not reach the case.
 */
const BAND_SLACK_PX = 1;

/** Inputs for the anchor computation, all in CSS pixels. */
export interface TypewriterInput {
    /** Height of the scrolling viewport. */
    viewportHeight: number;
    /** Height of the caret's own rect, which varies by block (a heading is taller). */
    caretHeight: number;
    /** Bottom edge of the fixed topbar, which paints over the top of the viewport. */
    topbarBottom: number;
}

/**
 * The caret-scroll band that centers a caret of `caretHeight`, or null when
 * centering does not apply and the caller should fall back to the ordinary
 * scrolloff insets.
 *
 * It declines rather than clamping, because the two failure modes want
 * different answers and a clamp would silently pick one. A pane too short to
 * center the caret clear of the topbar wants the ordinary insets, which reserve
 * the header stack explicitly; degenerate geometry (a caret taller than the
 * viewport, an unmeasurable pane) wants them too, and neither wants a band
 * squeezed into a shape that no longer centers anything.
 */
export function computeTypewriterInsets({
    viewportHeight,
    caretHeight,
    topbarBottom,
}: TypewriterInput): CaretScrollBand | null {
    if (!Number.isFinite(viewportHeight) || !Number.isFinite(caretHeight)) {
        return null;
    }
    if (viewportHeight <= 0 || caretHeight <= 0 || caretHeight >= viewportHeight) {
        return null;
    }
    const top = Math.floor((viewportHeight - caretHeight) / 2);
    // A centered caret that lands under the fixed topbar is worse than an
    // uncentered one: the mode exists to keep the line you are typing in sight.
    if (top < topbarBottom) {
        return null;
    }
    const bottom = Math.max(0, viewportHeight - caretHeight - top - BAND_SLACK_PX);
    return { top, bottom };
}

/**
 * Whether the mode is on. Read at the moment of a scroll rather than pushed
 * into anything, so a flip takes effect on the next caret movement with no
 * re-render, and so the disabled case costs one boolean read on a path that
 * runs on every keystroke.
 */
let enabled = false;

export function isTypewriterMode(): boolean {
    return enabled;
}

/** Applies a birta.typewriterMode change (boot value or a live setting update). */
export function setTypewriterMode(next: boolean): void {
    enabled = next;
}
