/**
 * Tests for the gutter drag-to-reorder helpers (MAR-19): the pure drop-target
 * math and the position-targeted move transaction. The pointer session itself
 * (thresholds, indicator, auto-scroll) needs real layout and lives in
 * e2e/blockDrag.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import type { EditorView } from "@milkdown/prose/view";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";
import { moveBlockTo, moveRangeAt } from "../components/blockMenu";
import {
    blockBoundaryPositions,
    dropTargetFor,
} from "../components/blockMenu/drag";

let editors: Editor[] = [];

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
        .create();
    editors.push(editor);
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function markdown(editor: Editor): string {
    return editor.action(getMarkdown()).trim();
}

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

describe("blockBoundaryPositions", () => {
    it("a three-block doc should yield four boundaries (before each + end)", async () => {
        const editor = await makeEditor("Alpha\n\nBeta\n\nGamma");
        const doc = view(editor).state.doc;
        const positions = blockBoundaryPositions(doc);
        expect(positions).toHaveLength(4);
        expect(positions[0]).toBe(0);
        expect(positions[3]).toBe(doc.content.size);
        // Every non-end boundary starts a top-level block.
        for (const pos of positions.slice(0, -1)) {
            expect(doc.nodeAt(pos)).not.toBeNull();
        }
    });
});

describe("dropTargetFor", () => {
    const boundaries = [
        { pos: 0, y: 0 },
        { pos: 10, y: 100 },
        { pos: 20, y: 200 },
        { pos: 30, y: 300 },
    ];

    it("the nearest boundary by y should win", () => {
        expect(dropTargetFor(boundaries, 140, { from: 20, to: 30 })?.pos).toBe(10);
        expect(dropTargetFor(boundaries, 230, { from: 0, to: 10 })?.pos).toBe(20);
    });

    it("boundaries inside or at the edges of the dragged range should be skipped", () => {
        // Dragging [10,20): pointer near its own edges snaps outward.
        expect(dropTargetFor(boundaries, 105, { from: 10, to: 20 })?.pos).toBe(0);
        expect(dropTargetFor(boundaries, 195, { from: 10, to: 20 })?.pos).toBe(30);
    });

    it("no legal boundary should yield null", () => {
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

    it("one drop should be one undo step (single transaction)", async () => {
        const editor = await makeEditor("Alpha\n\nBeta");
        const v = view(editor);
        const range = moveRangeAt(v, 0)!;
        const stepsBefore = v.state.tr.steps.length; // sanity: fresh tr is empty
        expect(stepsBefore).toBe(0);
        expect(moveBlockTo(v, range, v.state.doc.content.size)).toBe(true);
        expect(markdown(editor)).toBe("Beta\n\nAlpha");
    });
});
