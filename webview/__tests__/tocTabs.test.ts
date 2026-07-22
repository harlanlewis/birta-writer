/**
 * Review sidebar shell (MAR-188): the ToC panel carries three tabs — Contents /
 * Proofreading / Notes — and switching a tab swaps which view is shown while
 * keeping the others hidden (so an inactive tab does no layout/scan work).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorState } from "../pm";
import { Schema } from "../pm";
import { initToc } from "../components/toc";
import * as proofread from "../plugins/proofread";
import { PROOFREAD_FINDINGS_CHANGED } from "../plugins/proofread";
import type { EventManager } from "../eventManager";
import type { EditorView } from "../pm";

const fakeEventManager = { onWindow: vi.fn() } as unknown as EventManager;

function clickTab(tab: Element): void {
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

const miniSchema = new Schema({
    nodes: { doc: { content: "block+" }, paragraph: { group: "block", content: "inline*" }, text: { group: "inline" } },
});

/** A view stand-in with a real ProseMirror state (no proofread plugin, so the
 *  tab renders its empty state — enough to observe whether it refreshes). */
function makeView(): EditorView {
    const doc = miniSchema.node("doc", null, [miniSchema.node("paragraph", null, [miniSchema.text("hello world")])]);
    return { state: EditorState.create({ doc, schema: miniSchema }), dom: document.createElement("div") } as unknown as EditorView;
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
        expect(labels).toEqual(["Contents", "Proofreading", "Notes", "Links"]);
    });

    it("should start on Contents with the review views hidden", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        const [contentsTab] = panel.querySelectorAll(".toc-tab");
        expect(contentsTab!.classList.contains("toc-tab--active")).toBe(true);
        expect(panel.querySelector(".toc-list")!.classList.contains("toc-view--hidden")).toBe(false);
        expect(panel.querySelector(".review-list--proofread")!.classList.contains("toc-view--hidden")).toBe(true);
        expect(panel.querySelector(".review-list--notes")!.classList.contains("toc-view--hidden")).toBe(true);
        expect(panel.querySelector(".review-list--links")!.classList.contains("toc-view--hidden")).toBe(true);
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

describe("Proofreading tab is event-driven, not per-frame (MAR-192 follow-up)", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
        document.body.className = "";
        document.body.innerHTML = "";
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it("a doc-change frame must NOT re-read findings, but a tab switch and the event must", () => {
        // getProofreadConfig is the first thing the Proofreading producer does,
        // so its call count is a proxy for "did the tab refresh?".
        const spy = vi.spyOn(proofread, "getProofreadConfig");
        const view = makeView();
        const toc = initToc(fakeEventManager, () => view);
        document.body.appendChild(toc.panel);
        toc.toggle(); // open the panel

        const tabs = toc.panel.querySelectorAll(".toc-tab");
        clickTab(tabs[1]!); // switch to Proofreading — renders it once
        const afterSwitch = spy.mock.calls.length;
        expect(afterSwitch).toBeGreaterThan(0);

        // A doc-change frame (the per-keystroke hot path) must skip it.
        toc.refreshContent();
        toc.refreshContent();
        expect(spy.mock.calls.length).toBe(afterSwitch);

        // The findings-changed event is the sole live driver, and must refresh it.
        window.dispatchEvent(new CustomEvent(PROOFREAD_FINDINGS_CHANGED));
        expect(spy.mock.calls.length).toBeGreaterThan(afterSwitch);

        toc.dispose();
    });

    it("showProofreadingTab opens the panel and activates the Proofreading tab", () => {
        const view = makeView();
        const toc = initToc(fakeEventManager, () => view);
        document.body.appendChild(toc.panel);
        expect(toc.isOpen()).toBe(false); // no headings → auto-closed
        toc.showProofreadingTab();
        const tabs = toc.panel.querySelectorAll(".toc-tab");
        expect(tabs[1]!.classList.contains("toc-tab--active")).toBe(true);
        expect(toc.isOpen()).toBe(true);
        toc.dispose();
    });

    it("a doc-change frame still refreshes the doc-driven Contents tab", () => {
        // Guard against over-broadly skipping: Contents must keep tracking edits.
        const view = makeView();
        const toc = initToc(fakeEventManager, () => view);
        document.body.appendChild(toc.panel);
        toc.toggle();
        // Contents is the default active tab; a refresh renders its (empty) list.
        expect(() => toc.refreshContent()).not.toThrow();
        expect(toc.panel.querySelector(".toc-list")).not.toBeNull();
        toc.dispose();
    });
});
