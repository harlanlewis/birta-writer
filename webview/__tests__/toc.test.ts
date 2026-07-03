/**
 * toc component tests: dock side is driven by the toc-right body class
 * (set by the extension from the markdownWysiwyg.tocPosition setting).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initToc } from "../components/toc";
import type { EventManager } from "../eventManager";

const fakeEventManager = { onWindow: vi.fn() } as unknown as EventManager;

describe("initToc dock side", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Run animation-frame callbacks synchronously so init completes inline
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
            cb(0);
            return 0;
        });
        document.body.className = "";
        document.body.innerHTML = "";
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("default (left) should dock the toggle tab at the left edge", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        const tab = document.querySelector(".toc-toggle-tab") as HTMLElement;
        expect(panel.classList.contains("toc-panel--right")).toBe(false);
        expect(tab.style.left).toBe("0px");
        expect(tab.textContent).toBe("›");
    });

    it("toc-right body class should dock the toggle tab at the right edge", () => {
        document.body.classList.add("toc-right");
        const { panel } = initToc(fakeEventManager, () => null);
        const tab = document.querySelector(".toc-toggle-tab") as HTMLElement;
        expect(panel.classList.contains("toc-panel--right")).toBe(true);
        expect(tab.style.right).toBe("0px");
        expect(tab.style.left).toBe("auto");
        expect(tab.textContent).toBe("‹");
    });

    it("opening a right-docked TOC should move the tab beside the panel", () => {
        document.body.classList.add("toc-right");
        const { toggle } = initToc(fakeEventManager, () => null);
        toggle();
        const tab = document.querySelector(".toc-toggle-tab") as HTMLElement;
        expect(tab.style.right).toBe("220px");
        expect(tab.textContent).toBe("›");
    });
});
