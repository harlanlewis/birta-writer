/**
 * Tests for marquee block selection (MAR-82): the commit math (now a real
 * BlockRangeSelection — leaf blocks participate). The pointer session
 * itself needs real layout and lives in e2e/blockDrag.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import type { EditorView } from "@milkdown/prose/view";
import { configureSerialization, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";
import { commitMarqueeSelection } from "../components/blockMenu/marquee";
import { BlockRangeSelection } from "../plugins/blockRange";

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

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

describe("commitMarqueeSelection", () => {
    it("a run of text blocks commits a block range spanning them", async () => {
        const editor = await makeEditor("Alpha\n\nBeta\n\nGamma");
        const v = view(editor);
        let betaEnd = -1;
        v.state.doc.forEach((node, offset) => {
            if (node.textContent === "Beta") betaEnd = offset + node.nodeSize;
        });
        expect(commitMarqueeSelection(v, { from: 0, to: betaEnd })).toBe(true);
        const sel = v.state.selection;
        expect(sel).toBeInstanceOf(BlockRangeSelection);
        expect(sel.from).toBe(0);
        expect(sel.to).toBe(betaEnd);
        expect(v.state.doc.textBetween(sel.from, sel.to, " ")).toBe("Alpha Beta");
    });

    it("a leaf-edged run (ending at an HR) keeps the HR in the selection", async () => {
        const editor = await makeEditor("alpha\n\n---\n\nomega");
        const v = view(editor);
        let hrEnd = -1;
        v.state.doc.forEach((node, offset) => {
            if (node.type.name === "hr") hrEnd = offset + node.nodeSize;
        });
        expect(commitMarqueeSelection(v, { from: 0, to: hrEnd })).toBe(true);
        const sel = v.state.selection;
        expect(sel).toBeInstanceOf(BlockRangeSelection);
        expect(sel.from).toBe(0);
        expect(sel.to).toBe(hrEnd);
        // Two whole blocks in the slice: alpha AND the hr.
        expect(sel.content().content.childCount).toBe(2);
    });

    it("a leaf-ONLY run (just an HR) is a real selection now", async () => {
        const editor = await makeEditor("alpha\n\n---\n\nomega");
        const v = view(editor);
        let hrFrom = -1;
        let hrEnd = -1;
        v.state.doc.forEach((node, offset) => {
            if (node.type.name === "hr") {
                hrFrom = offset;
                hrEnd = offset + node.nodeSize;
            }
        });
        expect(commitMarqueeSelection(v, { from: hrFrom, to: hrEnd })).toBe(true);
        const sel = v.state.selection;
        expect(sel).toBeInstanceOf(BlockRangeSelection);
        expect(sel.from).toBe(hrFrom);
        expect(sel.to).toBe(hrEnd);
    });

    it("an empty range (no blocks) commits nothing", async () => {
        const editor = await makeEditor("alpha");
        const v = view(editor);
        const before = v.state.selection;
        const end = v.state.doc.content.size;
        expect(commitMarqueeSelection(v, { from: end, to: end })).toBe(false);
        expect(v.state.selection.eq(before)).toBe(true);
    });
});
