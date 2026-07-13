/**
 * Tests for the TOC drag-and-drop wiring (components/toc/dnd): the panel as
 * a DropZoneProvider for document drags, top-level items as drag handles for
 * their sections, and the index.ts integration (drag-source restore across
 * rebuilds, click-vs-drag navigation, overlay-close guard). jsdom has no
 * layout, so all geometry comes from stubbed getBoundingClientRect (the
 * blockDrag.test.ts pattern); the pure slot math lives in tocDropModel.test.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import type { EditorView } from "@milkdown/prose/view";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, pureCommonmark } from "../serialization";
import { headingFoldPlugin, headingFoldPluginKey } from "../plugins/headingFold";
import { historyPlugin } from "../plugins/history";
import { contentGuardPlugin } from "../plugins/contentGuard";
import { setBlockMenuContext } from "../components/blockMenu";
import { initTocDnd, type TocDnd } from "../components/toc/dnd";
import { initToc } from "../components/toc";
import type { TocHeadingEntry } from "../components/toc/dropModel";
import type { EventManager } from "../eventManager";

let editors: Editor[] = [];
let activeEditor: Editor | null = null;
let disposers: (() => void)[] = [];

setBlockMenuContext({ getEditor: () => activeEditor });

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfm)
        .use(headingFoldPlugin)
        .use(historyPlugin)
        .use(contentGuardPlugin)
        .create();
    editors.push(editor);
    activeEditor = editor;
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function markdown(editor: Editor): string {
    return editor.action(getMarkdown()).trim();
}

const mouse = (
    target: EventTarget,
    type: string,
    opts: MouseEventInit,
) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...opts }));

/** The outline as index.ts's getHeadings would report it. */
function headingsOf(v: EditorView): TocHeadingEntry[] {
    const out: TocHeadingEntry[] = [];
    v.state.doc.nodesBetween(0, v.state.doc.content.size, (node, pos) => {
        if (node.type.name === "heading" && node.textContent.trim()) {
            out.push({
                level: node.attrs["level"] as number,
                text: node.textContent.trim(),
                pos,
                topLevel: v.state.doc.resolve(pos).depth === 0,
            });
        }
    });
    return out;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
    return {
        left, top, width, height,
        right: left + width,
        bottom: top + height,
        x: left, y: top,
        toJSON: () => ({}),
    } as DOMRect;
}

/**
 * A fake rendered TOC: panel at x 500–720, list below y=40, one 20px-tall
 * item per heading starting at y=100 on a 22px rhythm.
 */
function buildTocDom(v: EditorView): {
    panel: HTMLElement;
    list: HTMLElement;
    items: Map<number, HTMLElement>;
} {
    const panel = document.createElement("div");
    panel.getBoundingClientRect = () => rect(500, 0, 220, 800);
    const list = document.createElement("div");
    list.getBoundingClientRect = () => rect(500, 40, 220, 700);
    panel.appendChild(list);
    document.body.appendChild(panel);
    const items = new Map<number, HTMLElement>();
    let top = 100;
    for (const h of headingsOf(v)) {
        const item = document.createElement("div");
        item.className = "toc-item";
        item.dataset["headingPos"] = String(h.pos);
        const r = rect(504, top, 212, 20);
        item.getBoundingClientRect = () => r;
        top += 22;
        list.appendChild(item);
        items.set(h.pos, item);
    }
    return { panel, list, items };
}

function initDnd(v: EditorView, dom: { panel: HTMLElement; list: HTMLElement }): TocDnd {
    const dnd = initTocDnd({
        panel: dom.panel,
        list: dom.list,
        getEditorView: () => v,
        isOpen: () => true,
        getHeadings: () => headingsOf(v),
    });
    disposers.push(dnd.dispose);
    return dnd;
}

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(async () => {
    for (const dispose of disposers) {
        dispose();
    }
    disposers = [];
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    activeEditor = null;
    document.body.innerHTML = "";
    document.body.className = "";
});

describe("TOC drop-zone provider (document/TOC drags into the outline)", () => {
    it("dropping a toc gap slot pos through moveBlocks should reorder whole sections in the serialized markdown", async () => {
        const editor = await makeEditor("# A\n\na body\n\n# B\n\nb body");
        const v = view(editor);
        const dom = buildTocDom(v);
        const dnd = initDnd(v, dom);
        const [entryA] = headingsOf(v);
        const itemA = dom.items.get(entryA!.pos)!;
        dnd.wireItemDrag(itemA, entryA!);

        mouse(itemA, "mousedown", { button: 0, clientX: 600, clientY: 105, buttons: 1 });
        // Threshold crossed, pointer inside the panel, below every item:
        // nearest gap is the terminal end-of-doc slot.
        mouse(document, "mousemove", { clientX: 600, clientY: 400, buttons: 1 });
        expect(itemA.classList.contains("toc-item--drag-source")).toBe(true);
        mouse(document, "mouseup", { button: 0, buttons: 0 });

        expect(markdown(editor)).toBe("# B\n\nb body\n\n# A\n\na body");
        expect(itemA.classList.contains("toc-item--drag-source")).toBe(false);
    });

    it("a collapsed section dragged via its toc item should carry its hidden body", async () => {
        const editor = await makeEditor("# A\n\nhidden body\n\n# B\n\nb body");
        const v = view(editor);
        v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, { type: "toggle", pos: 0 }));
        expect(headingFoldPluginKey.getState(v.state)!.folded.has(0)).toBe(true);
        const dom = buildTocDom(v);
        const dnd = initDnd(v, dom);
        const [entryA] = headingsOf(v);
        const itemA = dom.items.get(entryA!.pos)!;
        dnd.wireItemDrag(itemA, entryA!);

        mouse(itemA, "mousedown", { button: 0, clientX: 600, clientY: 105, buttons: 1 });
        mouse(document, "mousemove", { clientX: 600, clientY: 400, buttons: 1 });
        mouse(document, "mouseup", { button: 0, buttons: 0 });

        expect(markdown(editor)).toBe("# B\n\nb body\n\n# A\n\nhidden body");
    });

    it("an into slot commit should append the dragged block at the section end", async () => {
        const editor = await makeEditor("Intro\n\n# A\n\na body\n\n# B\n\nb body");
        const v = view(editor);
        const dom = buildTocDom(v);
        initDnd(v, dom);
        const [entryA] = headingsOf(v);
        const itemA = dom.items.get(entryA!.pos)!;

        // Drag the Intro paragraph by its gutter marker into item A's middle
        // band (item A: y 100–120, band 105–115).
        const marker = document.querySelector<HTMLElement>(".heading-fold-marker")!;
        mouse(marker, "mousedown", { button: 0, clientX: 10, clientY: 300, buttons: 1 });
        mouse(document, "mousemove", { clientX: 600, clientY: 110, buttons: 1 });
        expect(itemA.classList.contains("toc-item--drop-into")).toBe(true);
        mouse(document, "mouseup", { button: 0, buttons: 0 });

        expect(markdown(editor)).toBe("# A\n\na body\n\nIntro\n\n# B\n\nb body");
        expect(itemA.classList.contains("toc-item--drop-into")).toBe(false);
    });

    it("a toc-initiated drag should offer only gap slots (no into highlight)", async () => {
        const editor = await makeEditor("# A\n\na body\n\n# B\n\nb body");
        const v = view(editor);
        const before = markdown(editor);
        const dom = buildTocDom(v);
        const dnd = initDnd(v, dom);
        const [entryA, entryB] = headingsOf(v);
        const itemA = dom.items.get(entryA!.pos)!;
        const itemB = dom.items.get(entryB!.pos)!;
        dnd.wireItemDrag(itemA, entryA!);

        mouse(itemA, "mousedown", { button: 0, clientX: 600, clientY: 105, buttons: 1 });
        // y=131 sits inside item B's middle band (127–137): a document drag
        // would highlight "into B", but a section drag falls through to the
        // gap contest — whose winner (B's own top edge) is the dragged
        // range's end, i.e. the put-it-back gesture.
        mouse(document, "mousemove", { clientX: 600, clientY: 131, buttons: 1 });
        expect(document.querySelector(".toc-item--drop-into")).toBeNull();
        expect(itemB.classList.contains("toc-item--drop-into")).toBe(false);
        mouse(document, "mouseup", { button: 0, buttons: 0 });

        expect(markdown(editor)).toBe(before);
    });

    it("wireItemDrag on a stale headingPos should not start a session", async () => {
        const editor = await makeEditor("# A\n\na body\n\n# B\n\nb body");
        const v = view(editor);
        const before = markdown(editor);
        const dom = buildTocDom(v);
        const dnd = initDnd(v, dom);
        const [entryA] = headingsOf(v);
        const itemA = dom.items.get(entryA!.pos)!;
        // A stale outline entry: its pos now points at the "a body" paragraph.
        dnd.wireItemDrag(itemA, { ...entryA!, pos: 3 });

        mouse(itemA, "mousedown", { button: 0, clientX: 600, clientY: 105, buttons: 1 });
        mouse(document, "mousemove", { clientX: 600, clientY: 400, buttons: 1 });
        expect(document.body.classList.contains("block-dragging")).toBe(false);
        expect(dnd.dragSourceHeadingPos()).toBeNull();
        mouse(document, "mouseup", { button: 0, buttons: 0 });

        expect(markdown(editor)).toBe(before);
    });
});

describe("initToc drag integration", () => {
    const fakeEventManager = { onWindow: vi.fn() } as unknown as EventManager;
    let rafQueue: FrameRequestCallback[] = [];

    function flushRaf(): void {
        const queue = rafQueue;
        rafQueue = [];
        for (const cb of queue) {
            cb(0);
        }
    }

    beforeEach(() => {
        rafQueue = [];
        // A controlled queue, NOT a synchronous stub: the drag session's
        // auto-scroll loop re-schedules itself per frame, so a sync rAF
        // would recurse forever. Queued frames are simply never flushed
        // while a drag is in flight.
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
            rafQueue.push(cb);
            return rafQueue.length;
        });
        vi.stubGlobal("cancelAnimationFrame", () => {});
        Element.prototype.scrollIntoView = vi.fn();
        window.scrollTo = vi.fn();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    async function makeToc(md: string) {
        const editor = await makeEditor(md);
        const v = view(editor);
        const toc = initToc(fakeEventManager, () => v);
        document.body.appendChild(toc.panel); // the webview entry does this
        disposers.push(toc.dispose);
        flushRaf(); // run the init frame (mode/state commit)
        toc.toggle(); // no #editor element → overlay mode; open it
        return { editor, v, toc };
    }

    function itemAt(pos: number): HTMLElement {
        return document.querySelector<HTMLElement>(`.toc-item[data-heading-pos="${pos}"]`)!;
    }

    it("renderHeadings during an active toc drag should re-apply the drag-source class", async () => {
        const { toc } = await makeToc("# A\n\nalpha\n\n# B\n\nbeta");
        const item = itemAt(0);
        mouse(item, "mousedown", { button: 0, clientX: 10, clientY: 10, buttons: 1 });
        mouse(document, "mousemove", { clientX: 40, clientY: 40, buttons: 1 });
        expect(item.classList.contains("toc-item--drag-source")).toBe(true);

        toc.refresh(); // full list rebuild mid-drag

        const rebuilt = itemAt(0);
        expect(rebuilt).not.toBe(item);
        expect(rebuilt.classList.contains("toc-item--drag-source")).toBe(true);
        expect(rebuilt.dataset["dragged"]).toBe("1");

        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        mouse(document, "mouseup", { button: 0, buttons: 0 });
        expect(rebuilt.classList.contains("toc-item--drag-source")).toBe(false);
    });

    it("a toc item click after a drag should not navigate", async () => {
        await makeToc("# A\n\nalpha\n\n# B\n\nbeta");
        const item = itemAt(0);
        mouse(item, "mousedown", { button: 0, clientX: 10, clientY: 10, buttons: 1 });
        mouse(document, "mousemove", { clientX: 40, clientY: 40, buttons: 1 });
        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        // The button's eventual release still produces a click on the item —
        // it must stay suppressed.
        mouse(item, "mouseup", { button: 0, buttons: 0 });
        mouse(item, "click", { button: 0 });
        expect(item.classList.contains("toc-item--active")).toBe(false);

        await new Promise((resolve) => setTimeout(resolve, 1)); // flag cleanup hop
        // The NEXT genuine click navigates.
        mouse(item, "click", { button: 0 });
        expect(item.classList.contains("toc-item--active")).toBe(true);
    });

    it("a plain click should navigate while mousedown alone should not", async () => {
        await makeToc("# A\n\nalpha\n\n# B\n\nbeta");
        const item = itemAt(0);
        mouse(item, "mousedown", { button: 0, clientX: 10, clientY: 10, buttons: 1 });
        mouse(item, "mouseup", { button: 0, buttons: 0 });
        expect(item.classList.contains("toc-item--active")).toBe(false);
        mouse(item, "click", { button: 0 });
        expect(item.classList.contains("toc-item--active")).toBe(true);
    });

    it("a mousedown on a gutter marker should not close the overlay toc", async () => {
        const { toc } = await makeToc("# A\n\nalpha\n\n# B\n\nbeta");
        expect(toc.isOpen()).toBe(true);
        // The outside-close handler registers on a zero-delay hop.
        await new Promise((resolve) => setTimeout(resolve, 1));

        const gutter = document.createElement("div");
        gutter.className = "heading-fold-marker";
        document.body.appendChild(gutter);
        mouse(gutter, "mousedown", { button: 0 });
        expect(toc.isOpen()).toBe(true);

        // A genuinely-outside mousedown still closes the overlay.
        mouse(document.body, "mousedown", { button: 0 });
        expect(toc.isOpen()).toBe(false);
    });
});
