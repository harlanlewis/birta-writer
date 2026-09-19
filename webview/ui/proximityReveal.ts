/**
 * ui/proximityReveal.ts — chrome that comes back when you reach for it.
 *
 * A strip of controls the writer is not currently using can be quiet without
 * being gone: it fades toward its ground at rest and comes up to full ink as
 * the pointer approaches. The gutter already works this way (see
 * docs/DESIGN_PRINCIPLES.md, "Handles are revealed, not resident"); this is
 * the same rule applied to a bar.
 *
 * ## Why this is not all CSS, and why most of it still is
 *
 * `:hover` and `:focus-within` on the strip are the correct answer to ARRIVING
 * and they cost nothing, so they stay in the stylesheet and this module never
 * touches them. What CSS cannot express is APPROACHING: a band below the strip
 * that reveals it before the pointer gets there. A sensor element over that
 * band would have to take pointer events to be hovered at all, and the band is
 * the content's top padding, where a click is somebody aiming at the first
 * line. So the band is measured rather than drawn.
 *
 * The two layers compose: with this disposed the strip still reveals on hover
 * and on focus, so a failure here is a later reveal rather than chrome that
 * cannot be reached.
 *
 * ## What it costs
 *
 * One passive `pointermove` listener whose body is two number comparisons and,
 * on a crossing, one `classList.toggle`. It reads no layout on that path: the
 * edge is cached and recomputed only after something invalidates it, which the
 * observers below flag rather than measure, so a resize storm costs one
 * measurement on the next move instead of one per notification.
 *
 * The class lands on the STRIP and never on `body` or the editor root. That is
 * the rule `bodyClassRestyle.test.ts` guards: a class flipped by a gesture
 * must not carry style that reaches the whole document, and `opacity` on one
 * element restyles that element's subtree alone.
 *
 * Listen only while there is something to reveal. `setActive(false)` drops the
 * listener outright rather than early-returning inside it, so a surface whose
 * strip is put away pays nothing at all.
 */

export interface ProximityRevealOptions {
    /** The strip to reveal. The class lands here, and its box is measured. */
    el: HTMLElement;
    /**
     * How far past the strip's bottom edge still counts as approaching, in CSS
     * pixels. The band is one-sided: anything ABOVE the bottom edge is near by
     * definition, since the strip is docked to the top of the window.
     */
    marginPx: number;
    /** The class set on `el` while the pointer is within the band. */
    className: string;
}

export interface ProximityReveal {
    /** Start or stop watching. Stopping drops the listener and clears the class. */
    setActive: (active: boolean) => void;
    /** Say that the strip's box may have moved; the next move re-measures. */
    invalidate: () => void;
    /** Drop every listener and the class (tests, teardown). */
    dispose: () => void;
}

export function createProximityReveal(
    { el, marginPx, className }: ProximityRevealOptions,
): ProximityReveal {
    // The bottom edge of the band, in viewport coordinates. `null` means "not
    // measured yet", which is also what `invalidate` restores it to; the next
    // pointer move pays for one `getBoundingClientRect` and nothing else does.
    let edge: number | null = null;
    let near = false;
    let active = false;
    // Whether the strip's parent is being watched. Asked at MEASURE time
    // rather than at activation, because a strip is routinely activated before
    // it is in the DOM (a surface builds its chrome, paints its initial state,
    // and is appended by whoever asked for it), and a parent looked for then
    // is a parent that does not exist yet. Missing it costs the one case the
    // strip's own box cannot report: a strip that MOVES without resizing,
    // which is what a row appearing above it does.
    let watchingParent = false;

    const setNear = (next: boolean): void => {
        if (next === near) { return; }
        near = next;
        el.classList.toggle(className, next);
    };

    const onPointerMove = (e: PointerEvent): void => {
        if (edge === null) {
            // A strip that is not laid out has no band. Measuring it would
            // report a zero-height box at the origin, and every pointer in the
            // window would read as near it.
            const rect = el.getBoundingClientRect();
            if (rect.height === 0) { return; }
            if (!watchingParent && el.parentElement) {
                resizeObserver?.observe(el.parentElement);
                watchingParent = true;
            }
            edge = rect.bottom + marginPx;
        }
        setNear(e.clientY <= edge);
    };

    const invalidate = (): void => { edge = null; };

    // A resize moves the edge. So does the strip's own box changing, which
    // happens when a row is added to the bar above it or a drawer takes its
    // top padding. Both only FLAG, so the measurement stays on the one path
    // that needs the answer.
    const resizeObserver = typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(invalidate)
        : null;

    const setActive = (next: boolean): void => {
        if (next === active) { return; }
        active = next;
        if (next) {
            invalidate();
            document.addEventListener("pointermove", onPointerMove, { passive: true });
            window.addEventListener("resize", invalidate);
            resizeObserver?.observe(el);
        } else {
            document.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("resize", invalidate);
            resizeObserver?.disconnect();
            watchingParent = false;
            setNear(false);
        }
    };

    return {
        setActive,
        invalidate,
        dispose: (): void => {
            setActive(false);
            resizeObserver?.disconnect();
        },
    };
}
