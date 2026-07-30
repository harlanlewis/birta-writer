/**
 * pasteMarkdown plugin tests: a plain-text paste is parsed as Markdown by
 * clipboardTextParser instead of landing as literal, later-escaped text.
 *
 * Exercised against a REAL editor through ProseMirror's own
 * `__parseFromClipboard`, so the assertions cover the whole paste path — the
 * asText/inCode gates PM applies BEFORE the prop, and the maxOpen/normalize
 * pass it applies after — not just the helper in isolation.
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, editorViewCtx, rootCtx, defaultValueCtx, parserCtx, serializerCtx } from "@milkdown/core";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { markdownSliceFromText, pasteMarkdownPlugin } from "../plugins/pasteMarkdown";
import { pasteTableCellPlugin } from "../plugins/pasteTableCell";
import { parseFromClipboard, Slice, TextSelection } from "../pm";
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
        .use(pasteMarkdownPlugin)
        .use(pasteTableCellPlugin)
        .create();
}

/**
 * Runs a paste the way ProseMirror does: `html` null models a text-only
 * clipboard (a terminal, a raw .md file, a chat box), `plain` models the
 * Shift+Cmd+V modifier.
 */
function pasteSlice(v: EditorView, text: string, opts: { html?: string | null; plain?: boolean } = {}): Slice | null {
    return parseFromClipboard(
        v, text, opts.html ?? null, opts.plain ?? false, v.state.selection.$from,
    );
}

/**
 * Applies a pasted slice the way ProseMirror's own `doPaste` does — a fully
 * closed single node is inserted whole, anything else is merged into the
 * selection — and returns the document's Markdown source.
 */
function pasteAndSerialize(editor: Editor, v: EditorView, text: string, opts?: { html?: string | null; plain?: boolean }): string {
    const slice = pasteSlice(v, text, opts);
    expect(slice).not.toBeNull();
    const s = slice as Slice;
    const single = s.openStart === 0 && s.openEnd === 0 && s.content.childCount === 1
        ? s.content.firstChild
        : null;
    v.dispatch(single ? v.state.tr.replaceSelectionWith(single, false) : v.state.tr.replaceSelection(s));
    return editor.action((ctx) => ctx.get(serializerCtx)(v.state.doc));
}

/** The child node-type names of a node or fragment, for asserting structure. */
function outline(n: { forEach(f: (child: ProseNode) => void): void }): string {
    const names: string[] = [];
    n.forEach((c) => names.push(c.type.name));
    return names.join(",");
}

describe("markdownSliceFromText", () => {
    const parse = (md: string) => (md === "boom" ? (() => { throw new Error("parser blew up"); })() : null);

    it("whitespace-only text should decline so the literal spaces survive", () => {
        expect(markdownSliceFromText(() => null, "   \n  ")).toBeNull();
    });

    it("a parser returning null should decline rather than eat the paste", () => {
        expect(markdownSliceFromText(() => null, "# heading")).toBeNull();
    });

    it("a throwing parser should decline rather than eat the paste", () => {
        expect(markdownSliceFromText(parse, "boom")).toBeNull();
    });
});

describe("pasteMarkdownPlugin — clipboardTextParser", () => {
    let editor: Editor;
    let v: EditorView;

    beforeEach(async () => {
        vi.clearAllMocks();
        window.__i18n = undefined;
        document.body.innerHTML = "";
        editor = await makeEditor("start\n");
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        // Caret at the end of the only paragraph.
        v.dispatch(v.state.tr.setSelection(
            TextSelection.create(v.state.doc, v.state.doc.content.size - 1),
        ));
    });

    afterEach(async () => {
        window.__i18n = undefined;
        await editor.destroy();
    });

    // The reported bug: a whole Markdown document pasted into the editor
    // arrived as paragraphs of escaped literals ("\# User-level instructions")
    // instead of headings.
    it("a pasted Markdown document should become real nodes, not escaped literals", async () => {
        await editor.destroy();
        editor = await makeEditor("");
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        const source = "# Title\n\n## Sub\n\nSome `code` and **bold**.";
        expect(pasteAndSerialize(editor, v, source).trim()).toBe(source);
        expect(outline(v.state.doc)).toBe("heading,heading,paragraph");
    });

    // Pasting mid-prose still merges the FIRST block inline (a heading must not
    // split into the sentence), while every later block keeps its structure.
    it("a pasted document should keep its later blocks when landing mid-prose", () => {
        const md = pasteAndSerialize(editor, v, "# Title\n\n## Sub\n\nbody");
        expect(md).toContain("## Sub");
        expect(md).not.toContain("\\#");
        expect(outline(v.state.doc)).toBe("paragraph,heading,paragraph");
    });

    it("a pasted list should become list nodes", () => {
        pasteAndSerialize(editor, v, "- one\n- two");
        expect(outline(v.state.doc)).toBe("paragraph,bullet_list");
    });

    it("a pasted table should become a table node", () => {
        pasteAndSerialize(editor, v, "| a | b |\n| - | - |\n| 1 | 2 |");
        expect(outline(v.state.doc)).toBe("paragraph,table");
    });

    it("pasted inline syntax mid-paragraph should merge inline, not split the block", () => {
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 6)));
        const md = pasteAndSerialize(editor, v, "some **bold** text");
        expect(md.trim()).toBe("startsome **bold** text");
        expect(outline(v.state.doc)).toBe("paragraph");
    });

    it("text without Markdown syntax should paste unchanged", () => {
        const md = pasteAndSerialize(editor, v, "plain words");
        expect(md.trim()).toBe("startplain words");
    });

    // CommonMark does not treat intraword `_` as emphasis, so identifiers and
    // snake_case survive a Markdown-parsed paste intact.
    it("underscores inside words should stay literal text", () => {
        pasteAndSerialize(editor, v, "foo_bar_baz");
        expect(v.state.doc.textContent).toBe("startfoo_bar_baz");
    });

    // A lone block pasted at a caret INSIDE prose merges inline — pasting
    // "# Title" mid-sentence must not split a heading into the sentence. It
    // becomes a heading when it lands on an empty block (below).
    it("a lone heading pasted into prose should merge as text", () => {
        expect(outline(v.state.doc)).toBe("paragraph");
        pasteAndSerialize(editor, v, "# Title");
        expect(outline(v.state.doc)).toBe("paragraph");
        expect(v.state.doc.textContent).toBe("startTitle");
    });

    it("a lone heading pasted into an empty block should become a heading", async () => {
        await editor.destroy();
        editor = await makeEditor("");
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        const md = pasteAndSerialize(editor, v, "# Title");
        expect(md.trim()).toBe("# Title");
        expect(outline(v.state.doc)).toBe("heading");
    });

    // The two hatches and the default, on one payload whose two readings are
    // unambiguous: "**bold**" is either a strong mark or six literal asterisks
    // the serializer has to escape back out.
    it("the Shift+Cmd+V plain flag should paste literal text instead", () => {
        const md = pasteAndSerialize(editor, v, "**bold**", { plain: true });
        expect(md.trim()).toBe("start\\*\\*bold\\*\\*");
    });

    it("birta.pasteFormat plainText should paste literal text instead", () => {
        window.__i18n = { pasteFormat: "plainText" } as unknown as typeof window.__i18n;
        const md = pasteAndSerialize(editor, v, "**bold**");
        expect(md.trim()).toBe("start\\*\\*bold\\*\\*");
    });

    it("birta.pasteFormat markdown should parse, matching the absent default", () => {
        window.__i18n = { pasteFormat: "markdown" } as unknown as typeof window.__i18n;
        const md = pasteAndSerialize(editor, v, "**bold**");
        expect(md.trim()).toBe("start**bold**");
    });

    // ProseMirror hands a code block its raw text before consulting the prop,
    // so a fence never reinterprets its own payload.
    it("a paste inside a code block should stay raw text", async () => {
        await editor.destroy();
        editor = await makeEditor("```\ncode\n```\n");
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, v.state.doc.content.size - 1)));
        const md = pasteAndSerialize(editor, v, "\n# not a heading");
        expect(md).toContain("# not a heading");
        expect(outline(v.state.doc)).toBe("code_block");
    });

    // A GFM cell is inline-only, so block structure parsed into one cannot
    // round-trip AND cannot be fitted: ProseMirror split the table into three
    // fragments to place a pasted list. Inside a cell only a lone paragraph
    // takes the Markdown path.
    describe("inside a table cell", () => {
        beforeEach(async () => {
            await editor.destroy();
            editor = await makeEditor("| a | b |\n| - | - |\n| 1 | 2 |\n");
            v = editor.action((ctx) => ctx.get(editorViewCtx));
            let cell = 1;
            v.state.doc.descendants((n, p) => {
                if (cell === 1 && n.isTextblock) { cell = p + 1; return false; }
                return true;
            });
            v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, cell)));
        });

        it("inline syntax should still parse into the cell", () => {
            const md = pasteAndSerialize(editor, v, "**bold**");
            expect(md).toContain("| **bold**a | b |");
            expect(outline(v.state.doc)).toBe("table");
        });

        // MAR-274: a list cannot live in a GFM cell, so it lands as the cell's
        // lines joined by hard breaks (`<br>`) — the table keeps its shape.
        it("a pasted list should flatten into the one cell, not split the table", () => {
            const md = pasteAndSerialize(editor, v, "- one\n- two");
            expect(md).toBe("| one<br>twoa | b |\n|---|---|\n| 1 | 2 |\n");
            expect(outline(v.state.doc)).toBe("table");
        });

        it("a pasted table should flatten into the one cell, not nest or widen", () => {
            const md = pasteAndSerialize(editor, v, "| x | y |\n| - | - |\n| 9 | 8 |");
            expect(md).toBe("| x<br>y<br>9<br>8a | b |\n|---|---|\n| 1 | 2 |\n");
            expect(outline(v.state.doc)).toBe("table");
        });

        // The literal path had its own, milder version of the same bug: PM
        // splits clipboard text into one paragraph per line, and each became a
        // CELL — two pasted lines widened a 2-column table to 5.
        it("a literal (shift) paste should flatten too, not widen the table", () => {
            // The markers survive as literal text (a leading "-" inside a cell
            // is not a list marker, so it needs no escape).
            const md = pasteAndSerialize(editor, v, "- one\n- two", { plain: true });
            expect(md).toBe("| - one<br>- twoa | b |\n|---|---|\n| 1 | 2 |\n");
            expect(outline(v.state.doc)).toBe("table");
        });

        it("a rich-HTML paste should flatten too", () => {
            const md = pasteAndSerialize(editor, v, "", { html: "<ul><li>one</li><li>two</li></ul>" });
            expect(md).toBe("| one<br>twoa | b |\n|---|---|\n| 1 | 2 |\n");
            expect(outline(v.state.doc)).toBe("table");
        });
    });

    // A rich clipboard already carries structure; PM takes the DOM path and
    // never asks us, so pasting from a browser is unaffected.
    it("a clipboard carrying HTML should take the DOM path, not the Markdown one", () => {
        const slice = pasteSlice(v, "# Title", { html: "<p>Title</p>" });
        expect(slice?.content.firstChild?.type.name).toBe("paragraph");
    });

    // The asymmetry this plugin closes: copyMarkdown puts Markdown source on
    // the plain-text flavor, so the editor must be able to read its own copy
    // back (e.g. after a hop through vscode.env.clipboard drops the rich one).
    it("the document's own copied Markdown should paste back as the same nodes", async () => {
        await editor.destroy();
        editor = await makeEditor("# Hello\n\n- a\n- b\n");
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        const source = editor.action((ctx) => ctx.get(serializerCtx)(v.state.doc));
        const slice = markdownSliceFromText(editor.action((ctx) => ctx.get(parserCtx)), source);
        expect(outline(slice!.content)).toBe(outline(v.state.doc));
    });
});
