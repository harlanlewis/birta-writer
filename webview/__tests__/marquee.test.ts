/**
 * Tests for marquee block selection (MAR-82 v1): the commit math and the
 * geometry helpers' folded-block handling. The pointer session itself needs
 * real layout and lives in e2e/blockDrag.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import type { EditorView } from "@milkdown/prose/view";
import { configureSerialization, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";
import { commitMarqueeSelection } from "../components/blockMenu/marquee";

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
    it("a run of text blocks commits a selection spanning them", async () => {
        const editor = await makeEditor("Alpha\n\nBeta\n\nGamma");
        const v = view(editor);
        let betaEnd = -1;
        v.state.doc.forEach((node, offset) => {
            if (node.textContent === "Beta") betaEnd = offset + node.nodeSize;
        });
        expect(commitMarqueeSelection(v, { from: 0, to: betaEnd })).toBe(true);
        const sel = v.state.selection;
        expect(sel.empty).toBe(false);
        expect(v.state.doc.textBetween(sel.from, sel.to, " ")).toBe("Alpha Beta");
    });

    it("a leaf-edged run (ending at an HR) shrinks to its text — documented v1 limit", async () => {
        const editor = await makeEditor("alpha\n\n---\n\nomega");
        const v = view(editor);
        let hrEnd = -1;
        v.state.doc.forEach((node, offset) => {
            if (node.type.name === "hr") hrEnd = offset + node.nodeSize;
        });
        expect(commitMarqueeSelection(v, { from: 0, to: hrEnd })).toBe(true);
        // The selection holds the text it can (alpha); the caller reconciles
        // the tint against the REAL cover so the UI never overstates it.
        expect(v.state.doc.textBetween(v.state.selection.from, v.state.selection.to, " ")).toBe("alpha");
    });

    it("a leaf-ONLY run (just an HR) commits nothing — no caret teleport", async () => {
        const editor = await makeEditor("alpha\n\n---\n\nomega");
        const v = view(editor);
        const before = v.state.selection;
        let hrFrom = -1;
        let hrEnd = -1;
        v.state.doc.forEach((node, offset) => {
            if (node.type.name === "hr") {
                hrFrom = offset;
                hrEnd = offset + node.nodeSize;
            }
        });
        expect(commitMarqueeSelection(v, { from: hrFrom, to: hrEnd })).toBe(false);
        expect(v.state.selection.eq(before)).toBe(true);
    });
});
