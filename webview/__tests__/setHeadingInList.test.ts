/**
 * Heading commands applied inside a list. A heading cannot be a list item's
 * required first child (list_item content is `paragraph block*`), so choosing a
 * heading on a list line must lift the line out of every enclosing list and
 * promote it to a top-level heading (splitting the surrounding list) — the
 * Notion/Obsidian behavior. Paragraph ("P") stays a no-op on a list line, since
 * a list item's content is already a paragraph. Drives the REAL Milkdown editor
 * through the shared command registry so every surface (toolbar / palette /
 * slash) gets the same behavior.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { Selection, TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { listLiftPlugin, listEnterPlugin, listSpreadNormalizePlugin } from "../plugins";
import { runEditorCommand } from "../editorCommands";

let editors: Editor[] = [];

async function makeEditor(md: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, md);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(listLiftPlugin)
        .use(listEnterPlugin)
        .use(listSpreadNormalizePlugin)
        .create();
    editors.push(editor);
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Put the caret just inside the first text node whose content equals `text`. */
function caretInText(editor: Editor, text: string): void {
    const v = view(editor);
    let pos = -1;
    v.state.doc.descendants((n, p) => {
        if (pos < 0 && n.isText && n.text === text) { pos = p; }
    });
    if (pos < 0) { throw new Error(`text not found: ${text}`); }
    v.dispatch(v.state.tr.setSelection(Selection.near(v.state.doc.resolve(pos + 1))));
}

const md = (editor: Editor): string => editor.action(getMarkdown()).trim();

afterEach(async () => {
    for (const editor of editors) { await editor.destroy(); }
    editors = [];
});

describe("heading commands inside a list", () => {
    it("a heading on a middle list item should split the list and promote that line", async () => {
        const editor = await makeEditor("- one\n- two\n- three");
        caretInText(editor, "two");
        runEditorCommand("setHeading1", () => editor);
        expect(md(editor)).toBe("- one\n\n# two\n\n- three");
    });

    it("a heading on a nested list item should lift all the way out to a top-level heading", async () => {
        const editor = await makeEditor("- a\n  - b\n  - c");
        caretInText(editor, "b");
        runEditorCommand("setHeading2", () => editor);
        // 'b' leaves both list levels and becomes a top-level H2; the outer list
        // keeps 'a', the remaining nested 'c' stays under it.
        const out = md(editor);
        expect(out).toContain("## b");
        expect(view(editor).state.doc.nodeAt(view(editor).state.selection.from - 1)?.type.name).not.toBe("list_item");
    });

    it("a heading on a task-list item should promote it out of the task list", async () => {
        const editor = await makeEditor("- [ ] todo\n- [x] done");
        caretInText(editor, "todo");
        runEditorCommand("setHeading3", () => editor);
        const out = md(editor);
        expect(out).toContain("### todo");
        expect(out).toContain("- [x] done");
    });

    it("a heading on a list nested in a blockquote should stay inside the blockquote", async () => {
        // liftListItem lifts out of the LIST only, not the blockquote — a heading
        // is valid blockquote content, so it must remain quoted.
        const editor = await makeEditor("> - a\n> - b");
        caretInText(editor, "a");
        runEditorCommand("setHeading1", () => editor);
        expect(md(editor)).toBe("> # a\n>\n> - b");
    });

    it("an ordered list should split and renumber around the promoted line", async () => {
        const editor = await makeEditor("1. one\n2. two\n3. three");
        caretInText(editor, "two");
        runEditorCommand("setHeading2", () => editor);
        // Splitting an ordered list necessarily restarts the tail's numbering.
        expect(md(editor)).toBe("1. one\n\n## two\n\n1. three");
    });

    it("a heading on a top-level paragraph should behave normally", async () => {
        const editor = await makeEditor("plain paragraph");
        caretInText(editor, "plain paragraph");
        runEditorCommand("setHeading1", () => editor);
        expect(md(editor)).toBe("# plain paragraph");
    });

    it("a single-item list should promote cleanly", async () => {
        const editor = await makeEditor("- solo");
        caretInText(editor, "solo");
        runEditorCommand("setHeading2", () => editor);
        expect(md(editor)).toBe("## solo");
    });

    it("Paragraph on a list line should be a no-op (still a list item)", async () => {
        const editor = await makeEditor("- one\n- two");
        caretInText(editor, "two");
        runEditorCommand("setParagraph", () => editor);
        expect(md(editor)).toBe("- one\n- two");
    });

    it("Paragraph on a heading should convert it to a paragraph", async () => {
        const editor = await makeEditor("## Heading");
        caretInText(editor, "Heading");
        runEditorCommand("setParagraph", () => editor);
        expect(md(editor)).toBe("Heading");
    });

    it("a selection spanning several list items should promote each selected line", async () => {
        const editor = await makeEditor("- one\n- two\n- three");
        const v = view(editor);
        let p1 = -1;
        let p2 = -1;
        v.state.doc.descendants((n, p) => {
            if (n.isText && n.text === "one") { p1 = p; }
            if (n.isText && n.text === "two") { p2 = p; }
        });
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, p1 + 1, p2 + 2)));
        runEditorCommand("setHeading1", () => editor);
        // Both selected lines become headings; the unselected 'three' stays a list.
        expect(md(editor)).toBe("# one\n\n# two\n\n- three");
    });

    it("the promoted line should round-trip as a heading after reload", async () => {
        const editor = await makeEditor("- one\n- two\n- three");
        caretInText(editor, "two");
        runEditorCommand("setHeading1", () => editor);
        const out = md(editor);
        // Re-parse the produced markdown to confirm it is stable.
        const reloaded = await makeEditor(out);
        expect(md(reloaded)).toBe(out);
    });
});
