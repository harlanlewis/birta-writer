/**
 * editing/listMerge — the shared merge probes and the merge command, against
 * the REAL Milkdown editor. These are the primitives every merge surface
 * rides (auto-join, block menu rows, caret advisory): where a mergeable
 * boundary is, when the caret advisory may fire, and that the command joins
 * as one step while refusing stale/invalid boundaries.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import type { Node as ProseNode } from "../pm";
import { TextSelection } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    caretMergeBoundary,
    isSameTypeListBoundary,
    mergeableListBoundary,
    mergeListsAt,
} from "../editing/listMerge";

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
        .use(gfmFidelity)
        .create();
    editors.push(editor);
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Doc position of the `index`-th top-level node. */
function topLevelPos(v: EditorView, index: number): number {
    let pos = -1;
    let i = 0;
    v.state.doc.forEach((_child: ProseNode, offset: number) => {
        if (i === index) {
            pos = offset;
        }
        i++;
    });
    expect(pos).toBeGreaterThanOrEqual(0);
    return pos;
}

/** Places the caret at the start of the text in the item at `path`. */
function placeCaretInItem(v: EditorView, listIndex: number, itemIndex: number): void {
    const listPos = topLevelPos(v, listIndex);
    const list = v.state.doc.nodeAt(listPos)!;
    let itemPos = listPos + 1;
    for (let i = 0; i < itemIndex; i++) {
        itemPos += list.child(i).nodeSize;
    }
    // +2: into the item, into its first paragraph.
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, itemPos + 2)));
}

beforeEach(() => {
    document.body.innerHTML = "";
});

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
});

// A marker-change source: two sibling bullet lists with a boundary between.
const SPLIT = "- foo\n- bar\n\n* bingo\n* wingo\n";

describe("isSameTypeListBoundary", () => {
    it("the point between two sibling bullet lists should be a boundary", async () => {
        const v = view(await makeEditor(SPLIT));
        const secondListPos = topLevelPos(v, 1);
        expect(isSameTypeListBoundary(v.state.doc, secondListPos)).toBe(true);
    });

    it("a bullet/ordered adjacency should NOT be a boundary", async () => {
        // No separator parses bullet-then-ordered as adjacent siblings.
        const v = view(await makeEditor("- foo\n\n1. one\n"));
        expect(isSameTypeListBoundary(v.state.doc, topLevelPos(v, 1))).toBe(false);
    });

    it("out-of-range positions should be false, never a throw", async () => {
        const v = view(await makeEditor(SPLIT));
        expect(isSameTypeListBoundary(v.state.doc, -1)).toBe(false);
        expect(isSameTypeListBoundary(v.state.doc, v.state.doc.content.size + 5)).toBe(false);
    });
});

describe("mergeableListBoundary", () => {
    it("the lower list should see the boundary above; the upper below", async () => {
        const v = view(await makeEditor(SPLIT));
        const upper = topLevelPos(v, 0);
        const lower = topLevelPos(v, 1);
        expect(mergeableListBoundary(v.state.doc, lower, -1)).toBe(lower);
        expect(mergeableListBoundary(v.state.doc, upper, 1)).toBe(lower);
    });

    it("directions with no same-type neighbor should be null", async () => {
        const v = view(await makeEditor(SPLIT));
        expect(mergeableListBoundary(v.state.doc, topLevelPos(v, 0), -1)).toBeNull();
        expect(mergeableListBoundary(v.state.doc, topLevelPos(v, 1), 1)).toBeNull();
    });

    it("a paragraph between the lists should yield null both ways", async () => {
        const v = view(await makeEditor("- foo\n\nbetween\n\n- bar\n"));
        expect(mergeableListBoundary(v.state.doc, topLevelPos(v, 0), 1)).toBeNull();
        expect(mergeableListBoundary(v.state.doc, topLevelPos(v, 2), -1)).toBeNull();
    });

    it("a non-list position should yield null", async () => {
        const v = view(await makeEditor("plain\n\n- foo\n"));
        expect(mergeableListBoundary(v.state.doc, topLevelPos(v, 0), 1)).toBeNull();
    });
});

describe("caretMergeBoundary", () => {
    it("caret in the FIRST item of the lower list should find the boundary", async () => {
        const v = view(await makeEditor(SPLIT));
        placeCaretInItem(v, 1, 0);
        expect(caretMergeBoundary(v.state)).toBe(topLevelPos(v, 1));
    });

    it("caret in a LATER item of the lower list should be null", async () => {
        const v = view(await makeEditor(SPLIT));
        placeCaretInItem(v, 1, 1);
        expect(caretMergeBoundary(v.state)).toBeNull();
    });

    it("caret in the upper list should be null", async () => {
        const v = view(await makeEditor(SPLIT));
        placeCaretInItem(v, 0, 0);
        expect(caretMergeBoundary(v.state)).toBeNull();
    });

    it("caret in a lone list should be null", async () => {
        const v = view(await makeEditor("- foo\n- bar\n"));
        placeCaretInItem(v, 0, 0);
        expect(caretMergeBoundary(v.state)).toBeNull();
    });

    it("a non-empty selection should be null", async () => {
        const v = view(await makeEditor(SPLIT));
        placeCaretInItem(v, 1, 0);
        const from = v.state.selection.from;
        v.dispatch(
            v.state.tr.setSelection(TextSelection.create(v.state.doc, from, from + 2)),
        );
        expect(caretMergeBoundary(v.state)).toBeNull();
    });
});

describe("mergeListsAt", () => {
    it("should join the two lists into one and drop the marker alternation", async () => {
        const editor = await makeEditor(SPLIT);
        const v = view(editor);
        const boundary = topLevelPos(v, 1);

        expect(mergeListsAt(v, boundary)).toBe(true);

        expect(v.state.doc.childCount).toBe(1);
        expect(v.state.doc.child(0).type.name).toBe("bullet_list");
        expect(v.state.doc.child(0).childCount).toBe(4);
        expect(editor.action(getMarkdown())).toBe("- foo\n- bar\n- bingo\n- wingo\n");
    });

    it("a position that is not a list boundary should refuse and change nothing", async () => {
        const editor = await makeEditor("- foo\n\nbetween\n\n- bar\n");
        const v = view(editor);
        const before = v.state.doc;

        expect(mergeListsAt(v, topLevelPos(v, 1))).toBe(false);
        expect(v.state.doc.eq(before)).toBe(true);
    });
});
