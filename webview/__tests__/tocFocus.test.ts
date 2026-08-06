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
