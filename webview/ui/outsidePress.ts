/**
 * ui/outsidePress.ts — "close when the next press lands somewhere else".
 *
 * The dismissal rule every click-opened transient surface needs, and the one
 * the Escape layer stack (ui/escapeLayers.ts) deliberately does not cover:
 * that stack answers the Escape KEY, and a surface that leaned on it for the
 * pointer stayed open under every click that was not on its own trigger.
 *
 * CAPTURE phase, and that is the whole of why this works rather than a detail
 * of how it is written. Menu triggers call `stopPropagation` on their own
 * mousedown (`toolbar/menuPrimitives.ts`), so a bubble-phase listener on
 * `document` never hears a press on ANOTHER surface's trigger — which is the
 * case this exists for, since a bar whose menus open on click otherwise stacks
 * every menu it has opened on screen at once. Capture runs before the target,
 * so the press that opens the next surface is also the press that closes this
 * one.
 *
 * `mousedown` rather than `click`, so the surface is gone by the time the
 * press it was dismissed by does whatever else it does.
 */

/**
 * Call `onOutside` on the next press outside every element in `within`, and
 * on each one after that until the returned unregister runs.
 *
 * `within` is a list rather than one element because a surface and the button
 * that opens it are not always the same subtree: a press on the trigger of an
 * OPEN surface has to reach that trigger's own toggle rather than being eaten
 * as an outside press and then reopened by the same click.
 *
 * The unregister is idempotent, so a close path may call it and then be
 * reached again by another close path without removing a listener twice.
 */
export function watchOutsidePress(
    within: readonly (HTMLElement | null | undefined)[],
    onOutside: () => void,
): () => void {
    const onDown = (e: Event): void => {
        if (!(e.target instanceof Node)) { return; }
        for (const el of within) {
            if (el?.contains(e.target)) { return; }
        }
        onOutside();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
}
