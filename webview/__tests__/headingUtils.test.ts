/**
 * headingUtils tests: getTopbarBottom must honor the toolbar-hidden contract
 * (body.toolbar-hidden ⇒ 0, mirroring --editor-topbar-height: 0px) and stay
 * immune to the topbar's slide transition — translateY moves the rect's
 * bottom while it animates, but never its height.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getTopbarBottom, scrollElementBelowTopbar } from "../utils/headingUtils";

function addTopbar(rect: { height: number; bottom: number }): HTMLElement {
    const topbar = document.createElement("div");
    topbar.className = "editor-topbar";
    topbar.getBoundingClientRect = () =>
        ({ x: 0, y: 0, top: 0, left: 0, right: 0, width: 0, ...rect }) as DOMRect;
    document.body.appendChild(topbar);
    return topbar;
}

describe("getTopbarBottom", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        document.body.className = "";
    });

    it("a visible topbar should report its measured height", () => {
        addTopbar({ height: 40, bottom: 40 });
        expect(getTopbarBottom()).toBe(40);
    });

    it("a topbar still sliding in (stale rect bottom) should still report its height", () => {
        // Mid show-transition the bar is translated up, so bottom reads ~0
        addTopbar({ height: 40, bottom: 0 });
        expect(getTopbarBottom()).toBe(40);
    });

    it("body.toolbar-hidden should return 0 even while the rect reports the old geometry", () => {
        addTopbar({ height: 40, bottom: 40 });
        document.body.classList.add("toolbar-hidden");
        expect(getTopbarBottom()).toBe(0);
    });

    it("no topbar in the DOM should fall back to 40", () => {
        expect(getTopbarBottom()).toBe(40);
    });
});

describe("scrollElementBelowTopbar", () => {
    const scrollTo = vi.fn();

    function elementAt(top: number): HTMLElement {
        const el = document.createElement("h2");
        el.getBoundingClientRect = () =>
            ({ x: 0, y: top, top, left: 0, right: 0, bottom: top + 30, width: 0, height: 30 }) as DOMRect;
        document.body.appendChild(el);
        return el;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        document.body.className = "";
        vi.stubGlobal("scrollTo", scrollTo);
        vi.stubGlobal("scrollY", 100);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("a visible toolbar should reserve the bar height plus the margin", () => {
        addTopbar({ height: 40, bottom: 40 });
        scrollElementBelowTopbar(elementAt(500));
        expect(scrollTo).toHaveBeenCalledWith({ top: 500 + 100 - 40 - 8, behavior: "smooth" });
    });

    it("a hidden toolbar should reserve only the margin", () => {
        addTopbar({ height: 40, bottom: 40 });
        document.body.classList.add("toolbar-hidden");
        scrollElementBelowTopbar(elementAt(500), 12);
        expect(scrollTo).toHaveBeenCalledWith({ top: 500 + 100 - 12, behavior: "smooth" });
    });

    it("a target above the document start should clamp to 0", () => {
        addTopbar({ height: 40, bottom: 40 });
        scrollElementBelowTopbar(elementAt(-500));
        expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    });

    it("an explicit behavior should pass through to scrollTo", () => {
        addTopbar({ height: 40, bottom: 40 });
        scrollElementBelowTopbar(elementAt(500), 60, "auto");
        expect(scrollTo).toHaveBeenCalledWith({ top: 500 + 100 - 40 - 60, behavior: "auto" });
    });
});
