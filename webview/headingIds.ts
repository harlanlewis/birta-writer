/**
 * headingIds.ts
 *
 * Note: we no longer use a MutationObserver to dynamically update heading ids.
 *
 * The original design set `el.id = slug` on the DOM nodes ProseMirror manages,
 * which caused:
 *   assignIds → el.id changes → ProseMirror detects a heading attribute change
 *   → replaces the heading node → childList mutation contains a heading → affectsHeadings=true
 *   → assignIds again → infinite loop (B087)
 *
 * linkPopup's findHeadingElement() already has a built-in slug-scan fallback, so
 * it can still locate the heading and scroll to it without relying on el.id.
 * This module therefore keeps its export signature (called by index.ts) but
 * performs no DOM operations.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function initHeadingIds(_container: HTMLElement): void {
    // Deliberately no DOM operations — see the comment above
}
