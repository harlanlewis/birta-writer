/**
 * trackEditorReflow: fires onReflow on scroll (capture) and content resize,
 * coalesced to one call per animation frame, and stops cleanly on dispose.
 * rAF is driven manually so coalescing is observable deterministically.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { trackEditorReflow } from "../ui/editorReflow";

describe("trackEditorReflow", () => {
    let rafCbs: Array<FrameRequestCallback | null>;
    let flush: () => void;

    beforeEach(() => {
        rafCbs = [];
        vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
            rafCbs.push(cb);
            return rafCbs.length;
        });
        vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
            rafCbs[(id as number) - 1] = null;
        });
        flush = () => {
            const pending = rafCbs;
            rafCbs = [];
            pending.forEach((cb) => cb?.(0));
        };
    });

    afterEach(() => vi.restoreAllMocks());

    it("should call onReflow once per frame no matter how many scrolls fired", () => {
        const onReflow = vi.fn();
        const dispose = trackEditorReflow(document.createElement("div"), onReflow);

        // Three scrolls within one frame → coalesced into a single reflow.
        window.dispatchEvent(new Event("scroll"));
        window.dispatchEvent(new Event("scroll"));
        window.dispatchEvent(new Event("scroll"));
        expect(onReflow).not.toHaveBeenCalled(); // nothing until the frame runs
        flush();
        expect(onReflow).toHaveBeenCalledTimes(1);

        // A later scroll schedules a fresh frame.
        window.dispatchEvent(new Event("scroll"));
        flush();
        expect(onReflow).toHaveBeenCalledTimes(2);

        dispose();
    });

    it("should stop firing after dispose", () => {
        const onReflow = vi.fn();
        const dispose = trackEditorReflow(document.createElement("div"), onReflow);

        dispose();
        window.dispatchEvent(new Event("scroll"));
        flush();

        expect(onReflow).not.toHaveBeenCalled();
    });

    it("should observe the passed content element and disconnect on dispose", () => {
        const observe = vi.fn();
        const disconnect = vi.fn();
        vi.stubGlobal(
            "ResizeObserver",
            class {
                observe = observe;
                unobserve = vi.fn();
                disconnect = disconnect;
            },
        );
        const el = document.createElement("div");

        const dispose = trackEditorReflow(el, vi.fn());
        expect(observe).toHaveBeenCalledWith(el);

        dispose();
        expect(disconnect).toHaveBeenCalledTimes(1);

        vi.unstubAllGlobals();
    });
});
