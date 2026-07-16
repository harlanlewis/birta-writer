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
import type { EditorView } from "@milkdown/prose/view";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
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
        .use(gfmFidelity)
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
                atDocRoot: v.state.doc.resolve(pos).depth === 0,
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
    // Provider-path commits scroll the landing into view (drag.ts calls
    // scrollElementBelowTopbar → window.scrollTo, which jsdom lacks).
    window.scrollTo = vi.fn();
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
        const [entryA, entryB] = headingsOf(v);
        const itemA = dom.items.get(entryA!.pos)!;

        // Drag the Intro paragraph by its gutter marker into item A's middle
        // band (item A: y 100–120, band 105–115).
        const marker = document.querySelector<HTMLElement>(".heading-fold-marker")!;
        mouse(marker, "mousedown", { button: 0, clientX: 10, clientY: 300, buttons: 1 });
        mouse(document, "mousemove", { clientX: 600, clientY: 110, buttons: 1 });
        expect(itemA.classList.contains("toc-item--drop-into")).toBe(true);
        // Honest into cue: the shared line ALSO marks the landing boundary —
        // section A's end is heading B's gap, measured at item B's top edge
        // (y 122 on the fixture's rhythm), so the indicator sits at y − 1.
        const indicator = document.querySelector<HTMLElement>(".block-drag-indicator")!;
        expect(indicator.style.display).toBe("block");
        expect(indicator.style.top).toBe(
            `${dom.items.get(entryB!.pos)!.getBoundingClientRect().top - 1}px`,
        );
        mouse(document, "mouseup", { button: 0, buttons: 0 });

        expect(markdown(editor)).toBe("# A\n\na body\n\nIntro\n\n# B\n\nb body");
        expect(itemA.classList.contains("toc-item--drop-into")).toBe(false);
        expect(indicator.style.display).toBe("none");
    });

    it("a provider commit should scroll the landed block into view (document commits do not — see blockDrag.test)", async () => {
        const editor = await makeEditor("Intro\n\n# A\n\na body\n\n# B\n\nb body");
        const v = view(editor);
        const dom = buildTocDom(v);
        initDnd(v, dom);

        // Same into-A drop as above: the landing (section A's end) can be
        // far off-screen, so the commit must attempt a scroll to it.
        const marker = document.querySelector<HTMLElement>(".heading-fold-marker")!;
        mouse(marker, "mousedown", { button: 0, clientX: 10, clientY: 300, buttons: 1 });
        mouse(document, "mousemove", { clientX: 600, clientY: 110, buttons: 1 });
        mouse(document, "mouseup", { button: 0, buttons: 0 });

        expect(markdown(editor)).toBe("# A\n\na body\n\nIntro\n\n# B\n\nb body");
        expect(window.scrollTo).toHaveBeenCalled();
    });

    it("wireItemDrag should mark only top-level items as draggable", async () => {
        const editor = await makeEditor("# A\n\na body\n\n# B\n\nb body");
        const v = view(editor);
        const dom = buildTocDom(v);
        const dnd = initDnd(v, dom);
        const [entryA] = headingsOf(v);
        const itemA = dom.items.get(entryA!.pos)!;
        const nested = document.createElement("div");

        dnd.wireItemDrag(itemA, entryA!);
        // A nested heading is a landmark, not a handle — no grab affordance.
        dnd.wireItemDrag(nested, { ...entryA!, atDocRoot: false });

        expect(itemA.classList.contains("toc-item--draggable")).toBe(true);
        expect(nested.classList.contains("toc-item--draggable")).toBe(false);
    });

    it("a toc-initiated drag onto an item's middle band should offer the into slot", async () => {
        const editor = await makeEditor("# A\n\na body\n\n# B\n\nb body");
        const v = view(editor);
        const dom = buildTocDom(v);
        const dnd = initDnd(v, dom);
        const [entryA, entryB] = headingsOf(v);
        const itemA = dom.items.get(entryA!.pos)!;
        const itemB = dom.items.get(entryB!.pos)!;
        dnd.wireItemDrag(itemA, entryA!);

        mouse(itemA, "mousedown", { button: 0, clientX: 600, clientY: 105, buttons: 1 });
        // y=131 sits inside item B's middle band (127–137). A section drag
        // takes "into" targets like any other run now: dropping ONTO an item
        // means "become its child" (the outline is a structural editor).
        mouse(document, "mousemove", { clientX: 600, clientY: 131, buttons: 1 });
        expect(itemB.classList.contains("toc-item--drop-into")).toBe(true);
        mouse(document, "mouseup", { button: 0, buttons: 0 });

        // A files under B as its child: H1 → H2 (B's level + 1), appended at
        // the end of B's section.
        expect(markdown(editor)).toBe("# B\n\nb body\n\n## A\n\na body");
    });

    it("a section dropped into a deeper section should relevel to that owner's level + 1", async () => {
        // Dragging an H2 onto an H3 must land it as an H4 — the drop position
        // dictates the rank.
        const editor = await makeEditor("# Top\n\n### Deep\n\ndeep body\n\n## Two\n\ntwo body");
        const v = view(editor);
        const dom = buildTocDom(v);
        const dnd = initDnd(v, dom);
        const entries = headingsOf(v);
        const deep = entries.find((e) => e.text === "Deep")!;
        const two = entries.find((e) => e.text === "Two")!;
        const itemTwo = dom.items.get(two.pos)!;
        dnd.wireItemDrag(itemTwo, two);

        // Item index of "Deep" is 1 → band 122–142, middle band 127–137.
        const deepIndex = entries.findIndex((e) => e.text === "Deep");
        expect(deepIndex).toBe(1);
        mouse(itemTwo, "mousedown", { button: 0, clientX: 600, clientY: 149, buttons: 1 });
        mouse(document, "mousemove", { clientX: 600, clientY: 131, buttons: 1 });
        expect(dom.items.get(deep.pos)!.classList.contains("toc-item--drop-into")).toBe(true);
        mouse(document, "mouseup", { button: 0, buttons: 0 });

        expect(markdown(editor)).toBe("# Top\n\n### Deep\n\ndeep body\n\n#### Two\n\ntwo body");
    });

    it("a section dropped on a gap line should relevel to the following heading's level", async () => {
        // Gap above "### Deep" ⇒ sibling of Deep ⇒ the dragged H2 becomes H3.
        const editor = await makeEditor("# Top\n\n### Deep\n\ndeep body\n\n## Two\n\ntwo body");
        const v = view(editor);
        const dom = buildTocDom(v);
        const dnd = initDnd(v, dom);
        const entries = headingsOf(v);
        const two = entries.find((e) => e.text === "Two")!;
        const itemTwo = dom.items.get(two.pos)!;
        dnd.wireItemDrag(itemTwo, two);

        mouse(itemTwo, "mousedown", { button: 0, clientX: 600, clientY: 149, buttons: 1 });
        // y=122 is item Deep's top edge — the gap line above it, outside the
        // middle band, so the gap wins.
        mouse(document, "mousemove", { clientX: 600, clientY: 122, buttons: 1 });
        mouse(document, "mouseup", { button: 0, buttons: 0 });

        expect(markdown(editor)).toBe("# Top\n\n### Two\n\ntwo body\n\n### Deep\n\ndeep body");
    });

    it("a relevel that would overflow H6 should clamp the subtree at H6", async () => {
        // Dragging the "## Mid" section (carrying an H5) into "### Deep"
        // implies +2; the H5 child would reach H7 and clamps to H6.
        const editor = await makeEditor(
            "# Top\n\n### Deep\n\ndeep body\n\n## Mid\n\nmid body\n\n##### Child\n\nchild body",
        );
        const v = view(editor);
        const dom = buildTocDom(v);
        const dnd = initDnd(v, dom);
        const entries = headingsOf(v);
        const mid = entries.find((e) => e.text === "Mid")!;
        const itemMid = dom.items.get(mid.pos)!;
        dnd.wireItemDrag(itemMid, mid);

        mouse(itemMid, "mousedown", { button: 0, clientX: 600, clientY: 149, buttons: 1 });
        mouse(document, "mousemove", { clientX: 600, clientY: 131, buttons: 1 });
        mouse(document, "mouseup", { button: 0, buttons: 0 });

        // Mid H2→H4 (+2); Child H5→H6 (clamped, not H7). The section's whole
        // subtree travels and shifts together.
        expect(markdown(editor)).toBe(
            "# Top\n\n### Deep\n\ndeep body\n\n#### Mid\n\nmid body\n\n###### Child\n\nchild body",
        );
    });

    it("a section drop that changes no rank should leave every heading level untouched", async () => {
        // Gap above sibling "# B" ⇒ target level 1 == the dragged level:
        // delta 0, a purely positional move.
        const editor = await makeEditor("# A\n\na body\n\n# B\n\nb body\n\n# C\n\nc body");
        const v = view(editor);
        const dom = buildTocDom(v);
        const dnd = initDnd(v, dom);
        const entries = headingsOf(v);
        const c = entries.find((e) => e.text === "C")!;
        const itemC = dom.items.get(c.pos)!;
        dnd.wireItemDrag(itemC, c);

        mouse(itemC, "mousedown", { button: 0, clientX: 600, clientY: 149, buttons: 1 });
        // y=122 = item B's top edge = the gap above B.
        mouse(document, "mousemove", { clientX: 600, clientY: 122, buttons: 1 });
        mouse(document, "mouseup", { button: 0, buttons: 0 });

        expect(markdown(editor)).toBe("# A\n\na body\n\n# C\n\nc body\n\n# B\n\nb body");
    });

    it("wireItemDrag on a stale headingPos should not start a session", async () => {
        const editor = await makeEditor("# A\n\na body\n\n# B\n\nb body");
        const v = view(editor);
        const before = markdown(editor);
        const dom = buildTocDom(v);
        const dnd = initDnd(v, dom);
        const [entryA] = headingsOf(v);
        const itemA = dom.items.get(entryA!.pos)!;
        dnd.wireItemDrag(itemA, entryA!);
        // A stale row: its ANCHOR now points at the "a body" paragraph. The
        // dataset is where the anchor lives (a row is re-anchored in place
        // across edits, so the entry that built it is never the authority) —
        // staleness has to be injected there to be injected at all.
        itemA.dataset["headingPos"] = "3";

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

    async function makeToc(md: string, opts: { overlay?: boolean } = {}) {
        if (opts.overlay) {
            // Dock-vs-overlay is a pure viewport measure (hasEnoughSpace:
            // innerWidth >= tocWidth + DOCKED_MIN_CONTENT_WIDTH); jsdom's
            // default 1024px resolves to docked, so overlay tests narrow it.
            vi.stubGlobal("innerWidth", 600);
        }
        const editor = await makeEditor(md);
        const v = view(editor);
        const toc = initToc(fakeEventManager, () => v);
        document.body.appendChild(toc.panel); // the webview entry does this
        disposers.push(toc.dispose);
        flushRaf(); // run the init frame (mode/state commit)
        toc.toggle(); // open the panel (docked by default; overlay when narrowed)
        return { editor, v, toc };
    }

    function itemAt(pos: number): HTMLElement {
        return document.querySelector<HTMLElement>(`.toc-item[data-heading-pos="${pos}"]`)!;
    }

    it("a heading nested in a container should still reach the outline as a landmark", async () => {
        // getHeadings prunes its walk at every TEXTBLOCK (a heading's content
        // is inline, so no heading can hide inside one) — but it must still
        // descend through CONTAINERS. A blockquote is not a textblock, so the
        // heading inside it is found, and stays a landmark rather than a drag
        // handle (only doc-root sections carry section semantics).
        await makeToc("# A\n\nalpha\n\n> ## Quoted\n>\n> inside\n\n# B\n\nbeta");
        const rows = [...document.querySelectorAll<HTMLElement>(".toc-item")];
        expect(rows.map((el) => el.textContent)).toEqual(["A", "Quoted", "B"]);
        const quoted = rows.find((el) => el.textContent === "Quoted")!;
        expect(quoted.classList.contains("toc-item--draggable")).toBe(false);
        expect(rows[0]!.classList.contains("toc-item--draggable")).toBe(true);
    });

    it("a refresh while the panel is flown out should re-render the outline", async () => {
        // Rendering used to be gated on `isOpen` alone, but the flyout shows
        // the panel with isOpen === false — so a flown-out outline never
        // tracked the document. It showed stale rows, and their stale
        // data-headingPos values then armed the NEXT drag against positions
        // the document had already moved past (the drag would silently do
        // nothing). Both symptoms trace back to this one guard.
        const { v, toc } = await makeToc("# A\n\nalpha\n\n# B\n\nbeta");
        toc.toggle(); // collapse — the flyout only exists while the tab shows
        const tab = document.querySelector<HTMLElement>(".toc-toggle-tab")!;
        tab.dispatchEvent(new MouseEvent("mouseenter"));
        expect(itemAt(0).textContent).toBe("A");

        v.dispatch(v.state.tr.insertText("!", 2)); // rename heading A
        toc.refresh();

        expect(itemAt(0).textContent).toBe("A!");
    });

    it("a refresh whose outline is unchanged should not rebuild the list", async () => {
        const { toc } = await makeToc("# A\n\nalpha\n\n# B\n\nbeta");
        const item = itemAt(0);
        // The outline now refreshes once per doc-changing frame, so the
        // overwhelmingly common case (an edit that leaves headings alone) must
        // cost no DOM churn — same elements, and the drag geometry snapshot
        // they anchor stays valid.
        toc.refresh();
        expect(itemAt(0)).toBe(item);
    });

    it("renderHeadings during an active toc drag should re-apply the drag-source class", async () => {
        const { v, toc } = await makeToc("# A\n\nalpha\n\n# B\n\nbeta");
        const item = itemAt(0);
        mouse(item, "mousedown", { button: 0, clientX: 10, clientY: 10, buttons: 1 });
        mouse(document, "mousemove", { clientX: 40, clientY: 40, buttons: 1 });
        expect(item.classList.contains("toc-item--drag-source")).toBe(true);

        // A real outline change (heading A's text) — an unchanged outline is
        // now a deliberate no-op, so force the rebuild this test is about.
        v.dispatch(v.state.tr.insertText("!", 2));
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
        // Fake timers so the suppression-flag cleanup hop (a production
        // setTimeout(0)) is advanced deterministically, never raced against a
        // real wall-clock wait. Enabled AFTER makeToc so editor creation still
        // runs on real timers.
        vi.useFakeTimers();
        try {
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

            vi.advanceTimersByTime(1); // run the flag cleanup hop
            // The NEXT genuine click navigates.
            mouse(item, "click", { button: 0 });
            expect(item.classList.contains("toc-item--active")).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("an in-place micro-drag should still navigate on release", async () => {
        await makeToc("# A\n\nalpha\n\n# B\n\nbeta");
        const item = itemAt(0);
        // A rect the whole gesture stays inside: the 6px move below crosses
        // the 4px drag threshold but never leaves the item — a jittery
        // click, not a move.
        item.getBoundingClientRect = () => rect(0, 0, 200, 30);
        mouse(item, "mousedown", { button: 0, clientX: 10, clientY: 10, buttons: 1 });
        mouse(document, "mousemove", { clientX: 10, clientY: 16, buttons: 1 });
        // The threshold was crossed: a session did start…
        expect(item.classList.contains("toc-item--drag-source")).toBe(true);
        mouse(item, "mouseup", { button: 0, buttons: 0 });
        // …but the release's click must navigate anyway (no one-tick wait:
        // the suppression flag clears synchronously on this path).
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
        // Fake timers so the outside-close handler's zero-delay registration hop
        // is advanced deterministically (the wait is load-bearing — without it
        // the handler isn't attached and the test would pass vacuously).
        vi.useFakeTimers();
        try {
        const { toc } = await makeToc("# A\n\nalpha\n\n# B\n\nbeta", { overlay: true });
        expect(toc.isOpen()).toBe(true);
        // The outside-close handler registers on a zero-delay hop.
        await vi.advanceTimersByTimeAsync(1);

        const gutter = document.createElement("div");
        gutter.className = "heading-fold-marker";
        document.body.appendChild(gutter);
        mouse(gutter, "mousedown", { button: 0 });
        expect(toc.isOpen()).toBe(true);

        // A genuinely-outside mousedown still closes the overlay.
        mouse(document.body, "mousedown", { button: 0 });
        expect(toc.isOpen()).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
