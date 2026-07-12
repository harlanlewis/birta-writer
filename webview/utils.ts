// ─── Global shared utility functions ─────────────────────────────────────

import { registerEscapeLayer } from "./ui/escapeLayers";

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
    // Registered as an Escape layer: with focus in editor content, blockKeys'
    // Escape wiring closes the lightbox (topmost surface) instead of
    // block-selecting beneath it. The document listener stays as the fallback
    // for focus outside ProseMirror (the lightbox's own textarea/buttons);
    // the defaultPrevented guard keeps one Escape from closing two surfaces,
    // and stopPropagation keeps the consumed chord from the workbench.
    const escapeLayerOff = registerEscapeLayer(onClose);
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
            e.preventDefault();
            e.stopPropagation();
            onClose();
        }
    };
    closeBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); onClose(); });
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) onClose(); });
    document.addEventListener("keydown", onKey);
    return () => {
        escapeLayerOff();
        document.removeEventListener("keydown", onKey);
    };
}
