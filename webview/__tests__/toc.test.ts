/**
 * toc component tests: dock side is driven by the toc-right body class
 * (set by the extension from the markdownWysiwyg.tocPosition setting).
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

    it("default (left) should pin the reveal tab to the left edge", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        const tab = document.querySelector(".toc-toggle-tab") as HTMLElement;
        expect(panel.classList.contains("toc-panel--right")).toBe(false);
        expect(tab.style.left).toBe("7px");
        // Carries the dock-side glyph, not a chevron
        expect(tab.querySelector("svg")).not.toBeNull();
    });

    it("toc-right body class should pin the reveal tab to the right edge", () => {
        document.body.classList.add("toc-right");
        const { panel } = initToc(fakeEventManager, () => null);
        const tab = document.querySelector(".toc-toggle-tab") as HTMLElement;
        expect(panel.classList.contains("toc-panel--right")).toBe(true);
        expect(tab.style.right).toBe("7px");
        expect(tab.style.left).toBe("auto");
        expect(tab.querySelector("svg")).not.toBeNull();
    });

    it("opening the TOC should keep the reveal tab pinned to the outer edge (the header hide button takes over)", () => {
        document.body.classList.add("toc-right");
        const { panel, toggle } = initToc(fakeEventManager, () => null);
        toggle();
        const tab = document.querySelector(".toc-toggle-tab") as HTMLElement;
        // The reveal tab no longer slides beside the panel — it stays at the
        // corner; CSS hides it while open, and the header carries a hide button.
        expect(tab.style.right).toBe("7px");
        expect(panel.querySelector(".toc-hide-btn")).not.toBeNull();
    });
});

describe("TOC header controls (side-switch, hide, reveal)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
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

    function getFlip(panel: HTMLElement): HTMLElement {
        return panel.querySelector(".toc-flip-btn") as HTMLElement;
    }

    it("the header should render a side-switch and a hide button", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        expect(getFlip(panel)).not.toBeNull();
        expect(panel.querySelector(".toc-hide-btn")).not.toBeNull();
        // Both are icon buttons
        expect(getFlip(panel).querySelector("svg")).not.toBeNull();
        expect(panel.querySelector(".toc-hide-btn svg")).not.toBeNull();
    });

    it("clicking the flip button on a left-docked panel should move it right and persist the choice", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        expect(panel.classList.contains("toc-panel--right")).toBe(false);

        getFlip(panel).dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));

        expect(panel.classList.contains("toc-panel--right")).toBe(true);
        expect(document.body.classList.contains("toc-right")).toBe(true);
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "setTocPosition", position: "right" });
    });

    it("clicking the flip button on a right-docked panel should move it left and persist the choice", () => {
        document.body.classList.add("toc-right");
        const { panel } = initToc(fakeEventManager, () => null);

        getFlip(panel).dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));

        expect(panel.classList.contains("toc-panel--right")).toBe(false);
        expect(document.body.classList.contains("toc-right")).toBe(false);
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "setTocPosition", position: "left" });
    });

    it("setPosition should flip the panel and the tab side without a fresh init", () => {
        const { panel, setPosition } = initToc(fakeEventManager, () => null);
        const tab = document.querySelector(".toc-toggle-tab") as HTMLElement;
        // Left-docked initially: reveal tab pinned near the left edge
        expect(tab.style.left).toBe("7px");

        setPosition("right");

        expect(panel.classList.contains("toc-panel--right")).toBe(true);
        expect(tab.style.right).toBe("7px");
        expect(tab.style.left).toBe("auto");
    });

    it("setPosition to the current side should be a no-op that posts nothing", () => {
        const { panel, setPosition } = initToc(fakeEventManager, () => null);
        setPosition("left");
        expect(panel.classList.contains("toc-panel--right")).toBe(false);
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "setTocPosition" }),
        );
    });

    it("clicking the header hide button should collapse an open panel", () => {
        const { panel, toggle } = initToc(fakeEventManager, () => null);
        toggle(); // open
        expect(panel.classList.contains("toc-panel--open")).toBe(true);

        panel.querySelector(".toc-hide-btn")!
            .dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));

        expect(panel.classList.contains("toc-panel--open")).toBe(false);
    });

    it("clicking the reveal tab should open a closed panel", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        expect(panel.classList.contains("toc-panel--open")).toBe(false);

        document.querySelector(".toc-toggle-tab")!
            .dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));

        expect(panel.classList.contains("toc-panel--open")).toBe(true);
    });
});

describe("TOC panel position vs toolbar visibility", () => {
    function addTopbar(rect: { height: number; bottom: number }): void {
        const topbar = document.createElement("div");
        topbar.className = "editor-topbar";
        topbar.getBoundingClientRect = () =>
            ({ x: 0, y: 0, top: 0, left: 0, right: 0, width: 0, ...rect }) as DOMRect;
        document.body.appendChild(topbar);
    }

    beforeEach(() => {
        vi.clearAllMocks();
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

    it("a visible toolbar should align the panel below the bar's height", () => {
        addTopbar({ height: 40, bottom: 40 });
        const { panel } = initToc(fakeEventManager, () => null);
        expect(panel.style.top).toBe("40px");
        expect(panel.style.height).toBe("calc(100vh - 40px)");
    });

    it("body.toolbar-hidden should pin the panel flush to the viewport top", () => {
        // The bar hides via a translateY transition, so its rect still reports
        // the old geometry at measurement time — the class is the truth.
        addTopbar({ height: 40, bottom: 40 });
        document.body.classList.add("toolbar-hidden");
        const { panel } = initToc(fakeEventManager, () => null);
        expect(panel.style.top).toBe("0px");
        expect(panel.style.height).toBe("calc(100vh - 0px)");
    });

    it("a toolbar still sliding in (stale rect bottom) should not push the panel under it", () => {
        addTopbar({ height: 40, bottom: 0 });
        const { panel } = initToc(fakeEventManager, () => null);
        expect(panel.style.top).toBe("40px");
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

    it("resizing should keep the reveal tab pinned to the outer edge, not tracking the width", () => {
        const { panel, toggle } = initToc(fakeEventManager, () => null);
        toggle();
        drag(getHandle(panel), 220, 340);
        const tab = document.querySelector(".toc-toggle-tab") as HTMLElement;
        // The reveal tab sits at the docked corner regardless of panel width
        expect(tab.style.left).toBe("7px");
    });
});
