/**
 * copyMarkdown plugin tests: native copy/cut hand the clipboard's plain-text
 * flavor to clipboardTextSerializer, which serializes the selection slice back
 * to Markdown source (exercised against a REAL editor), gated per copy on
 * birta.copyFormat. acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, editorViewCtx, rootCtx, defaultValueCtx, schemaCtx, serializerCtx } from "@milkdown/core";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { copyMarkdownPlugin, markdownOfSlice } from "../plugins/copyMarkdown";
import { CellSelection, Fragment, Slice, TextSelection } from "../pm";
import type { EditorView, Node as ProseNode } from "../pm";

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(copyMarkdownPlugin)
        .create();
}

/** Runs the view's clipboardTextSerializer over the current selection's slice. */
function clipboardText(v: EditorView): string | undefined {
    const slice = v.state.selection.content();
    return v.someProp("clipboardTextSerializer", (f) => f(slice, v));
}

describe("copyMarkdownPlugin — clipboardTextSerializer", () => {
    let editor: Editor;
    let v: EditorView;

    beforeEach(async () => {
        vi.clearAllMocks();
        window.__i18n = undefined;
        document.body.innerHTML = "";
        editor = await makeEditor("hello **bold** world\n");
        v = editor.action((ctx) => ctx.get(editorViewCtx));
    });

    afterEach(async () => {
        window.__i18n = undefined;
        await editor.destroy();
    });

    it("a formatted selection should yield its markdown source", () => {
        v.dispatch(v.state.tr.setSelection(
            TextSelection.create(v.state.doc, 1, v.state.doc.content.size - 1),
        ));
        expect(clipboardText(v)).toBe("hello **bold** world");
    });

    it("a plain partial selection should yield just that text", () => {
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));
        expect(clipboardText(v)).toBe("hello");
    });

    it("a partial selection inside a heading should not gain the heading marker", async () => {
        await editor.destroy();
        editor = await makeEditor("# Hello World\n");
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));
        expect(clipboardText(v)).toBe("Hello");
    });

    it("a partial selection inside a heading should keep inline marks", async () => {
        await editor.destroy();
        editor = await makeEditor("# Hello **bold** World\n");
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        // Cover "Hello **bold**" — inline markdown survives, the "#" does not.
        const text = v.state.doc.textBetween(0, v.state.doc.content.size, "\n");
        const end = 1 + text.indexOf("bold") + "bold".length;
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, end)));
        expect(clipboardText(v)).toBe("Hello **bold**");
    });

    it("a partial selection inside a list item should not gain the bullet", async () => {
        await editor.destroy();
        editor = await makeEditor("- alpha beta\n- gamma\n");
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        const from = v.state.doc.resolve(3); // inside the first item's paragraph
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from.pos, from.pos + 5)));
        const text = clipboardText(v) ?? "";
        expect(text).not.toContain("-");
        expect(text.length).toBeGreaterThan(0);
    });

    it("a partial selection inside a code block should defer to the plain rendition", async () => {
        await editor.destroy();
        editor = await makeEditor("```js\nconst a = 1;\nconst b = 2;\n```\n");
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 2, 8)));
        // Falsy → ProseMirror's own plain-text default; no fences appear.
        expect(clipboardText(v)).toBeUndefined();
    });

    it("a cross-block selection should keep full block markdown", async () => {
        await editor.destroy();
        editor = await makeEditor("# Title\n\nbody text\n");
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        v.dispatch(v.state.tr.setSelection(
            TextSelection.create(v.state.doc, 1, v.state.doc.content.size - 1),
        ));
        expect(clipboardText(v)).toBe("# Title\n\nbody text");
    });

    it("copyFormat richText should defer to the default plain rendition", () => {
        window.__i18n = { copyFormat: "richText" } as unknown as typeof window.__i18n;
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));
        // Falsy → someProp keeps looking and ProseMirror falls back to its
        // own textBetween default.
        expect(clipboardText(v)).toBeUndefined();
    });

    it("a table cell selection should serialize as a markdown table", async () => {
        await editor.destroy();
        editor = await makeEditor("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        const cellPositions: number[] = [];
        v.state.doc.descendants((node, pos) => {
            if (node.type.name === "table_cell" || node.type.name === "table_header") {
                cellPositions.push(pos);
            }
            return true;
        });
        expect(cellPositions.length).toBeGreaterThanOrEqual(4);
        v.dispatch(v.state.tr.setSelection(new CellSelection(
            v.state.doc.resolve(cellPositions[0]!),
            v.state.doc.resolve(cellPositions.at(-1)!),
        )));
        const text = clipboardText(v) ?? "";
        expect(text).toContain("|");
        expect(text).toContain("A");
        expect(text).toContain("2");
    });
});

describe("markdownOfSlice", () => {
    let editor: Editor;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        editor = await makeEditor("hello\n");
    });

    afterEach(async () => {
        await editor.destroy();
    });

    it("bare inline content should be wrapped in a paragraph", () => {
        editor.action((ctx) => {
            const schema = ctx.get(schemaCtx);
            const serialize = ctx.get(serializerCtx);
            const slice = new Slice(Fragment.from(schema.text("plain words")), 0, 0);
            expect(markdownOfSlice(serialize as (doc: ProseNode) => string, schema, slice)).toBe("plain words");
        });
    });

    it("a serializer failure should fall back to the empty string", () => {
        editor.action((ctx) => {
            const schema = ctx.get(schemaCtx);
            const slice = new Slice(Fragment.from(schema.text("x")), 0, 0);
            const boom = (): string => { throw new Error("boom"); };
            expect(markdownOfSlice(boom, schema, slice)).toBe("");
        });
    });
});
