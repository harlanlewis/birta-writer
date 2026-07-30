/**
 * scrollPersistence.ts
 *
 * Responsibility: persist scroll position across sessions.
 *
 * This module provides:
 * - Listening for scroll events and debounce-saving the scroll position to VSCode WebView state
 * - Restoring the scroll position on tab switch (visibilitychange)
 * - Restoring a tab's scroll position after a VSCode restart
 */

import { getWebviewState, setWebviewState } from "./messaging";
import type { EventManager } from "./eventManager";

// ── Scroll position persistence ────────────────────────────────────────────
// Save: on scroll, debounce-write into VSCode WebView state (recoverable across sessions)
let _scrollSaveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Record the current scroll position RIGHT NOW, superseding the remembered one.
 *
 * Every scroll is normally saved on a 200 ms debounce, and for a user scrolling
 * with a wheel that is exactly right. An arriving navigation — a search hit, a
 * caret carried in from the raw editor — is different: it lands in one jump,
 * and the panel is hidden and shown around the same moment it opens. A restore
 * firing inside that 200 ms window put the view back where the file was last
 * left and undid the jump, leaving the match selected but off screen (MAR-268).
 *
 * So the reveal claims the position immediately: the memory now says "here",
 * and a restore that lands afterwards restores the jump rather than fighting it.
 */
export function rememberScrollNow(): void {
    if (_scrollSaveTimer) { clearTimeout(_scrollSaveTimer); _scrollSaveTimer = null; }
    setWebviewState({ ...(getWebviewState() ?? {}), scrollY: window.scrollY });
}

/** Initialize scroll position persistence */
export function initScrollPersistence(eventManager: EventManager): void {
    eventManager.onWindow("scroll", () => {
        if (_scrollSaveTimer) clearTimeout(_scrollSaveTimer);
        _scrollSaveTimer = setTimeout(() => {
            const cur = getWebviewState() ?? {};
            setWebviewState({ ...cur, scrollY: window.scrollY });
        }, 200);
    }, { passive: true });

    // Restore (main path): on tab switch the iframe is hidden then shown, and the browser resets scrollY.
    // When visibilitychange fires, read the saved position and restore it.
    eventManager.onDocument("visibilitychange", () => {
        if (document.visibilityState !== 'visible') return;
        const state = getWebviewState();
        if (state?.scrollY !== undefined) {
            requestAnimationFrame(() => {
                window.scrollTo({ top: state.scrollY as number });
            });
        }
    });
}
