/**
 * toc component tests: dock side is driven by the toc-right body class
 * (set by the extension from the markdownWriter.tocPosition setting).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initToc } from "../components/toc";
import type { EventManager } from "../eventManager";
import { mockVscodeApi } from "./setup";

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

describe("TOC drag-to-resize", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
            cb(0);
            return 0;
        });
        document.body.className = "";
        document.body.innerHTML = "";
        document.body.style.cssText = "";
        document.documentElement.style.cssText = "";
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function getHandle(panel: HTMLElement): HTMLElement {
        return panel.querySelector(".toc-resize-handle") as HTMLElement;
    }

    function mouse(type: string, clientX: number): MouseEvent {
        return new MouseEvent(type, { button: 0, clientX, bubbles: true });
    }

    function drag(handle: HTMLElement, from: number, to: number): void {
        handle.dispatchEvent(mouse("mousedown", from));
        document.dispatchEvent(mouse("mousemove", to));
        document.dispatchEvent(mouse("mouseup", to));
    }

    it("panel should contain a resize handle with a horizontal resize cursor", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        const handle = getHandle(panel);
        expect(handle).not.toBeNull();
        // Non-mac by default in tests (window.__i18n is unset)
        expect(handle.style.cursor).toBe("ew-resize");
    });

    it("dragging rightwards on a left-docked panel should widen it and persist the width", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        drag(getHandle(panel), 220, 300);
        expect(document.documentElement.style.getPropertyValue("--toc-width")).toBe("300px");
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "tocWidth", width: 300 });
    });

    it("dragging leftwards on a right-docked panel should widen it", () => {
        document.body.classList.add("toc-right");
        const { panel } = initToc(fakeEventManager, () => null);
        drag(getHandle(panel), 800, 720);
        expect(document.documentElement.style.getPropertyValue("--toc-width")).toBe("300px");
    });

    it("dragging far beyond the edges should clamp the width to the min/max bounds", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        drag(getHandle(panel), 220, 2000);
        expect(document.documentElement.style.getPropertyValue("--toc-width")).toBe("600px");
        drag(getHandle(panel), 600, 0);
        expect(document.documentElement.style.getPropertyValue("--toc-width")).toBe("150px");
    });

    it("during a drag the body should get resizing state, cleared on mouseup", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        const handle = getHandle(panel);
        handle.dispatchEvent(mouse("mousedown", 220));
        expect(document.body.classList.contains("toc-resizing")).toBe(true);
        expect(document.body.style.cursor).toBe("ew-resize");
        document.dispatchEvent(mouse("mouseup", 220));
        expect(document.body.classList.contains("toc-resizing")).toBe(false);
        expect(document.body.style.cursor).toBe("");
    });

    it("mousemove after mouseup should not change the width", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        drag(getHandle(panel), 220, 300);
        document.dispatchEvent(mouse("mousemove", 500));
        expect(document.documentElement.style.getPropertyValue("--toc-width")).toBe("300px");
    });

    it("an unchanged width on mouseup should not post a tocWidth message", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        drag(getHandle(panel), 220, 220);
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "tocWidth" }),
        );
    });

    it("double-clicking the handle should reset the width to the default", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        const handle = getHandle(panel);
        drag(handle, 220, 400);
        handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        expect(document.documentElement.style.getPropertyValue("--toc-width")).toBe("220px");
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "tocWidth", width: 220 });
    });

    it("resizing while open should move the toggle tab along with the panel edge", () => {
        const { panel, toggle } = initToc(fakeEventManager, () => null);
        toggle();
        drag(getHandle(panel), 220, 340);
        const tab = document.querySelector(".toc-toggle-tab") as HTMLElement;
        expect(tab.style.left).toBe("340px");
    });
});
