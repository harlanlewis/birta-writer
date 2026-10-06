/**
 * firstScreen.ts: when the page tells its host its first screen is up. Once,
 * after the side panels settle (or the grace runs out), after a painted frame
 * on a visible page and at once on a hidden one, which paints nothing until
 * the host that is waiting on this shows it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFirstScreen, SIDE_PANEL_GRACE_MS } from "../firstScreen";

let visibility: DocumentVisibilityState = "visible";
let frames: FrameRequestCallback[] = [];

/** Run the frames requested so far, as one paint does. */
function paint(): void {
    const due = frames;
    frames = [];
    for (const cb of due) { cb(0); }
}

function setVisibility(next: DocumentVisibilityState): void {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
}

/** Let settled promises run their continuations. */
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) { await Promise.resolve(); } };

describe("the first screen", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        visibility = "visible";
        frames = [];
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        delete (document as { visibilityState?: unknown }).visibilityState;
    });

    it("a visible page with nothing to wait for should post after one painted frame, not before", async () => {
        const post = vi.fn();
        createFirstScreen(post).announce(Promise.resolve());
        await flush();
        expect(post).not.toHaveBeenCalled();
        paint(); // the frame that draws the mounted screen
        expect(post).not.toHaveBeenCalled();
        paint(); // the frame after it: the first one has been presented
        expect(post).toHaveBeenCalledTimes(1);
    });

    it("a hidden page should post at once, since no frame will come until it is shown", async () => {
        visibility = "hidden";
        const post = vi.fn();
        createFirstScreen(post).announce(Promise.resolve());
        await flush();
        expect(post).toHaveBeenCalledTimes(1);
        expect(frames).toHaveLength(0);
    });

    it("the page should wait for its side panels to settle before it counts as up", async () => {
        visibility = "hidden";
        const post = vi.fn();
        let settle!: () => void;
        createFirstScreen(post).announce(new Promise<void>((r) => { settle = r; }));
        await flush();
        expect(post).not.toHaveBeenCalled();
        settle();
        await flush();
        expect(post).toHaveBeenCalledTimes(1);
    });

    it("side panels that never settle should hold the page back for the grace and no longer", async () => {
        visibility = "hidden";
        const post = vi.fn();
        createFirstScreen(post).announce(new Promise<void>(() => {}));
        await vi.advanceTimersByTimeAsync(SIDE_PANEL_GRACE_MS - 1);
        expect(post).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(post).toHaveBeenCalledTimes(1);
    });

    it("a page hidden while it waits for its frame should post then rather than wait to be shown", async () => {
        const post = vi.fn();
        createFirstScreen(post).announce(Promise.resolve());
        await flush();
        expect(frames.length).toBeGreaterThan(0);
        setVisibility("hidden");
        expect(post).toHaveBeenCalledTimes(1);
        // ...and the frames that do come later do not post a second time.
        paint();
        paint();
        expect(post).toHaveBeenCalledTimes(1);
    });

    it("a page hidden BEFORE its screen is complete should not post early", async () => {
        const post = vi.fn();
        let settle!: () => void;
        createFirstScreen(post).announce(new Promise<void>((r) => { settle = r; }));
        setVisibility("hidden");
        await flush();
        expect(post).not.toHaveBeenCalled();
        settle();
        await flush();
        expect(post).toHaveBeenCalledTimes(1);
    });

    it("a second announce (a re-init on a page already up) should post nothing", async () => {
        visibility = "hidden";
        const post = vi.fn();
        const screen = createFirstScreen(post);
        screen.announce(Promise.resolve());
        screen.announce(Promise.resolve());
        await flush();
        expect(post).toHaveBeenCalledTimes(1);
    });
});
