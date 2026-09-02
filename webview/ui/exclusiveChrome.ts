/**
 * ui/exclusiveChrome.ts — one piece of transient chrome out at a time.
 *
 * A menu and a hover preview are both the editor answering "what else is
 * here", and two of them on screen at once is the editor answering it twice.
 * The Mac app shows it plainly: the table-of-contents flyout comes out under
 * the pointer, a toolbar dropdown opens over the top of it, and neither knows
 * about the other, so the flyout is left as a card with a menu sitting on it.
 *
 * The rule: OPENING one of these dismisses the others. Nothing here decides
 * which surfaces those are; a surface joins by claiming, and only the toolbar
 * dropdowns (`components/toolbar/hoverMenu.ts`) and the TOC flyout
 * (`components/toc/index.ts`) do.
 *
 * WHAT DOES NOT BELONG HERE, because the distinction is the whole of the
 * design: a surface the user is WORKING IN is not transient chrome. The find
 * bar, the link editor, a pinned popup and the lightbox all stay open across
 * other gestures on purpose, and a rule that swept them away would be reading
 * "only one thing at a time" as a statement about windows rather than about
 * menus. Docked panels are not here either: the TOC DRAWER is a panel and
 * stays; only its hover flyout claims.
 *
 * ## Not the Escape stack
 *
 * `ui/escapeLayers.ts` is a stack of surfaces that answer the Escape KEY, in
 * open order, and it exists so one Escape closes one thing. This is a set of
 * surfaces that may not be out together at all, and the two memberships are
 * genuinely different: the find bar answers Escape and must not be swept, and
 * the TOC flyout is swept and never registers for Escape, because it retracts
 * on its own when the pointer leaves. Merging them would give one of those two
 * the other's behaviour.
 *
 * ## Nesting
 *
 * A claim never dismisses a surface that CONTAINS it. The toolbar's overflow
 * menu can hold a dropdown of its own, so a nested menu opening would
 * otherwise close the menu it is drawn inside and take itself off the screen
 * with it. Containment is asked of the DOM rather than declared, so a menu
 * that is moved into another one is correct without being told.
 */

interface OpenSurface {
    /** The surface's own box, for the containment test above. */
    readonly element: HTMLElement;
    readonly dismiss: () => void;
}

const open = new Map<symbol, OpenSurface>();

/**
 * Declare `token`'s surface open, dismissing every other one that is not an
 * ancestor of it.
 *
 * Each entry is removed BEFORE its `dismiss` runs, so a dismiss calling
 * `releaseExclusiveChrome` — which every close path does — is a no-op rather
 * than a mutation of the map being walked. The walk is over a copy for the
 * same reason: a dismiss may claim or release in turn.
 */
export function claimExclusiveChrome(
    token: symbol,
    element: HTMLElement,
    dismiss: () => void,
): void {
    for (const [other, surface] of [...open]) {
        if (other === token || surface.element.contains(element)) { continue; }
        open.delete(other);
        surface.dismiss();
    }
    open.set(token, { element, dismiss });
}

/** Declare `token`'s surface closed. Idempotent, and safe to call unclaimed. */
export function releaseExclusiveChrome(token: symbol): void {
    open.delete(token);
}
