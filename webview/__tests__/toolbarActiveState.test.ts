/**
 * computeToolbarActiveState against the REAL Milkdown schema — this both tests
 * the derivation and pins the actual node/mark names (strong, emphasis,
 * strike_through, highlight, callout.kind, code_block.language, table_cell) the
 * toolbar reflects. Drives real editors so a schema rename can't pass silently.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, commandsCtx } from "@milkdown/core";
import { toggleStrongCommand, toggleEmphasisCommand } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { Selection, TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { configureSerialization, pureCommonmark } from "../serialization";
import { insertCalloutCommand } from "../plugins/callouts";
import { computeToolbarActiveState } from "../components/toolbar/activeState";

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
        .use(gfm)
        .use(insertCalloutCommand)
        .create();
    editors.push(editor);
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function caretInText(editor: Editor, text: string): void {
    const v = view(editor);
    let pos = -1;
    v.state.doc.descendants((n, p) => {
        if (pos < 0 && n.isText && (n.text ?? "").includes(text)) { pos = p; }
    });
    if (pos < 0) { throw new Error(`text not found: ${text}`); }
    v.dispatch(v.state.tr.setSelection(Selection.near(v.state.doc.resolve(pos + 1))));
}

const stateOf = (editor: Editor) => computeToolbarActiveState(view(editor).state);

afterEach(async () => {
    for (const editor of editors) { await editor.destroy(); }
    editors = [];
});

describe("computeToolbarActiveState", () => {
    it("a plain paragraph should report P, no marks, no container", async () => {
        const editor = await makeEditor("hello world");
        caretInText(editor, "hello");
        const s = stateOf(editor);
        expect(s.headingLevel).toBe(0);
        expect(s.formatApplicable).toBe(true);
        expect(s.list).toBeNull();
        expect(s.quote).toBeNull();
        expect(s.code).toBeNull();
        expect(s.inTable).toBe(false);
        expect(Object.values(s.marks).every((v) => v === false)).toBe(true);
    });

    it("a caret in a heading should report its level", async () => {
        const editor = await makeEditor("### Title");
        caretInText(editor, "Title");
        expect(stateOf(editor).headingLevel).toBe(3);
    });

    it("selecting bold text should report bold active", async () => {
        const editor = await makeEditor("**strong** plain");
        const v = view(editor);
        let from = -1;
        v.state.doc.descendants((n, p) => {
            if (from < 0 && n.isText && (n.text ?? "").includes("strong")) { from = p; }
        });
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from + 1, from + 4)));
        const s = stateOf(editor);
        expect(s.marks.bold).toBe(true);
        expect(s.marks.italic).toBe(false);
    });

    it("a caret whose stored marks include a toggled mark should report it", async () => {
        const editor = await makeEditor("word");
        caretInText(editor, "word");
        editor.action((ctx) => ctx.get(commandsCtx).call(toggleStrongCommand.key as never));
        editor.action((ctx) => ctx.get(commandsCtx).call(toggleEmphasisCommand.key as never));
        // With a collapsed selection these set stored marks for the next input.
        const s = stateOf(editor);
        expect(s.marks.bold).toBe(true);
        expect(s.marks.italic).toBe(true);
    });

    it("a caret in a bullet list should report list='bullet'", async () => {
        const editor = await makeEditor("- one\n- two");
        caretInText(editor, "one");
        expect(stateOf(editor).list).toBe("bullet");
    });

    it("a caret in a task list should report list='task'", async () => {
        const editor = await makeEditor("- [ ] todo");
        caretInText(editor, "todo");
        expect(stateOf(editor).list).toBe("task");
    });

    it("a caret in a blockquote should report quote='blockquote'", async () => {
        const editor = await makeEditor("> quoted");
        caretInText(editor, "quoted");
        expect(stateOf(editor).quote).toBe("blockquote");
    });

    it("a caret in a callout should report its kind", async () => {
        const editor = await makeEditor("> [!WARNING]\n> heads up");
        caretInText(editor, "heads up");
        expect(stateOf(editor).quote).toBe("warning");
    });

    it("a caret in a mermaid code block should report code='mermaid' and not-applicable format", async () => {
        const editor = await makeEditor("```mermaid\ngraph TD\n```");
        caretInText(editor, "graph");
        const s = stateOf(editor);
        expect(s.code).toBe("mermaid");
        expect(s.headingLevel).toBe(-1);
        expect(s.formatApplicable).toBe(false);
    });

    it("a caret in a plain code block should report code='code'", async () => {
        const editor = await makeEditor("```js\nconst x = 1;\n```");
        caretInText(editor, "const");
        expect(stateOf(editor).code).toBe("code");
    });

    it("a caret in a table cell should report inTable and not-applicable format", async () => {
        const editor = await makeEditor("| a | b |\n| - | - |\n| c | d |");
        caretInText(editor, "c");
        const s = stateOf(editor);
        expect(s.inTable).toBe(true);
        expect(s.formatApplicable).toBe(false);
    });
});
