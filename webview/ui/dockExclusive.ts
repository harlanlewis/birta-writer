/**
 * webview/ui/dockExclusive.ts
 *
 * Mutual exclusion for the right-docked overlay slot below the topbar. The
 * find bar and the Keyboard Shortcuts Help overlay occupy the IDENTICAL
 * fixed rect (same top / right:16px / z-index:1180 band — see findBar.css
 * and shortcutsHelp.css), so if both were visible at once, whichever opened
 * second would sit invisibly underneath by DOM order — with focus in an
 * unseeable input. Opening either surface claims the dock, closing whatever
 * else currently holds it.
 *
 * Both occupants import only this helper (never each other), so the
 * exclusion adds no import cycle.
 */

let occupant: { id: string; close: () => void } | null = null;

/**
 * Claim the dock for `id`, closing any OTHER current occupant first. Call on
 * every open path, before showing. Re-claiming under the same id just
 * refreshes the close handle.
 */
export function claimDock(id: string, close: () => void): void {
    if (occupant && occupant.id !== id) {
        occupant.close();
    }
    occupant = { id, close };
}

/** Release the dock if `id` still holds it. Call on every close path. */
export function releaseDock(id: string): void {
    if (occupant?.id === id) {
        occupant = null;
    }
}
