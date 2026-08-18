/**
 * webview/ui/hoverSelection.ts
 *
 * One highlight, two inputs. Every menu here lets the pointer and the arrow
 * keys move the SAME highlight, which is the right call: Enter must fire the
 * row that looks selected, and a menu with a separate hover ring and keyboard
 * ring makes the reader guess which one Enter means.
 *
 * What that costs, unguarded, is that a pointer resting over the menu keeps
 * winning. `mouseover` fires whenever a row arrives under the pointer, and a
 * row arrives under a perfectly still pointer every time the list scrolls, a
 * re-filter re-renders the rows, or the menu is repositioned. So an arrow key
 * moves the highlight and the pointer immediately takes it back, and the rows
 * on the far side of the pointer cannot be reached from the keyboard at all.
 * The menu opens under the caret, which is usually under the pointer, so this
 * is the common case rather than a corner.
 *
 * The guard is the conventional one: a keyboard move parks the pointer, and
 * only genuine pointer MOTION wakes it. The distinction the DOM gives us for
 * free is that `mouseover` fires when the row moves under the pointer, while
 * `mousemove` with changed coordinates cannot happen unless the pointer itself
 * moved. Coordinates are compared rather than trusting the event, because a
 * scroll under a still pointer can also emit `mousemove` at the same point.
 *
 * Used by every menu whose rows bind `mouseover` to its selection:
 * `components/slashMenu`, `components/blockMenu`, `components/frontmatter/suggestMenu`.
 */

export interface HoverSelection {
    /** The keyboard moved the selection: ignore hover until the pointer moves. */
    keyboardMoved(): void;
    /** Guard for a `mouseover` handler: true only when the pointer really moved. */
    pointerIsLive(): boolean;
    /** Drop the listener; for menus that tear their root down. */
    dispose(): void;
}

/**
 * Watch `root` for real pointer motion. Capture phase, so a row that stops
 * propagation of its own mouse events cannot blind the guard.
 */
export function createHoverSelection(root: HTMLElement): HoverSelection {
    // Live until proven otherwise: a menu opened by the pointer should honour
    // the pointer, and the first keyboard move is what parks it.
    let live = true;
    let lastX = Number.NaN;
    let lastY = Number.NaN;

    const onMove = (e: MouseEvent): void => {
        if (e.clientX === lastX && e.clientY === lastY) {
            return;
        }
        lastX = e.clientX;
        lastY = e.clientY;
        live = true;
    };
    root.addEventListener("mousemove", onMove, true);

    return {
        keyboardMoved(): void {
            live = false;
        },
        pointerIsLive(): boolean {
            return live;
        },
        dispose(): void {
            root.removeEventListener("mousemove", onMove, true);
        },
    };
}
