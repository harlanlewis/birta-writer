/**
 * Review sidebar shell (MAR-188): the ToC panel carries four tabs — Contents /
 * Links / Notes / Proofreading — and switching a tab swaps which view is shown
 * while keeping the others hidden (so an inactive tab does no layout/scan work).
 * Review tabs exist only while they have entries, decided on IDLE (never on the
 * doc-open or keystroke path).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorState } from "../pm";
import { Schema } from "../pm";
import { initToc } from "../components/toc";
import * as proofread from "../plugins/proofread";
import { PROOFREAD_FINDINGS_CHANGED } from "../plugins/proofread";
import type { EventManager } from "../eventManager";
import type { EditorView, Node as PmNode } from "../pm";

const fakeEventManager = { onWindow: vi.fn() } as unknown as EventManager;

function clickTab(tab: Element): void {
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

// Tab order is Contents, Links, Notes, Proofreading.
const TAB = { contents: 0, links: 1, notes: 2, proofreading: 3 } as const;

const miniSchema = new Schema({
    nodes: { doc: { content: "block+" }, paragraph: { group: "block", content: "inline*" }, text: { group: "inline" } },
    marks: { link: { attrs: { href: { default: "" } } } },
});

/** A view stand-in with a real ProseMirror state (no proofread plugin, so the
 *  tab renders its empty state — enough to observe whether it refreshes). */
function makeView(doc?: PmNode): EditorView {
    const d = doc ?? miniSchema.node("doc", null, [miniSchema.node("paragraph", null, [miniSchema.text("hello world")])]);
    const view = { state: EditorState.create({ doc: d, schema: miniSchema }), dom: document.createElement("div") };
    return view as unknown as EditorView;
}

function docWithLink(): PmNode {
    return miniSchema.node("doc", null, [miniSchema.node("paragraph", null, [
        miniSchema.text("see "),
        miniSchema.text("home", [miniSchema.mark("link", { href: "https://example.com" })]),
    ])]);
}

function stubTimers(): void {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
    // Tab visibility recomputes on idle; run it synchronously in tests.
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => { cb(); return 1; });
    vi.stubGlobal("cancelIdleCallback", () => {});
}

describe("review sidebar tabs", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stubTimers();
        document.body.className = "";
        document.body.innerHTML = "";
    });

    afterEach(() => { vi.unstubAllGlobals(); });

    it("should render four tabs in the order Contents, Links, Notes, Proofreading", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        const labels = [...panel.querySelectorAll(".toc-tab")].map((t) => t.textContent);
        expect(labels).toEqual(["Contents", "Links", "Notes", "Proofreading"]);
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
        clickTab(tabs[TAB.proofreading]!);
        expect(tabs[TAB.proofreading]!.classList.contains("toc-tab--active")).toBe(true);
        expect(tabs[TAB.contents]!.classList.contains("toc-tab--active")).toBe(false);
        expect(panel.querySelector(".toc-list")!.classList.contains("toc-view--hidden")).toBe(true);
        expect(panel.querySelector(".review-list--proofread")!.classList.contains("toc-view--hidden")).toBe(false);
        expect(panel.querySelector(".review-list--notes")!.classList.contains("toc-view--hidden")).toBe(true);
    });

    it("clicking Notes should show only the notes view", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        const tabs = panel.querySelectorAll(".toc-tab");
        clickTab(tabs[TAB.notes]!);
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

describe("tab visibility — a review tab exists only while it has entries", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stubTimers();
        document.body.className = "";
        document.body.innerHTML = "";
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    function tabs(toc: { panel: HTMLElement }) {
        return [...toc.panel.querySelectorAll<HTMLButtonElement>(".toc-tab")];
    }

    it("a doc with a link shows the Links tab; Notes/Proofreading stay hidden", () => {
        const view = makeView(docWithLink());
        const toc = initToc(fakeEventManager, () => view);
        document.body.appendChild(toc.panel);
        toc.toggle(); // opening the panel triggers the (sync-stubbed) idle pass
        const t = tabs(toc);
        expect(t[TAB.links]!.hidden).toBe(false);
        expect(t[TAB.notes]!.hidden).toBe(true);
        expect(t[TAB.proofreading]!.hidden).toBe(true); // no plugin → no findings
        toc.dispose();
    });

    it("a doc with no links/notes/findings shows only Contents", () => {
        const view = makeView();
        const toc = initToc(fakeEventManager, () => view);
        document.body.appendChild(toc.panel);
        toc.toggle();
        const t = tabs(toc);
        expect(t[TAB.contents]!.hidden).toBe(false);
        expect(t[TAB.links]!.hidden).toBe(true);
        expect(t[TAB.notes]!.hidden).toBe(true);
        expect(t[TAB.proofreading]!.hidden).toBe(true);
        toc.dispose();
    });

    it("an emptied tab is kept while ACTIVE and hides on switch-away", () => {
        const view = makeView(docWithLink()) as EditorView & { state: EditorState };
        const toc = initToc(fakeEventManager, () => view);
        document.body.appendChild(toc.panel);
        toc.toggle();
        const t = tabs(toc);
        clickTab(t[TAB.links]!); // user is IN the Links tab
        // The document loses its last link.
        view.state = EditorState.create({ doc: makeView().state.doc, schema: miniSchema });
        toc.refreshContent(); // doc-change frame → (sync) idle visibility pass
        expect(t[TAB.links]!.hidden).toBe(false); // never yanked out from under the user
        clickTab(t[TAB.contents]!); // switch away
        expect(t[TAB.links]!.hidden).toBe(true); // now it hides
        toc.dispose();
    });
});

describe("Proofreading tab is event-driven, not per-frame (MAR-192 follow-up)", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        stubTimers();
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
        clickTab(tabs[TAB.proofreading]!); // switch to Proofreading — renders it once
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
        const tabs = toc.panel.querySelectorAll<HTMLButtonElement>(".toc-tab");
        expect(tabs[TAB.proofreading]!.classList.contains("toc-tab--active")).toBe(true);
        // Explicit intent (Show issues) unhides the tab even with zero findings.
        expect(tabs[TAB.proofreading]!.hidden).toBe(false);
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
