/**
 * Keyboard focus IN and OUT of the review sidebar.
 *
 * MAR-294: the panel's internal keyboard model was complete (MAR-291) but
 * unreachable — no gesture moved focus from the editor into the panel. The
 * `Focus Review Sidebar` command lands on `focusPanel()`, which must open the
 * panel when hidden and put focus on the active view's first row, falling back
 * to the tab strip's own Tab stop when the view is empty. jsdom can verify all
 * of that (focus order, roving tabindex, message posts); what it cannot see —
 * which listener wins on a real keypress — is covered by e2e/reviewSidebar.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initToc } from "../components/toc";
import type { EventManager } from "../eventManager";
import { mockVscodeApi } from "./setup";
import { Schema, EditorState } from "../pm";
import type { EditorView, Node as PmNode } from "../pm";

const fakeEventManager = { onWindow: vi.fn() } as unknown as EventManager;

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

/** A view stand-in: a real ProseMirror state (so the outline walk works) plus
 *  a focusable dom and a focus() that targets it, like the real EditorView. */
function makeView(doc: PmNode): EditorView {
    const dom = document.createElement("div");
    dom.tabIndex = 0;
    document.body.appendChild(dom);
    const view = {
        state: EditorState.create({ doc, schema }),
        dom,
        focus: () => dom.focus(),
    };
    return view as unknown as EditorView;
}

function docWithHeadings(count: number): PmNode {
    return schema.node("doc", null, [
        ...Array.from({ length: count }, (_, i) =>
            schema.node("heading", { level: 1 }, [schema.text(`Heading ${i + 1}`)])),
        schema.node("paragraph", null, [schema.text("body")]),
    ]);
}

function stubTimers(): void {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => { cb(); return 1; });
    vi.stubGlobal("cancelIdleCallback", () => {});
}

describe("focusPanel — the deliberate keyboard entry (MAR-294)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stubTimers();
        document.body.className = "";
        document.body.innerHTML = "";
        // Wide enough to dock: tocWidth 260 + DOCKED_MIN_CONTENT_WIDTH 720.
        Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    });

    afterEach(() => { vi.unstubAllGlobals(); });

    it("an open panel should move focus to the outline's first row", () => {
        const view = makeView(docWithHeadings(5)); // > auto-open threshold (3)
        const toc = initToc(fakeEventManager, () => view);
        document.body.appendChild(toc.panel);
        toc.refresh(); // render the outline (auto-open: 5 headings)
        expect(toc.isOpen()).toBe(true);

        toc.focusPanel();

        const active = document.activeElement as HTMLElement;
        expect(active.classList.contains("toc-item")).toBe(true);
        expect(active.textContent).toBe("Heading 1");
        // The roving slot travelled with focus: exactly one tabbable row.
        const tabbable = toc.panel.querySelectorAll(".toc-item[tabindex='0']");
        expect(tabbable).toHaveLength(1);
    });

    it("a hidden panel should open, persist the choice, and then take focus", () => {
        const view = makeView(docWithHeadings(5));
        const toc = initToc(fakeEventManager, () => view);
        document.body.appendChild(toc.panel);
        toc.refresh();
        toc.toggle(); // user hides it
        expect(toc.isOpen()).toBe(false);
        mockVscodeApi.postMessage.mockClear();

        toc.focusPanel();

        expect(toc.isOpen()).toBe(true);
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "tocVisibility",
            visibility: "shown",
        });
        expect(toc.panel.contains(document.activeElement)).toBe(true);
    });

    it("an empty active view should fall back to the tab strip's Tab stop, never a dead end", () => {
        const view = makeView(schema.node("doc", null, [
            schema.node("paragraph", null, [schema.text("no headings here")]),
        ]));
        const toc = initToc(fakeEventManager, () => view);
        document.body.appendChild(toc.panel);
        toc.refresh();

        toc.focusPanel();

        // No outline rows to land on — the strip's active tab carries focus.
        const active = document.activeElement as HTMLElement;
        expect(toc.panel.contains(active)).toBe(true);
        expect(active.classList.contains("toc-tab")).toBe(true);
        expect(active.textContent).toBe("Contents");
    });

    it("showProofreadingTab should move focus into the panel as its side effect", () => {
        const view = makeView(docWithHeadings(5));
        const toc = initToc(fakeEventManager, () => view);
        document.body.appendChild(toc.panel);
        toc.refresh();

        toc.showProofreadingTab();

        // No proofread plugin in this harness → the tab shows its empty state,
        // so focus falls back to the strip — inside the panel either way.
        expect(toc.panel.contains(document.activeElement)).toBe(true);
    });
});

/** Press a key on whatever currently has focus, as the roving handler sees it. */
function press(key: string): void {
    document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
}

describe("flip/hide controls — their own roving group (MAR-295)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stubTimers();
        document.body.className = "";
        document.body.innerHTML = "";
        Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    });

    afterEach(() => { vi.unstubAllGlobals(); });

    function openPanel() {
        const view = makeView(docWithHeadings(5));
        const toc = initToc(fakeEventManager, () => view);
        document.body.appendChild(toc.panel);
        toc.refresh();
        expect(toc.isOpen()).toBe(true);
        return { toc, view };
    }
    const controls = () => document.querySelector<HTMLElement>(".toc-controls")!;
    const flip = () => document.querySelector<HTMLElement>(".toc-flip-btn")!;
    const hide = () => document.querySelector<HTMLElement>(".toc-hide-btn")!;

    it("the pair should be one horizontal group with exactly one Tab stop", () => {
        openPanel();
        expect(controls().getAttribute("role")).toBe("toolbar");
        const tabbable = [...controls().querySelectorAll<HTMLElement>("button")]
            .filter((b) => b.tabIndex === 0);
        expect(tabbable).toHaveLength(1);
        expect(tabbable[0]).toBe(flip());
    });

    it("ArrowRight/ArrowLeft should walk flip ↔ hide and clamp at both ends", () => {
        openPanel();
        flip().focus();
        press("ArrowRight");
        expect(document.activeElement).toBe(hide());
        press("ArrowRight"); // clamps
        expect(document.activeElement).toBe(hide());
        press("ArrowLeft");
        expect(document.activeElement).toBe(flip());
        press("ArrowLeft"); // clamps
        expect(document.activeElement).toBe(flip());
    });

    it("Escape from the controls should return focus to the editor", () => {
        const { view } = openPanel();
        flip().focus();
        press("Escape");
        expect(document.activeElement).toBe(view.dom);
    });
});

describe("focus restore — the panel stops being focusable (MAR-295)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stubTimers();
        document.body.className = "";
        document.body.innerHTML = "";
        Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    });

    afterEach(() => { vi.unstubAllGlobals(); });

    function openPanel() {
        const view = makeView(docWithHeadings(5));
        const toc = initToc(fakeEventManager, () => view);
        document.body.appendChild(toc.panel);
        toc.refresh();
        expect(toc.isOpen()).toBe(true);
        return { toc, view };
    }

    it("activating the hide button with the keyboard should land focus in the editor, not <body>", () => {
        const { toc, view } = openPanel();
        const hide = document.querySelector<HTMLElement>(".toc-hide-btn")!;
        hide.focus();
        expect(toc.panel.contains(document.activeElement)).toBe(true);
        // bindActivate runs on mousedown / keyboard-synthesized click.
        hide.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(toc.isOpen()).toBe(false);
        expect(document.activeElement).toBe(view.dom);
    });

    it("a responsive docked→overlay collapse with focus inside should also restore the editor", () => {
        const { toc, view } = openPanel();
        toc.focusPanel();
        expect(toc.panel.contains(document.activeElement)).toBe(true);
        // Shrink below tocWidth (260) + DOCKED_MIN_CONTENT_WIDTH (720): the
        // resize listener flips to overlay and closes the panel.
        Object.defineProperty(window, "innerWidth", { value: 700, configurable: true });
        const resize = (fakeEventManager.onWindow as ReturnType<typeof vi.fn>).mock.calls
            .find((c) => c[0] === "resize")?.[1] as () => void;
        resize();
        expect(toc.isOpen()).toBe(false);
        expect(document.activeElement).toBe(view.dom);
    });

    it("closing the panel with focus elsewhere should leave that focus alone", () => {
        const { toc } = openPanel();
        const outside = document.createElement("button");
        document.body.appendChild(outside);
        outside.focus();
        toc.toggle(); // hide
        expect(toc.isOpen()).toBe(false);
        expect(document.activeElement).toBe(outside);
    });
});
