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
