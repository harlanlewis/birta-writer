/**
 * Keep a body-mounted overlay glued to editor content as it moves beneath it.
 *
 * Floating chrome anchored to document coordinates — the formatting palette, the
 * link popup — is placed once from a measured rect. When the content then moves
 * (scrolling, or a reflow: the ToC docking/resizing/toggling, a window resize, a
 * wrapped line shifting), that rect goes stale and the overlay strands at its
 * old spot, visibly disconnected from its target.
 *
 * `trackEditorReflow` fires `onReflow` on both triggers — capture-phase scroll
 * (so any scroller counts, not just the window) and a ResizeObserver on the
 * editor content box — coalesced to one call per animation frame, so a burst of
 * scroll events costs a single reposition. Returns a disposer that removes the
 * listener, disconnects the observer, and cancels any pending frame.
 */
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

    const observer = new ResizeObserver(schedule);
    observer.observe(content);

    return (): void => {
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        window.removeEventListener("scroll", schedule, true);
        observer.disconnect();
    };
}
