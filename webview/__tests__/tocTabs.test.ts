/**
 * Review sidebar shell (MAR-188): the ToC panel carries its tabs (Contents /
 * Links / Backlinks / Graph / Notes / Proofreading), and switching a tab swaps which view is shown
 * while keeping the others hidden (so an inactive tab does no layout/scan work).
 * Review tabs exist only while they have entries, decided on IDLE (never on the
 * doc-open or keystroke path).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorState } from "../pm";
import { Schema } from "../pm";
import { initToc } from "../components/toc";
import { mockVscodeApi } from "./setup";
import * as proofread from "../plugins/proofread";
import { PROOFREAD_FINDINGS_CHANGED } from "../plugins/proofread";
import type { EventManager } from "../eventManager";
import type { EditorView, Node as PmNode } from "../pm";
import { receiveFolderIndex, resetFolderIndexForTests } from "../links/folderIndex";
import type { FolderIndex } from "../../shared/folderIndex";

const fakeEventManager = { onWindow: vi.fn(() => () => {}) } as unknown as EventManager;

function clickTab(tab: Element): void {
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

// Tab order is Contents, Links, Backlinks, Graph, Notes, Proofreading.
const TAB = { contents: 0, links: 1, backlinks: 2, graph: 3, notes: 4, proofreading: 5 } as const;

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

    it("should render six tabs in the order Contents, Links, Backlinks, Graph, Notes, Proofreading", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        const labels = [...panel.querySelectorAll(".toc-tab")].map((t) => t.textContent);
        expect(labels).toEqual(["Contents", "Links", "Backlinks", "Graph", "Notes", "Proofread"]);
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

    it("the flip/hide controls stay in the tab strip (reveal-tab continuity)", () => {
        const { panel } = initToc(fakeEventManager, () => null);
        expect(panel.querySelector(".toc-tabs .toc-controls")).not.toBeNull();
        expect(panel.querySelector(".toc-tabs .toc-hide-btn")).not.toBeNull();
        // The overflow select exists but stays collapsed-off in jsdom (no
        // layout → the row never measures as wrapped → list mode).
        expect(panel.querySelector(".toc-tabs-select")).not.toBeNull();
        expect(panel.querySelector(".toc-tabs")!.classList.contains("toc-tabs--select")).toBe(false);
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

    it("a panel with only Contents should draw no row of tabs, and keep the strip for its controls", () => {
        const view = makeView();
        const toc = initToc(fakeEventManager, () => view);
        document.body.appendChild(toc.panel);
        toc.toggle();
        expect(toc.panel.querySelector<HTMLElement>(".toc-tabs__list")!.hidden).toBe(true);
        // This surface keeps flip and hide in the strip, so the strip stays.
        expect(toc.panel.querySelector<HTMLElement>(".toc-tabs")!.hidden).toBe(false);
        expect(toc.panel.querySelector(".toc-tabs .toc-controls")).not.toBeNull();
        toc.dispose();
    });

    it("a second tab should bring the row of tabs back", () => {
        const view = makeView(docWithLink());
        const toc = initToc(fakeEventManager, () => view);
        document.body.appendChild(toc.panel);
        toc.toggle();
        expect(toc.panel.querySelector<HTMLElement>(".toc-tabs__list")!.hidden).toBe(false);
        expect(toc.panel.querySelector<HTMLElement>(".toc-tabs")!.hidden).toBe(false);
        toc.dispose();
    });

    it("on a surface that withdrew the panel's controls, a lone Contents tab should take the whole strip with it", () => {
        (window as unknown as { __i18n: unknown }).__i18n = {
            host: { capabilities: ["toc"], arrangements: ["fixedTocSide", "tocToggleInBar"], shortcuts: [] },
        };
        try {
            const view = makeView();
            const toc = initToc(fakeEventManager, () => view);
            document.body.appendChild(toc.panel);
            toc.toggle();
            expect(toc.panel.classList.contains("toc-panel--bare-tabs")).toBe(true);
            expect(toc.panel.querySelector<HTMLElement>(".toc-tabs")!.hidden).toBe(true);
            toc.dispose();

            const linked = makeView(docWithLink());
            const second = initToc(fakeEventManager, () => linked);
            document.body.appendChild(second.panel);
            second.toggle();
            expect(second.panel.querySelector<HTMLElement>(".toc-tabs")!.hidden).toBe(false);
            second.dispose();
        } finally {
            delete (window as unknown as { __i18n?: unknown }).__i18n;
        }
    });

    it("a document with no headings should leave the outline empty rather than say so", () => {
        const view = makeView();
        const toc = initToc(fakeEventManager, () => view);
        document.body.appendChild(toc.panel);
        toc.toggle();
        const list = toc.panel.querySelector(".toc-list")!;
        expect(list.children).toHaveLength(0);
        expect(list.textContent).toBe("");
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

describe("Backlinks tab: the host's folder index, asked for only when the sidebar is seen", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stubTimers();
        resetFolderIndexForTests();
        // The setting is off by default (MAR-487); these tests are about what
        // happens with it on. No `host` key: absent means the VS Code profile.
        (window as { __i18n?: unknown }).__i18n = { folderGraph: true };
        document.body.className = "";
        document.body.innerHTML = "";
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        delete (window as { __i18n?: unknown }).__i18n;
    });

    const requests = (): number => mockVscodeApi.postMessage.mock.calls
        .filter(([m]) => (m as { type?: string }).type === "requestFolderIndex").length;

    const node = (path: string, name: string) =>
        ({ path, name, type: null, tags: [], status: null, trust: null, staleAfter: null });

    /** notes/self.md is named by a.md (on line 3) and sub/b.md; c.md names a.md. */
    const INDEX: FolderIndex = {
        rootName: "vault",
        truncated: false,
        nodes: [node("notes/self.md", "Self"), node("a.md", "Alpha note"), node("sub/b.md", "b"), node("c.md", "c")],
        edges: [
            { from: "a.md", to: "notes/self.md", target: "notes/self.md", kind: "link", text: "see self", line: 3 },
            { from: "sub/b.md", to: "notes/self.md", target: "Self", kind: "wiki", text: "Self", line: 1 },
            { from: "c.md", to: "a.md", target: "a.md", kind: "link", text: "alpha", line: 1 },
        ],
    };

    function mountToc() {
        const view = makeView();
        const toc = initToc(fakeEventManager, () => view);
        document.body.appendChild(toc.panel);
        return toc;
    }
    const tabsOf = (toc: { panel: HTMLElement }) => [...toc.panel.querySelectorAll<HTMLButtonElement>(".toc-tab")];
    const rowLabels = (toc: { panel: HTMLElement }) =>
        [...toc.panel.querySelectorAll(".review-list--backlinks .review-item__label")].map((e) => e.textContent);

    it("a sidebar nobody opens should never ask the host for the index", () => {
        const toc = mountToc();
        expect(requests()).toBe(0);
        toc.dispose();
    });

    it("opening the sidebar should ask once, however many visibility passes follow", () => {
        const toc = mountToc();
        toc.toggle();
        toc.refreshContent();
        toc.refreshContent();
        expect(requests()).toBe(1);
        toc.dispose();
    });

    it("a host that does not declare the capability should never be asked", () => {
        (window as { __i18n?: unknown }).__i18n = {
            translations: {}, isMac: true, folderGraph: true, host: { capabilities: ["toc"], arrangements: [], shortcuts: {} },
        };
        const toc = mountToc();
        toc.toggle();
        expect(requests()).toBe(0);
        expect(tabsOf(toc)[TAB.backlinks]!.hidden).toBe(true);
        toc.dispose();
    });

    it("with the setting off, a host that declares the capability should still never be asked, and both tabs stay hidden", () => {
        (window as { __i18n?: unknown }).__i18n = { translations: {} };
        const toc = mountToc();
        toc.toggle();
        toc.refreshContent();
        expect(requests()).toBe(0);
        expect(tabsOf(toc)[TAB.backlinks]!.hidden).toBe(true);
        expect(tabsOf(toc)[TAB.graph]!.hidden).toBe(true);
        toc.dispose();
    });

    it("the tab should appear when an index arrives holding backlinks, and not before", () => {
        const toc = mountToc();
        toc.toggle();
        expect(tabsOf(toc)[TAB.backlinks]!.hidden).toBe(true);
        receiveFolderIndex(INDEX, "notes/self.md");
        expect(tabsOf(toc)[TAB.backlinks]!.hidden).toBe(false);
        toc.dispose();
    });

    it("an index with nothing pointing at this document should keep the tab hidden", () => {
        const toc = mountToc();
        toc.toggle();
        receiveFolderIndex(INDEX, "c.md");
        expect(tabsOf(toc)[TAB.backlinks]!.hidden).toBe(true);
        toc.dispose();
    });

    it("the rows should name the linking notes, and a row should open its note at the reference's line", () => {
        const toc = mountToc();
        toc.toggle();
        receiveFolderIndex(INDEX, "notes/self.md");
        clickTab(tabsOf(toc)[TAB.backlinks]!);
        expect(rowLabels(toc)).toEqual(["Alpha note", "b"]);
        mockVscodeApi.postMessage.mockClear();
        toc.panel.querySelector<HTMLElement>(".review-list--backlinks .review-item__main")!.click();
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "openFile", path: "../a.md#3" });
        toc.dispose();
    });

    it("a new index should redraw the shown tab", () => {
        const toc = mountToc();
        toc.toggle();
        receiveFolderIndex(INDEX, "notes/self.md");
        clickTab(tabsOf(toc)[TAB.backlinks]!);
        receiveFolderIndex({ ...INDEX, edges: INDEX.edges.slice(1) }, "notes/self.md");
        expect(rowLabels(toc)).toEqual(["b"]);
        toc.dispose();
    });

    it("an empty result from a walk that stopped at its cap should say the absence may be a cut", () => {
        const toc = mountToc();
        toc.toggle();
        receiveFolderIndex(INDEX, "notes/self.md");
        clickTab(tabsOf(toc)[TAB.backlinks]!);
        receiveFolderIndex({ ...INDEX, edges: [], truncated: true }, "notes/self.md");
        expect(toc.panel.querySelector(".review-list--backlinks")!.textContent).toContain("index reached");
        toc.dispose();
    });

    // ── The Graph tab (MAR-481): the same index, drawn ──────────────────────

    /** The graph renders out of a lazy chunk; wait for its first drawing. */
    async function graphDrawn(toc: { panel: HTMLElement }): Promise<HTMLElement> {
        for (let i = 0; i < 50; i++) {
            const stage = toc.panel.querySelector<HTMLElement>(".review-list--graph .lg-stage");
            if (stage && stage.querySelector(".lg-node")) { return stage; }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("the graph never drew a node");
    }
    const nodeIds = (stage: HTMLElement) => [...stage.querySelectorAll<HTMLElement>(".lg-node")].map((n) => n.dataset["id"]);

    it("the Graph tab should appear for a note with references either way, and not for one with none", () => {
        const toc = mountToc();
        toc.toggle();
        receiveFolderIndex(INDEX, "c.md");
        expect(tabsOf(toc)[TAB.graph]!.hidden).toBe(false); // c.md names a.md: outbound only
        receiveFolderIndex({ ...INDEX, nodes: [...INDEX.nodes, node("lonely.md", "Lonely")] }, "lonely.md");
        expect(tabsOf(toc)[TAB.graph]!.hidden).toBe(true);
        toc.dispose();
    });

    it("a note whose only reference is dangling should still show the Graph tab", () => {
        const toc = mountToc();
        toc.toggle();
        receiveFolderIndex({
            ...INDEX,
            edges: [{ from: "c.md", to: null, target: "Nowhere", kind: "wiki", text: "Nowhere", line: 2 }],
        }, "c.md");
        expect(tabsOf(toc)[TAB.graph]!.hidden).toBe(false);
        toc.dispose();
    });

    it("showing the Graph tab should draw this note, its neighbours, and a line per reference", async () => {
        const toc = mountToc();
        toc.toggle();
        receiveFolderIndex(INDEX, "notes/self.md");
        clickTab(tabsOf(toc)[TAB.graph]!);
        const stage = await graphDrawn(toc);
        expect(nodeIds(stage).sort()).toEqual(["a.md", "notes/self.md", "sub/b.md"]);
        expect(stage.querySelectorAll(".lg-line")).toHaveLength(2);
        expect(stage.querySelector(".lg-node--self")!.getAttribute("data-id")).toBe("notes/self.md");
        toc.dispose();
    });

    it("clicking a neighbour should open it relative to this note, and this note should open nothing", async () => {
        const toc = mountToc();
        toc.toggle();
        receiveFolderIndex(INDEX, "notes/self.md");
        clickTab(tabsOf(toc)[TAB.graph]!);
        const stage = await graphDrawn(toc);
        mockVscodeApi.postMessage.mockClear();
        stage.querySelector<HTMLElement>('.lg-node[data-id="notes/self.md"]')!.click();
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalled();
        stage.querySelector<HTMLElement>('.lg-node[data-id="sub/b.md"]')!.click();
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "openFile", path: "../sub/b.md" });
        toc.dispose();
    });

    it("Two steps should reach the neighbours' neighbours, and a new index should redraw", async () => {
        const toc = mountToc();
        toc.toggle();
        receiveFolderIndex(INDEX, "a.md"); // a.md -> self; c.md -> a.md; b.md -> self
        clickTab(tabsOf(toc)[TAB.graph]!);
        const stage = await graphDrawn(toc);
        expect(nodeIds(stage).sort()).toEqual(["a.md", "c.md", "notes/self.md"]);
        toc.panel.querySelector<HTMLElement>('.review-list--graph .review-seg[data-depth="2"]')!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(nodeIds(stage).sort()).toEqual(["a.md", "c.md", "notes/self.md", "sub/b.md"]);
        receiveFolderIndex({ ...INDEX, edges: INDEX.edges.filter((e) => e.from !== "c.md") }, "a.md");
        expect(nodeIds(stage)).not.toContain("c.md");
        toc.dispose();
    });
});
