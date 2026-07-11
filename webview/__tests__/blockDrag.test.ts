/**
 * Tests for the gutter drag-to-reorder helpers (MAR-19): the pure drop-target
 * math and the position-targeted move transaction. The pointer session itself
 * (thresholds, indicator, auto-scroll) needs real layout and lives in
 * e2e/blockDrag.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import type { EditorView } from "@milkdown/prose/view";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";
import { historyPlugin } from "../plugins/history";
import { undo } from "@milkdown/prose/history";
import { moveBlockTo, moveRangeAt, setBlockMenuContext } from "../components/blockMenu";
import { mockVscodeApi } from "./setup";
import {
    blockBoundaryPositions,
    dropTargetFor,
} from "../components/blockMenu/drag";

let editors: Editor[] = [];
let activeEditor: Editor | null = null;

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

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

describe("blockBoundaryPositions", () => {
    it("a three-block doc should yield four block boundaries (before each + end)", async () => {
        const editor = await makeEditor("Alpha\n\nBeta\n\nGamma");
        const doc = view(editor).state.doc;
        const positions = blockBoundaryPositions(doc);
        expect(positions).toHaveLength(4);
        expect(positions[0]).toEqual({ pos: 0, kind: "block" });
        expect(positions[3]).toEqual({ pos: doc.content.size, kind: "block" });
        for (const { pos } of positions.slice(0, -1)) {
            expect(doc.nodeAt(pos)).not.toBeNull();
        }
    });

    it("lists contribute item slots at every depth plus an end-of-list slot", async () => {
        const editor = await makeEditor("- one\n- two\n  - nested\n\npara");
        const doc = view(editor).state.doc;
        const positions = blockBoundaryPositions(doc);
        const items = positions.filter((b) => b.kind === "item");
        // one, two, nested = 3 item starts; outer + inner list ends = 2.
        expect(items).toHaveLength(5);
        const itemStarts = items.filter(({ pos }) => doc.nodeAt(pos)?.type.name === "list_item");
        expect(itemStarts).toHaveLength(3);
        const blocks = positions.filter((b) => b.kind === "block");
        expect(blocks).toHaveLength(3); // list, para, doc end
    });
});

describe("per-item list drag/menu (MAR-86)", () => {
    it("every list item gets its own marker with a source-true glyph", async () => {
        const editor = await makeEditor("1. first\n2. second\n\n- [x] done\n- [ ] todo");
        view(editor);
        const glyphs = Array.from(document.querySelectorAll(".heading-fold-marker--block"))
            .map((el) => el.textContent);
        expect(glyphs).toEqual(["1.", "2.", "[x]", "[ ]"]);
    });

    it("an ordered list starting at 3 shows 3. and 4. — the real ordinals", async () => {
        const editor = await makeEditor("3. a\n4. b");
        view(editor);
        const glyphs = Array.from(document.querySelectorAll(".heading-fold-marker--block"))
            .map((el) => el.textContent);
        expect(glyphs).toEqual(["3.", "4."]);
        // And copying the second item carries ITS ordinal, not the start.
        const markerEls = Array.from(document.querySelectorAll<HTMLButtonElement>(".heading-fold-marker"));
        markerEls[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        const menu = document.querySelector<HTMLElement>(".block-menu")!;
        const row = Array.from(menu.querySelectorAll<HTMLElement>(".block-menu-item"))
            .find((el) => el.querySelector(".block-menu-item-label")?.textContent === "Copy as Markdown")!;
        row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        const call = mockVscodeApi.postMessage.mock.calls
            .map((args) => args[0])
            .find((msg) => msg.type === "clipboardWrite");
        expect(call?.data?.trim()).toBe("4. b");
    });

    it("moving an item within its list should reorder just the siblings", async () => {
        const editor = await makeEditor("- one\n- two\n- three");
        const v = view(editor);
        // First item's marker → its menu → Move Down.
        const markerEls = Array.from(document.querySelectorAll<HTMLButtonElement>(".heading-fold-marker"));
        markerEls[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        const menu = document.querySelector<HTMLElement>(".block-menu")!;
        const row = Array.from(menu.querySelectorAll<HTMLElement>(".block-menu-item"))
            .find((el) => el.querySelector(".block-menu-item-label")?.textContent === "Move Down")!;
        row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        expect(markdown(editor)).toBe("- two\n- one\n- three");
        void v;
    });

    it("an item's menu offers the LIST-level conversions under 'Turn list into'", async () => {
        const editor = await makeEditor("- one\n- two");
        view(editor);
        const markerEls = Array.from(document.querySelectorAll<HTMLButtonElement>(".heading-fold-marker"));
        markerEls[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        const menu = document.querySelector<HTMLElement>(".block-menu")!;
        expect(menu.querySelector(".block-menu-header")!.textContent).toBe("Turn list into");
        const active = menu.querySelector(".block-menu-item--active .block-menu-item-label");
        expect(active!.textContent).toBe("Bullet List");
        const row = Array.from(menu.querySelectorAll<HTMLElement>(".block-menu-item"))
            .find((el) => el.querySelector(".block-menu-item-label")?.textContent === "Ordered List")!;
        row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        expect(markdown(editor)).toBe("1. one\n2. two");
    });

    it("deleting a list's only item should dissolve the list", async () => {
        const editor = await makeEditor("- only\n\npara");
        view(editor);
        const markerEls = Array.from(document.querySelectorAll<HTMLButtonElement>(".heading-fold-marker"));
        markerEls[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        const menu = document.querySelector<HTMLElement>(".block-menu")!;
        const row = Array.from(menu.querySelectorAll<HTMLElement>(".block-menu-item"))
            .find((el) => el.querySelector(".block-menu-item-label")?.textContent === "Delete")!;
        row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        expect(markdown(editor)).toBe("para");
    });

    it("moveBlockTo can refile an item into ANOTHER list", async () => {
        const editor = await makeEditor("- a1\n- a2\n\n1. b1");
        const v = view(editor);
        // Find the second item of list A and the slot before b1.
        let a2Pos = -1;
        let b1Pos = -1;
        v.state.doc.descendants((node, pos) => {
            if (node.type.name === "list_item") {
                if (node.textContent === "a2") a2Pos = pos;
                if (node.textContent === "b1") b1Pos = pos;
            }
            return true;
        });
        const item = v.state.doc.nodeAt(a2Pos)!;
        expect(moveBlockTo(v, { from: a2Pos, to: a2Pos + item.nodeSize }, b1Pos)).toBe(true);
        expect(markdown(editor)).toBe("- a1\n\n1. a2\n2. b1");
    });

    it("an item's Copy as Markdown wraps it in its list flavor", async () => {
        const editor = await makeEditor("1. first\n2. second");
        view(editor);
        const markerEls = Array.from(document.querySelectorAll<HTMLButtonElement>(".heading-fold-marker"));
        markerEls[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        const menu = document.querySelector<HTMLElement>(".block-menu")!;
        const row = Array.from(menu.querySelectorAll<HTMLElement>(".block-menu-item"))
            .find((el) => el.querySelector(".block-menu-item-label")?.textContent === "Copy as Markdown")!;
        row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        const call = mockVscodeApi.postMessage.mock.calls
            .map((args) => args[0])
            .find((msg) => msg.type === "clipboardWrite");
        // The item's REAL ordinal, not the list's start.
        expect(call?.data?.trim()).toBe("2. second");
    });
});

describe("dropTargetFor", () => {
    const boundaries = [
        { pos: 0, y: 0, kind: "block" as const },
        { pos: 10, y: 100, kind: "block" as const },
        { pos: 20, y: 200, kind: "block" as const },
        { pos: 30, y: 300, kind: "block" as const },
    ];

    it("the nearest boundary by y should win", () => {
        expect(dropTargetFor(boundaries, 140, { from: 20, to: 30 })?.pos).toBe(10);
        expect(dropTargetFor(boundaries, 230, { from: 0, to: 10 })?.pos).toBe(20);
    });

    it("a pointer nearest the range's own slot should yield null (put it back)", () => {
        // Dragging [10,20): hovering near its own edges is the return
        // gesture — the indicator hides and the drop is a clean no-op,
        // instead of snapping to the neighbor above/below.
        expect(dropTargetFor(boundaries, 105, { from: 10, to: 20 })).toBeNull();
        expect(dropTargetFor(boundaries, 195, { from: 10, to: 20 })).toBeNull();
    });

    it("a pointer genuinely nearest a legal boundary still snaps there", () => {
        expect(dropTargetFor(boundaries, 40, { from: 10, to: 20 })?.pos).toBe(0);
        expect(dropTargetFor(boundaries, 260, { from: 10, to: 20 })?.pos).toBe(30);
    });

    it("all boundaries in-range should yield null", () => {
        expect(dropTargetFor(boundaries.slice(0, 2), 50, { from: 0, to: 10 })).toBeNull();
    });
});

describe("drag session robustness", () => {
    function marker(): HTMLButtonElement {
        return document.querySelector<HTMLButtonElement>(".heading-fold-marker")!;
    }
    const mouse = (
        target: EventTarget,
        type: string,
        opts: MouseEventInit,
    ) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...opts }));

    it("releasing the button outside the window should end the session", async () => {
        const editor = await makeEditor("Alpha\n\nBeta");
        view(editor);
        const m = marker();
        mouse(m, "mousedown", { button: 0, clientX: 10, clientY: 10, buttons: 1 });
        mouse(document, "mousemove", { clientX: 30, clientY: 30, buttons: 1 }); // threshold
        expect(document.body.classList.contains("block-dragging")).toBe(true);
        // Next move arrives with no button held (released off-window).
        mouse(document, "mousemove", { clientX: 32, clientY: 32, buttons: 0 });
        expect(document.body.classList.contains("block-dragging")).toBe(false);
    });

    it("releasing an Escape-canceled drag suppresses THAT click; the next one opens the menu", async () => {
        const editor = await makeEditor("Alpha\n\nBeta");
        view(editor);
        const m = marker();
        mouse(m, "mousedown", { button: 0, clientX: 10, clientY: 10, buttons: 1 });
        mouse(document, "mousemove", { clientX: 30, clientY: 30, buttons: 1 });
        expect(m.dataset["dragged"]).toBe("1");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        expect(document.body.classList.contains("block-dragging")).toBe(false);
        // The button is STILL HELD after Escape — the flag must survive until
        // the eventual release, whose click stays suppressed.
        expect(m.dataset["dragged"]).toBe("1");
        mouse(m, "mouseup", { button: 0, buttons: 0 });
        mouse(m, "click", { button: 0 });
        expect(document.querySelector(".block-menu")).toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 1)); // cleanup hop after the release
        expect(m.dataset["dragged"]).toBeUndefined();
        // The NEXT genuine click opens the menu.
        mouse(m, "click", { button: 0 });
        expect(document.querySelector(".block-menu")).not.toBeNull();
    });

    it("releasing outside the window with the threshold uncrossed should tear the session down", async () => {
        const editor = await makeEditor("Alpha\n\nBeta");
        view(editor);
        const m = marker();
        mouse(m, "mousedown", { button: 0, clientX: 10, clientY: 10, buttons: 1 });
        // Pointer re-enters the window with no button held, threshold never crossed.
        mouse(document, "mousemove", { clientX: 11, clientY: 11, buttons: 0 });
        // A later big move must NOT start a ghost session.
        mouse(document, "mousemove", { clientX: 300, clientY: 300, buttons: 0 });
        expect(document.body.classList.contains("block-dragging")).toBe(false);
        expect(m.dataset["dragged"]).toBeUndefined();
    });
});

describe("selectionCoverRange (multi-block drag)", () => {
    it("a selection spanning two blocks should cover exactly those blocks", async () => {
        const editor = await makeEditor("Alpha\n\nBeta\n\nGamma");
        const v = view(editor);
        const { TextSelection } = await import("@milkdown/prose/state");
        // From inside Alpha to inside Beta.
        let betaPos = -1;
        v.state.doc.forEach((n, o) => { if (n.textContent === "Beta") betaPos = o; });
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 2, betaPos + 3)));
        const { selectionCoverRange } = await import("../components/blockMenu/drag");
        const cover = selectionCoverRange(v)!;
        expect(cover.from).toBe(0);
        expect(v.state.doc.resolve(cover.to).nodeAfter?.textContent).toBe("Gamma");
        // Moving the cover to the end moves BOTH blocks.
        const { moveBlockTo } = await import("../components/blockMenu");
        expect(moveBlockTo(v, cover, v.state.doc.content.size)).toBe(true);
        expect(markdown(editor)).toBe("Gamma\n\nAlpha\n\nBeta");
    });

    it("an empty or single-block selection should yield no cover", async () => {
        const editor = await makeEditor("Alpha\n\nBeta");
        const v = view(editor);
        const { selectionCoverRange } = await import("../components/blockMenu/drag");
        expect(selectionCoverRange(v)).toBeNull(); // caret only
        const { TextSelection } = await import("@milkdown/prose/state");
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 4)));
        expect(selectionCoverRange(v)).toBeNull(); // inside one block
    });
});

describe("moveBlockTo", () => {
    it("moving the first block to the end should reorder the doc", async () => {
        const editor = await makeEditor("Alpha\n\nBeta\n\nGamma");
        const v = view(editor);
        const range = moveRangeAt(v, 0)!;
        expect(moveBlockTo(v, range, v.state.doc.content.size)).toBe(true);
        expect(markdown(editor)).toBe("Beta\n\nGamma\n\nAlpha");
    });

    it("moving the last block to the top should reorder the doc", async () => {
        const editor = await makeEditor("Alpha\n\nBeta\n\nGamma");
        const v = view(editor);
        let lastPos = 0;
        v.state.doc.forEach((_node, offset) => {
            lastPos = offset;
        });
        const range = moveRangeAt(v, lastPos)!;
        expect(moveBlockTo(v, range, 0)).toBe(true);
        expect(markdown(editor)).toBe("Gamma\n\nAlpha\n\nBeta");
    });

    it("a heading's range should carry its section to the drop", async () => {
        const editor = await makeEditor("# A\n\ncontent A\n\n# B\n\ncontent B");
        const v = view(editor);
        const range = moveRangeAt(v, 0)!;
        expect(moveBlockTo(v, range, v.state.doc.content.size)).toBe(true);
        expect(markdown(editor)).toBe("# B\n\ncontent B\n\n# A\n\ncontent A");
    });

    it("dropping at the range's own edge should be a no-op", async () => {
        const editor = await makeEditor("Alpha\n\nBeta");
        const v = view(editor);
        const before = markdown(editor);
        const range = moveRangeAt(v, 0)!;
        expect(moveBlockTo(v, range, 0)).toBe(false);
        expect(moveBlockTo(v, range, range.to)).toBe(false);
        expect(markdown(editor)).toBe(before);
    });

    it("one drop should be one undo step", async () => {
        const editor = await makeEditor("Alpha\n\nBeta");
        const v = view(editor);
        const range = moveRangeAt(v, 0)!;
        expect(moveBlockTo(v, range, v.state.doc.content.size)).toBe(true);
        expect(markdown(editor)).toBe("Beta\n\nAlpha");
        undo(v.state, v.dispatch);
        expect(markdown(editor)).toBe("Alpha\n\nBeta");
    });
});
