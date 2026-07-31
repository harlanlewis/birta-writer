/**
 * webview/editing/fileDrop.ts — where a dragged-in image file will land.
 *
 * The drop ITSELF belongs to plugins/imagePaste.ts, inside ProseMirror's own
 * `handleDrop` (MAR-277: a handler outside PM runs after it and produced two
 * half-broken images per drop). This module owns only what happens *before*
 * the release, which PM gives no hook for: the aim.
 *
 *   - While an image drag is over the editor it draws the same accent line a
 *     block drag and a TOC drag draw (showBoundaryIndicator), snapped to the
 *     block boundary nearest the pointer.
 *   - Holding near the top or bottom edge auto-scrolls on the block drag's own
 *     ramp, so a drop isn't confined to what was on screen when the drag began.
 *   - `aimedDropPos()` hands that boundary to `handleDrop`, so the image lands
 *     on the line the user was shown. `posAtCoords` alone cannot express it:
 *     it answers with the inline position under the pointer, which is mid-
 *     sentence as often as not, while the line promises a block of its own.
 *
 * **What no webview can control.** VS Code claims external file drags over an
 * editor first: the workbench's `editorDropTarget` paints a full-size overlay
 * ("Hold ⇧ to drop into editor") and, without that modifier, opens the file as
 * a new tab. Shift is the only way through — `onDragOver` reads a hard-coded
 * `e.shiftKey` and disposes the overlay, after which the drag reaches this
 * document. The two related knobs (`editor.dropIntoEditor.enabled`, and the
 * active editor advertising that it accepts drops) only *gate* that Shift
 * pass-through, so disabling either makes the overlay unconditional rather
 * than removing it. Everything here begins the moment the drag arrives.
 *
 * `preventDefault` on dragenter/dragover is what lets a drop fire in this
 * document at all (the HTML5 contract). Listeners are capture-phase so the aim
 * is current before anything else looks at the event; the drop is left to
 * propagate through to ProseMirror.
 */
import type { EditorView } from "../pm";
import {
    createBoundaryMeasurer,
    dropTargetFor,
    hideDropIndicator,
    scrollVelocityFor,
    showBoundaryIndicator,
    type DropBoundary,
} from "../components/blockMenu";
import type { EventManager } from "../eventManager";

/**
 * Whether a drag carries at least one image file. Read from `items` rather
 * than `files` because a drag in flight exposes only the item list — `files`
 * is empty until the drop — and `kind`/`type` are the two fields that survive
 * that restriction.
 */
export function dragCarriesImageFile(e: DragEvent): boolean {
    const items = e.dataTransfer?.items;
    if (!items) {
        return false;
    }
    return Array.from(items).some(
        (i) => i.kind === "file" && i.type.startsWith("image/"),
    );
}

/**
 * Whether a `dragleave` means the drag left this document, rather than merely
 * crossing from one element to the next inside it — `dragleave` fires for both
 * and the distinction decides whether the drop line stays up.
 *
 * Measured in headless Chromium rather than assumed: an internal crossing
 * reports the element being entered as `relatedTarget` and pointer coordinates
 * inside the viewport, so a null `relatedTarget` or coordinates on/outside the
 * viewport edge mean departure.
 *
 * The alternative — hide after a quiet period — cannot work here: the same
 * probe recorded **zero** `dragover` events across two seconds of a stationary
 * pointer mid-drag. Chromium fires `dragover` on movement, not on a clock, so
 * any "no events lately ⇒ gone" rule erases the line exactly when the user
 * holds still to aim before releasing.
 */
export function dragLeftDocument(e: DragEvent): boolean {
    return (
        e.relatedTarget === null ||
        e.clientX <= 0 ||
        e.clientY <= 0 ||
        e.clientX >= window.innerWidth ||
        e.clientY >= window.innerHeight
    );
}

/** The boundary the drop line is currently on, or null when nothing is aimed
 * (no drag in flight, or the pointer is over chrome rather than the text).
 * Read by plugins/imagePaste.ts's handleDrop at release. */
let aimed: DropBoundary | null = null;

/** The document position the drop line is promising, or null. */
export function aimedDropPos(): number | null {
    return aimed?.pos ?? null;
}

/** Take the drop chrome down. The commit path calls this once it has read the
 * aim; the drag path calls it when the drag leaves or is abandoned. */
export function clearDropAim(): void {
    aimed = null;
    hideDropIndicator();
}

export interface ImageFileDropOptions {
    /** The editor element. Everything that floats over it — the TOC panel,
     * the toolbar, popups — mounts on `<body>` instead, so a containment
     * test here excludes all of it at once: chrome is not a drop surface. */
    container: HTMLElement;
    getView: () => EditorView | null;
}

/**
 * Wire the drag-time aim onto `document`. One listener set per EventManager;
 * the manager unbinds them on dispose.
 */
export function initImageFileDrop(
    eventManager: EventManager,
    options: ImageFileDropOptions,
): void {
    // Re-reads rects on every aim and re-plans only when the editor state
    // changes, so a scroll (which changes geometry but no state) costs a rect
    // pass and nothing more. Boundary ys are viewport-relative, so measuring
    // fresh on every aim is what keeps the line honest after a mid-drag
    // scroll — by hand or by the edge auto-scroll below.
    const measurer = createBoundaryMeasurer("block");
    // Last known pointer position, and the edge auto-scroll loop it feeds.
    // The loop needs its own copy because drag events are movement-driven:
    // resting in the edge zone produces no further events at all (measured —
    // see dragLeftDocument), so a scroll that only advanced per event would
    // stall the moment the user held still at the edge, which is exactly when
    // they are asking for it.
    let lastX = 0;
    let lastY = 0;
    let scrollDir = 0;
    let scrollRaf = 0;

    const end = (): void => {
        scrollDir = 0;
        if (scrollRaf) {
            cancelAnimationFrame(scrollRaf);
            scrollRaf = 0;
        }
        measurer.reset();
        clearDropAim();
    };

    const aimAt = (x: number, y: number): void => {
        lastX = x;
        lastY = y;
        const view = options.getView();
        const over = view ? document.elementFromPoint(x, y) : null;
        if (!view || !over || !options.container.contains(over)) {
            clearDropAim();
            return;
        }
        // No dragged range: the payload comes from outside the document, so
        // every boundary is a legal landing.
        aimed = dropTargetFor(measurer.measure(view), y);
        if (aimed) {
            showBoundaryIndicator(view, aimed);
        } else {
            hideDropIndicator();
        }
    };

    /** One auto-scroll frame: shift the page, then re-aim at the geometry
     * that just moved (a rect pass, no re-planning — see the measurer). */
    const scrollLoop = (): void => {
        const velocity = scrollDir === 0 ? 0 : scrollVelocityFor(lastY);
        if (velocity === 0) {
            scrollRaf = 0;
            return;
        }
        window.scrollBy(0, velocity);
        aimAt(lastX, lastY);
        scrollRaf = requestAnimationFrame(scrollLoop);
    };

    /** Arm or disarm the edge scroll for a pointer at `y`. Shares the block
     * drag's ramp (scrollVelocityFor), so every drag in the editor — a block,
     * a TOC item, a dropped file — accelerates identically at the edges. */
    const updateEdgeScroll = (y: number): void => {
        const nextDir = Math.sign(scrollVelocityFor(y));
        if (nextDir === scrollDir) {
            return;
        }
        scrollDir = nextDir;
        if (scrollDir !== 0 && !scrollRaf) {
            scrollRaf = requestAnimationFrame(scrollLoop);
        }
    };

    const track = (e: DragEvent): void => {
        if (!dragCarriesImageFile(e)) {
            return;
        }
        // Claiming the gesture is what lets a drop fire here at all.
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = "copy";
        }
        aimAt(e.clientX, e.clientY);
        updateEdgeScroll(e.clientY);
    };

    eventManager.onDocument("dragenter", track, { capture: true });
    eventManager.onDocument("dragover", track, { capture: true });

    eventManager.onDocument("dragleave", (e) => {
        if (dragCarriesImageFile(e) && dragLeftDocument(e)) {
            end();
        }
    }, { capture: true });

    // The drag was abandoned (Escape, or released outside): take the line
    // down. A successful drop is torn down by the commit path instead, which
    // has to read the aim first.
    eventManager.onDocument("dragend", () => end(), { capture: true });
}
