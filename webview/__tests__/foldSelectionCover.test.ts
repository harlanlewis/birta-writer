/**
 * The multi-block selection cover pass (plugins/headingFold/plugin.ts): the
 * markers of every top-level block a selection spans surface with
 * `heading-fold-marker--covered`, and the pass is INCREMENTAL — a selection
 * change reads only the blocks that entered or left the cover, never the
 * whole cover again (MAR-93). Driven through the real Milkdown editor so the
 * widgets, positions and the plugin's own update() are production's.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { headingFoldPlugin, foldRevealKeymapPlugin } from "../plugins/headingFold";

let editors: Editor[] = [];

async function makeEditor(markdown: string): Promise<EditorView> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(foldRevealKeymapPlugin)
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(headingFoldPlugin)
        .create();
    editors.push(editor);
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Top-level block start offsets, in order. */
function blockOffsets(view: EditorView): number[] {
    const offsets: number[] = [];
    view.state.doc.forEach((_node, offset) => { offsets.push(offset); });
    return offsets;
}

/** Select from inside block `a` to inside block `b` (a text selection spanning both). */
function selectBlocks(view: EditorView, a: number, b: number): void {
    const offsets = blockOffsets(view);
    const from = offsets[a]! + 1;
    const to = offsets[b]! + 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

function coveredCount(view: EditorView): number {
    return view.dom.querySelectorAll(".heading-fold-marker--covered").length;
}

/** Counts the marker lookups the cover pass performs (blockMarkerElements). */
function markerLookupSpy() {
    const spy = vi.spyOn(Element.prototype, "querySelectorAll");
    return {
        count: () => spy.mock.calls.filter(([selector]) => selector === ".heading-fold-marker").length,
        reset: () => spy.mockClear(),
        restore: () => spy.mockRestore(),
    };
}

const EIGHT = Array.from({ length: 8 }, (_, i) => `paragraph ${i}`).join("\n\n");

afterEach(async () => {
    vi.restoreAllMocks();
    for (const e of editors) { await e.destroy(); }
    editors = [];
    document.body.innerHTML = "";
});

describe("selection cover — incremental marker surfacing", () => {
    it("a selection spanning blocks should surface exactly the covered markers", async () => {
        const view = await makeEditor(EIGHT);
        selectBlocks(view, 1, 4);
        expect(coveredCount(view)).toBe(4);
        // Every covered marker belongs to a block inside the cover, in order.
        const covered = Array.from(view.dom.querySelectorAll(".heading-fold-marker--covered"))
            .map((m) => m.closest("p")?.textContent);
        expect(covered).toEqual(["paragraph 1", "paragraph 2", "paragraph 3", "paragraph 4"]);
    });

    it("growing the cover should read only the blocks that entered it", async () => {
        const view = await makeEditor(EIGHT);
        selectBlocks(view, 0, 3); // 4 blocks covered
        const lookups = markerLookupSpy();
        selectBlocks(view, 0, 5); // 2 more
        expect(coveredCount(view)).toBe(6);
        expect(lookups.count()).toBe(2);
        lookups.restore();
    });

    it("shrinking the cover should uncover the dropped blocks with no marker lookup", async () => {
        const view = await makeEditor(EIGHT);
        selectBlocks(view, 0, 5);
        const lookups = markerLookupSpy();
        selectBlocks(view, 0, 2);
        expect(coveredCount(view)).toBe(3);
        expect(lookups.count()).toBe(0);
        lookups.restore();
    });

    it("a selection change inside one block should keep held markers untouched", async () => {
        const view = await makeEditor(EIGHT);
        selectBlocks(view, 0, 4);
        const before = Array.from(view.dom.querySelectorAll(".heading-fold-marker--covered"));
        const removeSpy = vi.spyOn(DOMTokenList.prototype, "remove");
        // Same cover, different head offset within the last block.
        const offsets = blockOffsets(view);
        view.dispatch(view.state.tr.setSelection(
            TextSelection.create(view.state.doc, offsets[0]! + 1, offsets[4]! + 3),
        ));
        expect(removeSpy.mock.calls.filter(([c]) => c === "heading-fold-marker--covered")).toHaveLength(0);
        expect(Array.from(view.dom.querySelectorAll(".heading-fold-marker--covered"))).toEqual(before);
    });

    it("collapsing the selection should uncover everything", async () => {
        const view = await makeEditor(EIGHT);
        selectBlocks(view, 0, 4);
        expect(coveredCount(view)).toBe(5);
        const offsets = blockOffsets(view);
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, offsets[2]! + 1)));
        expect(coveredCount(view)).toBe(0);
    });

    it("a doc change under a live cover should re-read the cover against the new doc", async () => {
        const view = await makeEditor(EIGHT);
        selectBlocks(view, 2, 5);
        expect(coveredCount(view)).toBe(4);
        // Insert a paragraph ABOVE the cover: every covered offset shifts,
        // and the selection maps with it — the same blocks stay covered.
        const para = view.state.schema.nodes["paragraph"]!.create(null, view.state.schema.text("new"));
        view.dispatch(view.state.tr.insert(0, para));
        const covered = Array.from(view.dom.querySelectorAll(".heading-fold-marker--covered"))
            .map((m) => m.closest("p")?.textContent);
        expect(covered).toEqual(["paragraph 2", "paragraph 3", "paragraph 4", "paragraph 5"]);
    });
});
