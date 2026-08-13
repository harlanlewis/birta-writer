/**
 * Dispatching a mouse gesture the way a browser actually delivers one: the
 * pointer event first, then its mouse compatibility twin.
 *
 * The block drag session arms and runs on the POINTER names, so a finger can
 * drive it too (MAR-340), while the surrounding wiring still listens on the
 * mouse ones — the gutter marker's caret-preserving preventDefault, the TOC's
 * drag arming and leave-tracking. A test firing only one half of the pair
 * would exercise a shape of the wiring no real input produces.
 *
 * jsdom has no PointerEvent constructor, so the twin is a MouseEvent under
 * the pointer name. The session reads only geometry and `isPrimary === false`
 * off it, neither of which that costs; a test that needs a genuine
 * PointerEvent needs the e2e harness instead (e2e/touchBlocks).
 */

/** The pointer event a real mouse fires just before each mouse event. */
const POINTER_TWIN: Record<string, string> = {
    mousedown: "pointerdown",
    mousemove: "pointermove",
    mouseup: "pointerup",
};

/** Dispatch `type` on `target`, preceded by its pointer twin where one exists.
 * Returns the mouse event's own dispatch result, as `dispatchEvent` does. */
export function dispatchMouseGesture(
    target: EventTarget,
    type: string,
    opts: MouseEventInit,
): boolean {
    const twin = POINTER_TWIN[type];
    if (twin) {
        target.dispatchEvent(new MouseEvent(twin, { bubbles: true, cancelable: true, ...opts }));
    }
    return target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...opts }));
}
