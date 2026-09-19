/**
 * `ui/proximityReveal.ts`: chrome that comes back as the pointer approaches.
 *
 * Two of these cases are about what the module must NOT do, and neither is
 * visible in a page that looks right. A strip that has not been laid out
 * measures as a zero-height box at the origin, which every pointer in the
 * window is "near", so it would sit permanently revealed and the feature would
 * read as simply not working rather than as measuring nothing. And a module
 * told to stop must really stop: a listener left on the document goes on
 * running for the rest of the session on a surface that is showing no strip at
 * all, which nothing on screen could show.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createProximityReveal } from "../ui/proximityReveal";

const CLASS = "near";

/** A strip whose box is ours to move, since jsdom lays nothing out. */
function strip(bottom: number, height = 30): HTMLElement {
    const el = document.createElement("div");
    document.body.appendChild(el);
    el.getBoundingClientRect = vi.fn(() => ({
        bottom, height, top: bottom - height, left: 0, right: 100, width: 100, x: 0, y: bottom - height,
        toJSON: () => ({}),
    }) as DOMRect);
    return el;
}

/** jsdom has no PointerEvent; the listener reads `clientY`, which this has. */
function move(clientY: number): void {
    document.dispatchEvent(new MouseEvent("pointermove", { clientY, bubbles: true }));
}

describe("proximity reveal", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
        vi.clearAllMocks();
    });

    it("an inactive reveal should watch nothing, so a strip that is away costs nothing", () => {
        const el = strip(100);
        const reveal = createProximityReveal({ el, marginPx: 50, className: CLASS });
        move(120);
        expect(el.classList.contains(CLASS)).toBe(false);
        // It never even measured: the listener was never attached.
        expect(el.getBoundingClientRect).not.toHaveBeenCalled();
        reveal.dispose();
    });

    it("a pointer inside the band should reveal, and one past it should let go", () => {
        const el = strip(100);
        const reveal = createProximityReveal({ el, marginPx: 50, className: CLASS });
        reveal.setActive(true);

        move(140);                                        // inside: 140 <= 100 + 50
        expect(el.classList.contains(CLASS)).toBe(true);
        move(151);                                        // past the band
        expect(el.classList.contains(CLASS)).toBe(false);
        move(10);                                         // above the strip is near by definition
        expect(el.classList.contains(CLASS)).toBe(true);
        reveal.dispose();
    });

    it("the edge should be measured once and reused until something invalidates it", () => {
        // The cost claim in the module header. Reading layout per pointer move
        // is the shape this is written to avoid, and only a count can say so:
        // the class would be identical either way.
        const el = strip(100);
        const reveal = createProximityReveal({ el, marginPx: 50, className: CLASS });
        reveal.setActive(true);
        for (let y = 120; y < 140; y++) { move(y); }
        expect(el.getBoundingClientRect).toHaveBeenCalledTimes(1);

        reveal.invalidate();
        move(130);
        expect(el.getBoundingClientRect).toHaveBeenCalledTimes(2);
        reveal.dispose();
    });

    it("a strip with no box should never read as near, however close the pointer is", () => {
        // A zero-height rect sits at the origin, so an unguarded band would
        // cover the whole window and the strip would be revealed forever.
        const el = strip(0, 0);
        const reveal = createProximityReveal({ el, marginPx: 50, className: CLASS });
        reveal.setActive(true);
        move(0);
        move(400);
        expect(el.classList.contains(CLASS)).toBe(false);
        reveal.dispose();
    });

    it("going inactive should drop the class AND the listener", () => {
        const el = strip(100);
        const reveal = createProximityReveal({ el, marginPx: 50, className: CLASS });
        reveal.setActive(true);
        move(120);
        expect(el.classList.contains(CLASS)).toBe(true);

        reveal.setActive(false);
        expect(el.classList.contains(CLASS)).toBe(false);
        // The listener is gone rather than early-returning: a move that would
        // have revealed does not even measure.
        const before = (el.getBoundingClientRect as ReturnType<typeof vi.fn>).mock.calls.length;
        move(120);
        expect(el.classList.contains(CLASS)).toBe(false);
        expect((el.getBoundingClientRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
        reveal.dispose();
    });

    it("a strip activated before it is in the DOM should still watch its parent once it is", () => {
        // The ordinary order: a surface builds its chrome, paints its initial
        // state (which activates this), and is appended by whoever asked for
        // it. A parent looked for at activation is therefore routinely null,
        // and the one case it covers — a strip that MOVES without resizing,
        // which is what a row appearing above it does — would be silently lost.
        const observed: Element[] = [];
        const prior = globalThis.ResizeObserver;
        globalThis.ResizeObserver = class {
            observe(el: Element): void { observed.push(el); }
            disconnect(): void { /* not under test */ }
            unobserve(): void { /* not under test */ }
        } as unknown as typeof ResizeObserver;
        try {
            const el = document.createElement("div");   // no parent yet
            el.getBoundingClientRect = vi.fn(() => ({
                bottom: 100, height: 30, top: 70, left: 0, right: 100, width: 100,
                x: 0, y: 70, toJSON: () => ({}),
            }) as DOMRect);
            const reveal = createProximityReveal({ el, marginPx: 50, className: CLASS });
            reveal.setActive(true);
            expect(observed).toEqual([el]);

            const parent = document.createElement("div");
            parent.appendChild(el);
            document.body.appendChild(parent);
            move(120);
            expect(el.classList.contains(CLASS)).toBe(true);
            expect(observed).toEqual([el, parent]);

            // Once only: a move per frame must not pile up observations.
            move(121);
            move(122);
            expect(observed).toEqual([el, parent]);
            reveal.dispose();
        } finally {
            globalThis.ResizeObserver = prior;
        }
    });

    it("dispose should leave nothing behind, even from an active watch", () => {
        const el = strip(100);
        const reveal = createProximityReveal({ el, marginPx: 50, className: CLASS });
        reveal.setActive(true);
        move(120);
        reveal.dispose();
        expect(el.classList.contains(CLASS)).toBe(false);
        move(120);
        expect(el.classList.contains(CLASS)).toBe(false);
    });
});
