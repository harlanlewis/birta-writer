/**
 * Keep a body-mounted overlay glued to editor content as it moves beneath it.
 *
 * Floating chrome anchored to document coordinates — the formatting palette, the
 * link popup — is placed once from a measured rect. When the content then moves
 * (scrolling, or a reflow: the ToC docking/resizing/toggling, a window resize, a
 * wrapped line shifting), that rect goes stale and the overlay strands at its
 * old spot, visibly disconnected from its target.
 *
 * `trackEditorReflow` fires `onReflow` on three triggers — capture-phase scroll
 * (so any scroller counts, not just the window), a ResizeObserver on the
 * editor content box, and the sticky heading title's safe-area change event —
 * coalesced to one call per animation frame, so a burst of scroll events costs
 * a single reposition. Returns a disposer that removes the listeners,
 * disconnects the observer, and cancels any pending frame.
 */
import { SAFE_AREA_CHANGE_EVENT } from "../utils/headingUtils";

export function trackEditorReflow(
    content: Element,
    onReflow: () => void,
): () => void {
    let frame = 0;
    const schedule = (): void => {
        if (frame) { return; }
        frame = requestAnimationFrame(() => {
            frame = 0;
            onReflow();
        });
    };

    // Capture phase so a scroll on any inner scroller (not just the window)
    // reaches us — a scroll event doesn't bubble.
    window.addEventListener("scroll", schedule, true);

    // The sticky heading title shows and hides on its OWN rAF after a scroll,
    // so a single-event scroll (a TOC click, a find jump) can land this
    // frame one tick before the bar appears — scroll plus resize alone would
    // leave every consumer that measured safeAreaTop()/viewportSize() in the
    // reflow pass one frame stale under the bar, with no further trigger
    // (utils/headingUtils documents the event's contract).
    window.addEventListener(SAFE_AREA_CHANGE_EVENT, schedule);

    const observer = new ResizeObserver(schedule);
    observer.observe(content);

    return (): void => {
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        window.removeEventListener("scroll", schedule, true);
        window.removeEventListener(SAFE_AREA_CHANGE_EVENT, schedule);
        observer.disconnect();
    };
}
