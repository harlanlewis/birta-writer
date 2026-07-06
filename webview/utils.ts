// ─── Global shared utility functions ─────────────────────────────────────

/** Lock body scrolling (called when opening a fullscreen/modal view) */
export function lockBodyScroll(): void {
    document.body.style.overflow = "hidden";
}

/** Restore body scrolling (called when closing a fullscreen/modal view) */
export function unlockBodyScroll(): void {
    document.body.style.overflow = "";
}

/**
 * Play the close animation on a fullscreen overlay, then remove it from the DOM
 * and run onDone for state cleanup once the animation ends.
 * Relies on the CSS class `.lb-closing` (which triggers the lb-close keyframes).
 */
export function animateCloseLightbox(overlay: HTMLElement, onDone: () => void): void {
    overlay.classList.add("lb-closing");
    overlay.addEventListener("animationend", () => {
        if (document.body.contains(overlay)) document.body.removeChild(overlay);
        onDone();
    }, { once: true });
}

/**
 * Bind the three close triggers for a fullscreen overlay:
 * - close button mousedown
 * - clicking the overlay backdrop (e.target === overlay)
 * - the ESC key
 * Returns a cleanup function (removes the keydown listener), to be called in onDone.
 */
export function bindLightboxDismiss(
    overlay: HTMLElement,
    closeBtn: HTMLElement,
    onClose: () => void,
): () => void {
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    closeBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); onClose(); });
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) onClose(); });
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
}
