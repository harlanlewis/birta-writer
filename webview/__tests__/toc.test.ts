/**
 * toc component tests: dock side is driven by the toc-right body class
 * (set by the extension from the birta.tocPosition setting).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initToc } from "../components/toc";
import type { EventManager } from "../eventManager";
import { mockVscodeApi } from "./setup";
import { Schema, EditorState } from "../pm";
import type { EditorView } from "../pm";

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

describe("TOC docked vs overlay responsive mode", () => {
    // The default width is 220 (jsdom can't resolve the injected --toc-width
    // custom property, so readInitialWidth falls back to the 220 default), and
    // DOCKED_MIN_CONTENT_WIDTH is 720 — so the docked threshold is 940px.
    const originalInnerWidth = window.innerWidth;

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
        (window as unknown as { innerWidth: number }).innerWidth = originalInnerWidth;
    });

    it("a viewport wide enough for the drawer plus content should dock (fixed-width mode)", () => {
        // Fixed-width mode = no editor-width-auto body class. This is a pure
        // viewport measure now, so it holds even with no #editor to measure —
        // the previous rect-based check returned overlay whenever the editor
        // wasn't laid out (or wasn't yet clear of the drawer).
        (window as unknown as { innerWidth: number }).innerWidth = 1200;
        initToc(fakeEventManager, () => null);
        expect(document.body.classList.contains("toc-docked")).toBe(true);
        expect(document.body.classList.contains("toc-overlay")).toBe(false);
    });

    it("a viewport too narrow for the drawer plus content should fall back to overlay", () => {
        (window as unknown as { innerWidth: number }).innerWidth = 800;
        initToc(fakeEventManager, () => null);
        expect(document.body.classList.contains("toc-overlay")).toBe(true);
        expect(document.body.classList.contains("toc-docked")).toBe(false);
    });

    it("the docked/overlay decision is independent of the editor's measured position", () => {
        // A zero-size stub editor (jsdom reports all-zero rects) must not force
        // overlay when the viewport clearly has room — the regression the rect
        // based check caused once fixed-width content recenters beside the drawer.
        const editor = document.createElement("div");
        editor.id = "editor";
        document.body.appendChild(editor);
        (window as unknown as { innerWidth: number }).innerWidth = 1200;
        initToc(fakeEventManager, () => null);
        expect(document.body.classList.contains("toc-docked")).toBe(true);
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

    it("opening the flyout should clear the docked inline height so the card auto-sizes to its headings", () => {
        addTopbar({ height: 40, bottom: 40 });
        const { panel } = initToc(fakeEventManager, () => null);
        // The docked drawer carries a full-height inline style…
        expect(panel.style.height).toBe("calc(100vh - 40px)");
        const tab = document.querySelector(".toc-toggle-tab") as HTMLElement;
        tab.dispatchEvent(new MouseEvent("mouseenter"));
        // …which the flyout must drop so CSS (height:auto capped by max-height)
        // governs — otherwise a short heading list leaves an empty footer.
        expect(panel.classList.contains("toc-panel--flyout")).toBe(true);
        expect(panel.style.height).toBe("");
    });

    it("docking open from the flyout should restore the drawer's full inline height", () => {
        addTopbar({ height: 40, bottom: 40 });
        const { panel } = initToc(fakeEventManager, () => null);
        const tab = document.querySelector(".toc-toggle-tab") as HTMLElement;
        tab.dispatchEvent(new MouseEvent("mouseenter"));
        expect(panel.style.height).toBe("");
        // A tab click tears down the flyout and docks the panel open, which must
        // reassert the full-height inline style the flyout cleared.
        tab.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
        expect(panel.classList.contains("toc-panel--flyout")).toBe(false);
        expect(panel.style.height).toBe("calc(100vh - 40px)");
    });
});

describe("TOC show/hide persistence (birta.tocVisibility)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
            cb(0);
            return 0;
        });
        document.body.className = "";
        document.body.innerHTML = "";
        // Docked mode needs the viewport to hold the drawer plus a content column
        // (tocWidth 220 + DOCKED_MIN_CONTENT_WIDTH 720 = 940).
        Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete (window as unknown as { __i18n?: unknown }).__i18n;
    });

    it("toggling the panel should report the show/hide choice to the extension (which persists the setting)", () => {
        const { toggle } = initToc(fakeEventManager, () => null);
        mockVscodeApi.postMessage.mockClear();
        // From the initial (closed, no headings) state, a toggle opens it.
        toggle();
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "tocVisibility",
            visibility: "shown",
        });
        toggle();
        expect(mockVscodeApi.postMessage).toHaveBeenLastCalledWith({
            type: "tocVisibility",
            visibility: "hidden",
        });
    });

    it("tocVisibility 'shown' should open a docked panel even with no headings (overriding auto-open)", async () => {
        // The module reads window.__i18n at import time, so set it then re-import.
        vi.resetModules();
        (window as unknown as { __i18n?: unknown }).__i18n = { tocVisibility: "shown" };
        const { initToc: freshInitToc } = await import("../components/toc");
        const { panel } = freshInitToc(fakeEventManager, () => null);
        // Auto-open needs headings > threshold; with none it would stay closed.
        // The explicit setting forces it open, proving the seed overrides.
        expect(panel.classList.contains("toc-panel--open")).toBe(true);
    });

    it("tocVisibility 'hidden' should keep a docked panel closed", async () => {
        vi.resetModules();
        (window as unknown as { __i18n?: unknown }).__i18n = { tocVisibility: "hidden" };
        const { initToc: freshInitToc } = await import("../components/toc");
        const { panel } = freshInitToc(fakeEventManager, () => null);
        expect(panel.classList.contains("toc-panel--open")).toBe(false);
    });

    it("an echoed tocVisibility change should update the panel without re-persisting", () => {
        const { panel, applyVisibility, isOpen } = initToc(fakeEventManager, () => null);
        // A fresh docked panel with no headings starts closed.
        expect(isOpen()).toBe(false);
        mockVscodeApi.postMessage.mockClear();
        // Another editor toggled the ToC on; the config-change echo lands here.
        applyVisibility("shown");
        expect(panel.classList.contains("toc-panel--open")).toBe(true);
        expect(isOpen()).toBe(true);
        // An echo must NOT re-report a tocVisibility message (no write loop).
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "tocVisibility" }),
        );
    });

    it("an echoed 'auto' should return the panel to the heading-count heuristic", () => {
        const { panel, applyVisibility } = initToc(fakeEventManager, () => null);
        applyVisibility("shown");
        expect(panel.classList.contains("toc-panel--open")).toBe(true);
        // Back to auto: with no headings the heuristic keeps it closed.
        applyVisibility("auto");
        expect(panel.classList.contains("toc-panel--open")).toBe(false);
    });

    it("an echoed width change should re-evaluate docked/overlay mode", () => {
        // 1000 ≥ 220 (default width) + 720 → docked; 1000 < 400 + 720 → overlay.
        Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
        const { setWidth } = initToc(fakeEventManager, () => null);
        expect(document.body.classList.contains("toc-docked")).toBe(true);
        setWidth(400);
        expect(document.body.classList.contains("toc-overlay")).toBe(true);
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

describe("outline refresh cost (observed-diff fast path)", () => {
    // The outline walk is O(document blocks) and refreshContent runs once per
    // doc-changing frame, so ordinary body-text typing must NOT pay it: the
    // cached outline is reused with positions shifted by the diff delta. The
    // user-observable stake is each row's data-headingPos — the click-nav and
    // drag anchor — which must track the document exactly; the cost stake is
    // counted directly (nodesBetween is the walk's only doc traversal).
    const schema = new Schema({
        nodes: {
            doc: { content: "block+" },
            paragraph: { group: "block", content: "inline*" },
            heading: {
                group: "block",
                content: "inline*",
                attrs: { level: { default: 1 } },
            },
            text: { group: "inline" },
        },
    });

    const p = (text: string) => schema.node("paragraph", null, text ? [schema.text(text)] : []);
    const h = (level: number, text: string) => schema.node("heading", { level }, [schema.text(text)]);

    function makeView(doc: ReturnType<typeof schema.node>): EditorView & { state: EditorState } {
        // `dom` satisfies the init-time active-heading scan (findActiveHeading
        // queries it); empty is fine — active-state tracking isn't under test.
        return {
            state: EditorState.create({ doc, schema }),
            dom: document.createElement("div"),
        } as unknown as EditorView & { state: EditorState };
    }

    function rowPositions(): number[] {
        return [...document.querySelectorAll<HTMLElement>(".toc-item")].map((el) =>
            Number(el.dataset["headingPos"]),
        );
    }

    function rowTexts(): string[] {
        return [...document.querySelectorAll<HTMLElement>(".toc-item")].map((el) => el.textContent ?? "");
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

    /** Open panel over a doc: intro para, "Alpha" h1, body para, "Beta" h2, tail para. */
    function setup() {
        const doc = schema.node("doc", null, [p("intro"), h(1, "Alpha"), p("body"), h(2, "Beta"), p("tail")]);
        const view = makeView(doc);
        const toc = initToc(fakeEventManager, () => view);
        document.body.appendChild(toc.panel);
        toc.toggle(); // user-open: panel visible, walk runs, outline rendered
        return { view, toc };
    }

    it("typing in a body paragraph should shift later heading anchors without re-walking the document", () => {
        const { view, toc } = setup();
        const before = rowPositions();
        expect(before).toHaveLength(2);

        // Type 3 chars into the FIRST paragraph — every heading sits after it.
        const tr = view.state.tr.insertText("xyz", 2);
        view.state = view.state.apply(tr);
        const walk = vi.spyOn(view.state.doc, "nodesBetween");
        toc.refreshContent();

        expect(walk).not.toHaveBeenCalled();
        expect(rowPositions()).toEqual(before.map((pos) => pos + 3));
    });

    it("typing after the last heading should leave all anchors unchanged without a walk", () => {
        const { view, toc } = setup();
        const before = rowPositions();

        const tail = view.state.doc.content.size - 2; // inside the last paragraph
        view.state = view.state.apply(view.state.tr.insertText("x", tail));
        const walk = vi.spyOn(view.state.doc, "nodesBetween");
        toc.refreshContent();

        expect(walk).not.toHaveBeenCalled();
        expect(rowPositions()).toEqual(before);
    });

    it("typing inside a heading should re-walk and update the rendered title", () => {
        const { view, toc } = setup();
        const alphaPos = rowPositions()[0]!;

        view.state = view.state.apply(view.state.tr.insertText("!", alphaPos + 1 + "Alpha".length));
        toc.refreshContent();

        expect(rowTexts()).toEqual(["Alpha!", "Beta"]);
    });

    it("converting a paragraph to a heading should re-walk and add its row", () => {
        const { view, toc } = setup();
        const before = rowPositions();

        // "body" paragraph sits right after the Alpha heading.
        const bodyPos = before[0]! + h(1, "Alpha").nodeSize;
        view.state = view.state.apply(
            view.state.tr.setBlockType(bodyPos + 1, bodyPos + 1, schema.nodes["heading"]!, { level: 3 }),
        );
        toc.refreshContent();

        expect(rowTexts()).toEqual(["Alpha", "body", "Beta"]);
    });

    it("deleting a heading should re-walk and drop its row", () => {
        const { view, toc } = setup();
        const [alphaPos] = rowPositions();

        view.state = view.state.apply(
            view.state.tr.delete(alphaPos!, alphaPos! + h(1, "Alpha").nodeSize),
        );
        toc.refreshContent();

        expect(rowTexts()).toEqual(["Beta"]);
    });
});
