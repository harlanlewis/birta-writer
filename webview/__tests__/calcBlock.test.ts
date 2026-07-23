/**
 * Calc code-block preview (MAR-196) driving the REAL code-block NodeView: a
 * ```calc fence renders a two-column ledger (source line + computed value)
 * under one shared, top-to-bottom scope, and re-renders live as the source
 * changes. The pure per-line engine is covered in calc.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfmFidelity } from "../serialization";
import type { EditorView } from "../pm";
import type { Node as PMNode } from "../pm";
import { createCodeBlockView } from "../components/codeBlock";

let editors: Editor[] = [];

type CodeBlockNodeView = ReturnType<typeof createCodeBlockView>;

async function makeCodeBlockView(
    md: string,
): Promise<{ nv: CodeBlockNodeView; view: EditorView; getPos: () => number }> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, md);
        })
        .use(commonmark)
        .use(gfmFidelity)
        .create();
    editors.push(editor);

    let view!: EditorView;
    let node: PMNode | null = null;
    let pos = -1;
    editor.action((ctx) => {
        view = ctx.get(editorViewCtx);
        view.state.doc.descendants((n, p) => {
            if (n.type.name === "code_block") { node = n; pos = p; return false; }
            return true;
        });
    });
    expect(node).not.toBeNull();
    const nv = createCodeBlockView(node!, view, () => pos);
    return { nv, view, getPos: () => pos };
}

const wait = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Rows of the calc preview as `src|result` strings. */
function ledger(nv: CodeBlockNodeView): string[] {
    return Array.from(nv.dom.querySelectorAll(".calc-row")).map((row) => {
        const src = row.querySelector(".calc-row-src")?.textContent ?? "";
        const res = row.querySelector(".calc-row-result")?.textContent ?? "";
        return `${src}|${res}`;
    });
}

describe("calc code-block preview", () => {
    beforeEach(() => { document.body.innerHTML = ""; delete window.__i18n; });
    afterEach(async () => {
        for (const e of editors) { await e.destroy(); }
        editors = [];
    });

    it("a ```calc block should render a ledger of source lines and results", async () => {
        const { nv } = await makeCodeBlockView(
            "```calc\nbudget = 5000\nrent = 1800\nbudget - rent\n```\n",
        );
        await wait(); // the mount render is deferred a macrotask (like mermaid/latex)
        expect(ledger(nv)).toEqual([
            "budget = 5000|",       // bare literal — no echoed value
            "rent = 1800|",
            "budget - rent|3200",
        ]);
    });

    it("a non-calc code block should not render a calc ledger", async () => {
        const { nv } = await makeCodeBlockView("```js\nconst x = 1\n```\n");
        await wait();
        expect(nv.dom.querySelectorAll(".calc-row")).toHaveLength(0);
    });

    it("editing the source should re-render the results live", async () => {
        const { nv, view, getPos } = await makeCodeBlockView(
            "```calc\nx = 2\nx * 10\n```\n",
        );
        await wait();
        expect(ledger(nv)).toEqual(["x = 2|", "x * 10|20"]);

        // Change `x = 2` to `x = 3` in the document and feed the updated node to
        // the NodeView, exactly as ProseMirror would on an edit.
        const pos = getPos();
        const codeStart = pos + 1; // first char inside the code_block content
        view.dispatch(view.state.tr.insertText("3", codeStart + 4, codeStart + 5));
        nv.update(view.state.doc.nodeAt(pos)!);
        await wait(200); // past the 150ms live-recompute debounce

        expect(ledger(nv)).toEqual(["x = 3|", "x * 10|30"]);
    });
});
