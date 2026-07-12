/**
 * Tests for Tab-indent on list items with nested children: the item sinks
 * ALONE and its children keep their absolute depth (sinkItemKeepingChildren);
 * plain items still use stock sinkListItem. Shift-Tab (preset liftListItem)
 * is the inverse and is exercised as a round-trip.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, schemaCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { TextSelection } from "@milkdown/prose/state";
import { liftListItem } from "@milkdown/prose/schema-list";
import type { EditorView } from "@milkdown/prose/view";
import type { NodeType } from "@milkdown/prose/model";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, pureCommonmark } from "../serialization";
import { sinkItemKeepingChildren } from "../plugins/tabKeymap";

let editors: Editor[] = [];

async function makeEditor(markdown: string): Promise<{ view: EditorView; itemType: NodeType; editor: Editor }> {
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
        .create();
    editors.push(editor);
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    const itemType = editor.action((ctx) => ctx.get(schemaCtx)).nodes["list_item"]!;
    return { view, itemType, editor };
}

function markdownOf(editor: Editor): string {
    return editor.action(getMarkdown()).trimEnd();
}

/** Caret inside the paragraph whose text is `text`. */
function placeCaretIn(view: EditorView, text: string): void {
    let pos = -1;
    view.state.doc.descendants((node, nodePos) => {
        if (node.isTextblock && node.textContent === text) pos = nodePos + 1;
        return pos === -1;
    });
    expect(pos).toBeGreaterThan(-1);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

describe("sinkItemKeepingChildren", () => {
    it("an item with a sublist should sink alone — children keep their depth", async () => {
        const { view, itemType, editor } = await makeEditor(
            "1. first step\n2. second step\n   1. sub1\n   2. sub2",
        );
        placeCaretIn(view, "second step");
        expect(sinkItemKeepingChildren(itemType)(view.state, view.dispatch)).toBe(true);
        expect(markdownOf(editor)).toBe(
            "1. first step\n   1. second step\n   2. sub1\n   3. sub2",
        );
    });

    it("the caret should stay in the sunk item's text", async () => {
        const { view, itemType } = await makeEditor(
            "1. first step\n2. second step\n   1. sub1",
        );
        placeCaretIn(view, "second step");
        sinkItemKeepingChildren(itemType)(view.state, view.dispatch);
        expect(view.state.selection.$from.parent.textContent).toBe("second step");
    });

    it("should merge into the previous sibling's existing sublist", async () => {
        const { view, itemType, editor } = await makeEditor(
            "- first\n  - already nested\n- second\n  - child",
        );
        placeCaretIn(view, "second");
        expect(sinkItemKeepingChildren(itemType)(view.state, view.dispatch)).toBe(true);
        expect(markdownOf(editor)).toBe(
            "- first\n  - already nested\n  - second\n  - child",
        );
    });

    it("an item WITHOUT a sublist should return false (stock sink applies)", async () => {
        const { view, itemType } = await makeEditor("- first\n- second");
        placeCaretIn(view, "second");
        expect(sinkItemKeepingChildren(itemType)(view.state, view.dispatch)).toBe(false);
    });

    it("the FIRST item (nothing to sink under) should consume without change", async () => {
        const { view, itemType, editor } = await makeEditor(
            "1. first\n   1. sub\n2. second",
        );
        const before = markdownOf(editor);
        placeCaretIn(view, "first");
        expect(sinkItemKeepingChildren(itemType)(view.state, view.dispatch)).toBe(true);
        expect(markdownOf(editor)).toBe(before);
    });

    it("outside a list should return false", async () => {
        const { view, itemType } = await makeEditor("plain paragraph");
        placeCaretIn(view, "plain paragraph");
        expect(sinkItemKeepingChildren(itemType)(view.state, view.dispatch)).toBe(false);
    });

    it("Shift-Tab (liftListItem) should be the exact inverse", async () => {
        const { view, itemType, editor } = await makeEditor(
            "1. first step\n2. second step\n   1. sub1\n   2. sub2",
        );
        const before = markdownOf(editor);
        placeCaretIn(view, "second step");
        sinkItemKeepingChildren(itemType)(view.state, view.dispatch);
        // Lift the (now nested) "second step" back out: its following
        // siblings become its children again.
        liftListItem(itemType)(view.state, view.dispatch);
        expect(markdownOf(editor)).toBe(before);
    });

    it("a task item should keep its checked state through the sink", async () => {
        const { view, itemType, editor } = await makeEditor(
            "- [ ] first\n- [x] second\n  - [ ] sub",
        );
        placeCaretIn(view, "second");
        expect(sinkItemKeepingChildren(itemType)(view.state, view.dispatch)).toBe(true);
        expect(markdownOf(editor)).toBe(
            "- [ ] first\n  - [x] second\n  - [ ] sub",
        );
    });
});
