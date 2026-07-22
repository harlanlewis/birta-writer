/**
 * Review sidebar shell (MAR-188): the ToC panel carries three tabs — Contents /
 * Proofreading / Notes — and switching a tab swaps which view is shown while
 * keeping the others hidden (so an inactive tab does no layout/scan work).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initToc } from "../components/toc";
import type { EventManager } from "../eventManager";

const fakeEventManager = { onWindow: vi.fn() } as unknown as EventManager;

function clickTab(tab: Element): void {
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

describe("review sidebar tabs", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
        document.body.className = "";
        document.body.innerHTML = "";
    });

    afterEach(() => { vi.unstubAllGlobals(); });

    it("should render three tabs labelled Contents, Proofreading, Notes", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        const labels = [...panel.querySelectorAll(".toc-tab")].map((t) => t.textContent);
        expect(labels).toEqual(["Contents", "Proofreading", "Notes"]);
    });

    it("should start on Contents with the review views hidden", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        const [contentsTab] = panel.querySelectorAll(".toc-tab");
        expect(contentsTab!.classList.contains("toc-tab--active")).toBe(true);
        expect(panel.querySelector(".toc-list")!.classList.contains("toc-view--hidden")).toBe(false);
        expect(panel.querySelector(".review-list--proofread")!.classList.contains("toc-view--hidden")).toBe(true);
        expect(panel.querySelector(".review-list--notes")!.classList.contains("toc-view--hidden")).toBe(true);
    });

    it("clicking Proofreading should show only the proofreading view", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        const tabs = panel.querySelectorAll(".toc-tab");
        clickTab(tabs[1]!); // Proofreading
        expect(tabs[1]!.classList.contains("toc-tab--active")).toBe(true);
        expect(tabs[0]!.classList.contains("toc-tab--active")).toBe(false);
        expect(panel.querySelector(".toc-list")!.classList.contains("toc-view--hidden")).toBe(true);
        expect(panel.querySelector(".review-list--proofread")!.classList.contains("toc-view--hidden")).toBe(false);
        expect(panel.querySelector(".review-list--notes")!.classList.contains("toc-view--hidden")).toBe(true);
    });

    it("clicking Notes should show only the notes view", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        const tabs = panel.querySelectorAll(".toc-tab");
        clickTab(tabs[2]!); // Notes
        expect(panel.querySelector(".review-list--notes")!.classList.contains("toc-view--hidden")).toBe(false);
        expect(panel.querySelector(".toc-list")!.classList.contains("toc-view--hidden")).toBe(true);
    });

    it("the flip/hide controls should live inside the tab strip", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        expect(panel.querySelector(".toc-tabs .toc-controls")).not.toBeNull();
        expect(panel.querySelector(".toc-tabs .toc-hide-btn")).not.toBeNull();
    });

    it("setNotesMarkers should apply without throwing when the tab is hidden", () => {
        const toc = initToc(fakeEventManager, () => null);
        expect(() => toc.setNotesMarkers(["DRAFT", "@ai"])).not.toThrow();
    });
});
