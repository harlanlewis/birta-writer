/**
 * The outline with nothing to show: no headings and no review tab with
 * entries. It is not drawn, it cannot be opened by any route, its commands
 * are withdrawn from every surface that offers them, and the Contents tab is
 * offered only while there is an outline in it. The decision is the outline's
 * (components/toc), the holding-shut is the shell's (`setEmpty`), and the
 * withdrawal is the shared predicate's (`commandAvailable`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorState, Schema } from "../pm";
import type { EditorView, Node as PmNode } from "../pm";
import { initToc, TOC_COMMANDS } from "../components/toc";
import { commandAvailable } from "../../shared/commandAvailability";
import { mockVscodeApi } from "./setup";
import type { EventManager } from "../eventManager";

const fakeEventManager = { onWindow: vi.fn(() => () => {}) } as unknown as EventManager;

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } } },
        text: { group: "inline" },
    },
    marks: { link: { attrs: { href: { default: "" } } } },
});

const para = (text: string): PmNode => schema.node("paragraph", null, [schema.text(text)]);
const heading = (text: string): PmNode => schema.node("heading", { level: 1 }, [schema.text(text)]);
const linked = (): PmNode => schema.node("paragraph", null, [
    schema.text("see "),
    schema.text("home", [schema.mark("link", { href: "https://example.com" })]),
]);

/** A view stand-in over a real state, whose document a test can replace. */
function makeView(...blocks: PmNode[]): EditorView & { setDoc: (...b: PmNode[]) => void } {
    const view = {
        state: EditorState.create({ doc: schema.node("doc", null, blocks), schema }),
        dom: document.createElement("div"),
        setDoc(...next: PmNode[]) { view.state = EditorState.create({ doc: schema.node("doc", null, next), schema }); },
    };
    return view as unknown as EditorView & { setDoc: (...b: PmNode[]) => void };
}

const tab = (label: string): HTMLButtonElement =>
    [...document.querySelectorAll<HTMLButtonElement>(".toc-tab")].find((b) => b.textContent === label)!;
const posted = (type: string) => mockVscodeApi.postMessage.mock.calls.filter((c) => (c[0] as { type: string }).type === type);

describe("an outline with nothing to show", () => {
    let dispose: (() => void) | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
        // The availability pass runs on idle; synchronously here.
        vi.stubGlobal("requestIdleCallback", (cb: () => void) => { cb(); return 1; });
        vi.stubGlobal("cancelIdleCallback", () => {});
        Object.defineProperty(window, "innerWidth", { value: 1400, configurable: true });
        document.body.className = "";
        document.body.innerHTML = "";
        (globalThis as { __i18n?: unknown }).__i18n = { translations: {} };
    });

    afterEach(() => {
        dispose?.();
        dispose = null;
        vi.unstubAllGlobals();
        delete (globalThis as { __i18n?: unknown }).__i18n;
    });

    function mount(view: EditorView, onEmptyChange?: (empty: boolean) => void) {
        const toc = initToc(fakeEventManager, () => view, { onEmptyChange });
        document.body.appendChild(toc.panel);
        dispose = toc.dispose;
        toc.refresh();
        // The reader's remembered "shown", as the settings echo delivers it:
        // the seed in __i18n is read once, when the module loads.
        toc.applyVisibility("shown");
        return toc;
    }

    it("a document with no headings and nothing to review should stay shut, even remembered as shown", () => {
        const toc = mount(makeView(para("just prose")));
        expect(toc.isEmpty()).toBe(true);
        expect(toc.isOpen()).toBe(false);
        expect(document.body.classList.contains("toc-open")).toBe(false);
        // The reveal tab goes too: a control for a panel of nothing.
        expect(document.querySelector<HTMLElement>(".toc-toggle-tab")!.hidden).toBe(true);
    });

    it("its commands should be withdrawn from every surface, and toggling should record nothing", () => {
        const toc = mount(makeView(para("just prose")));
        for (const id of TOC_COMMANDS) { expect(commandAvailable(id), id).toBe(false); }
        toc.toggle();
        expect(toc.isOpen()).toBe(false);
        // A "shown" written now would open the panel the moment content arrived.
        expect(posted("tocVisibility")).toEqual([]);
    });

    it("a heading should make it something at once, honouring the remembered show", () => {
        const empties: boolean[] = [];
        const toc = mount(makeView(heading("Intro"), para("text")), (e) => empties.push(e));
        expect(toc.isEmpty()).toBe(false);
        expect(toc.isOpen()).toBe(true);
        expect(document.querySelector<HTMLElement>(".toc-toggle-tab")!.hidden).toBe(false);
        expect(commandAvailable("toggleToc")).toBe(true);
        expect(empties).toEqual([false]);
    });

    it("deleting the last heading should shut it, and adding one back should reopen it", () => {
        const empties: boolean[] = [];
        const view = makeView(heading("Intro"), para("text"));
        const toc = mount(view, (e) => empties.push(e));
        view.setDoc(para("text"));
        toc.refreshContent();
        expect(toc.isEmpty()).toBe(true);
        expect(toc.isOpen()).toBe(false);
        view.setDoc(heading("Back"), para("text"));
        toc.refreshContent();
        expect(toc.isOpen()).toBe(true);
        expect(empties).toEqual([false, true, false]);
    });

    it("review content with no headings should be something, opening on its own tab with no Contents tab beside it", () => {
        const toc = mount(makeView(linked()));
        expect(toc.isEmpty()).toBe(false);
        expect(toc.isOpen()).toBe(true);
        expect(tab("Contents").hidden).toBe(true);
        expect(tab("Links").hidden).toBe(false);
        expect(tab("Links").getAttribute("aria-selected")).toBe("true");
    });

    it("a Contents tab should come back with the first heading", () => {
        const view = makeView(linked());
        const toc = mount(view);
        view.setDoc(heading("Intro"), linked());
        toc.refreshContent();
        // The tab strip is re-derived on the next pass while open.
        toc.refresh();
        expect(tab("Contents").hidden).toBe(false);
    });

    it("disposing should leave no command withdrawn", () => {
        mount(makeView(para("just prose")));
        expect(commandAvailable("toggleToc")).toBe(false);
        dispose!();
        dispose = null;
        for (const id of TOC_COMMANDS) { expect(commandAvailable(id), id).toBe(true); }
    });
});
