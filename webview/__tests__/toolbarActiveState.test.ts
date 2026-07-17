/**
 * computeToolbarActiveState against the REAL Milkdown schema — this both tests
 * the derivation and pins the actual node/mark names (strong, emphasis,
 * strike_through, highlight, callout.kind, code_block.language, table_cell) the
 * toolbar reflects. Drives real editors so a schema rename can't pass silently.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, commandsCtx } from "@milkdown/core";
import { toggleStrongCommand, toggleEmphasisCommand } from "@milkdown/preset-commonmark";
import { Selection, TextSelection, NodeSelection } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { insertCalloutCommand } from "../plugins/callouts";
import { mathPlugin } from "../plugins/math";
import { wikiLinksPlugin } from "../plugins/wikiLinks";
import { referenceLinksPlugin } from "../plugins/referenceLinks";
import {
    computeToolbarActiveState,
    DETACHED_STATE,
} from "../components/toolbar/activeState";

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
        .use(insertCalloutCommand)
        // The atom nodes the bar reflects off a NodeSelection live in these
        // plugins — include them so the schema carries wiki_link / math_inline /
        // link_ref, and the derivation is pinned against the REAL node names.
        .use(mathPlugin)
        .use(wikiLinksPlugin)
        .use(referenceLinksPlugin)
        .create();
    editors.push(editor);
    return editor;
}

/** Node-select the first node of the given type (what clicking an atom does). */
function nodeSelect(editor: Editor, typeName: string): void {
    const v = view(editor);
    let pos = -1;
    v.state.doc.descendants((n, p) => {
        if (pos < 0 && n.type.name === typeName) { pos = p; }
    });
    if (pos < 0) { throw new Error(`node not found: ${typeName}`); }
    v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, pos)));
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

    // ── Inline atoms and node selections ──
    // Wikilinks and inline math are inline ATOMS (not marks): arrowing onto one, or
    // clicking it, node-selects the whole node — a rangeHasMark probe can't see them.

    it("a selected inline-math atom should report inlineMath, no marks, N/A format", async () => {
        const editor = await makeEditor("before $a^2+b^2$ after");
        nodeSelect(editor, "math_inline");
        const s = stateOf(editor);
        expect(s.inlineMath).toBe(true);
        expect(s.wikiLink).toBe(false);
        expect(s.imageSelected).toBe(false);
        // An atom isn't a heading-capable textblock — format greys out like a table cell.
        expect(s.formatApplicable).toBe(false);
        expect(Object.values(s.marks).every((v) => v === false)).toBe(true);
    });

    it("a selected wikilink atom should report wikiLink (the Link button reflects it)", async () => {
        const editor = await makeEditor("see [[Some Page]] here");
        nodeSelect(editor, "wiki_link");
        const s = stateOf(editor);
        expect(s.wikiLink).toBe(true);
        expect(s.inlineMath).toBe(false);
        // wikiLink is a node, not a mark — marks.link stays false (index.ts ORs the two).
        expect(s.marks.link).toBe(false);
        expect(s.formatApplicable).toBe(false);
    });

    it("a selected image should report imageSelected and not-applicable format", async () => {
        const editor = await makeEditor("![alt](https://example.com/x.png)");
        nodeSelect(editor, "image");
        const s = stateOf(editor);
        expect(s.imageSelected).toBe(true);
        expect(s.inlineMath).toBe(false);
        expect(s.wikiLink).toBe(false);
        expect(s.formatApplicable).toBe(false);
    });

    it("a caret inside a real markdown link should report marks.link, not wikiLink", async () => {
        const editor = await makeEditor("a [regular](https://example.com) link");
        caretInText(editor, "regular");
        const s = stateOf(editor);
        expect(s.marks.link).toBe(true);
        expect(s.wikiLink).toBe(false);
        // A real link is a mark on ordinary text — the caret is still in a paragraph.
        expect(s.formatApplicable).toBe(true);
        expect(s.headingLevel).toBe(0);
    });

    it("a caret inside a reference link should report marks.link (link_ref)", async () => {
        const editor = await makeEditor("a [ref link][id] here\n\n[id]: https://example.com");
        caretInText(editor, "ref link");
        expect(stateOf(editor).marks.link).toBe(true);
    });

    it("a caret adjacent to an inline-math atom (not selected) should NOT report it", async () => {
        // A collapsed caret sitting next to the atom is ordinary paragraph text —
        // only a NodeSelection (arrowed-onto / clicked) lights the button.
        const editor = await makeEditor("x $a^2$ y");
        caretInText(editor, "x ");
        const s = stateOf(editor);
        expect(s.inlineMath).toBe(false);
        expect(s.formatApplicable).toBe(true);
    });

    it("a caret inside a footnote definition should report footnote", async () => {
        const editor = await makeEditor("Text with a note.[^1]\n\n[^1]: The definition body.");
        caretInText(editor, "definition body");
        const s = stateOf(editor);
        expect(s.footnote).toBe(true);
        // A footnote definition's body is ordinary block content elsewhere-wise.
        expect(s.inTable).toBe(false);
    });

    it("a selected footnote reference should report footnote", async () => {
        const editor = await makeEditor("Text with a note.[^1]\n\n[^1]: The definition body.");
        nodeSelect(editor, "footnote_reference");
        const s = stateOf(editor);
        expect(s.footnote).toBe(true);
        expect(s.formatApplicable).toBe(false);
    });

    it("a caret in plain text should NOT report footnote", async () => {
        const editor = await makeEditor("Text with a note.[^1]\n\n[^1]: The definition body.");
        caretInText(editor, "Text with");
        expect(stateOf(editor).footnote).toBe(false);
    });

    it("a selected horizontal rule should report hr and not-applicable format", async () => {
        const editor = await makeEditor("above\n\n---\n\nbelow");
        const v = view(editor);
        let pos = -1;
        v.state.doc.descendants((n, p) => {
            if (pos < 0 && (n.type.name === "hr" || n.type.name === "horizontal_rule")) { pos = p; }
        });
        expect(pos).toBeGreaterThan(-1);
        v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, pos)));
        const s = stateOf(editor);
        expect(s.hr).toBe(true);
        expect(s.formatApplicable).toBe(false);
    });

    it("a selected reference image should report imageSelected (image_ref)", async () => {
        const editor = await makeEditor("![alt][pic]\n\n[pic]: https://example.com/x.png");
        nodeSelect(editor, "image_ref");
        expect(stateOf(editor).imageSelected).toBe(true);
    });

    it("the detached state should be fully neutral (island focus, e.g. a callout title)", async () => {
        // Not derived from a doc: the frozen PM selection is stale, so the bar is blanked.
        expect(DETACHED_STATE.formatApplicable).toBe(false);
        expect(DETACHED_STATE.list).toBeNull();
        expect(DETACHED_STATE.quote).toBeNull();
        expect(DETACHED_STATE.code).toBeNull();
        expect(DETACHED_STATE.inTable).toBe(false);
        expect(DETACHED_STATE.wikiLink).toBe(false);
        expect(DETACHED_STATE.inlineMath).toBe(false);
        expect(DETACHED_STATE.imageSelected).toBe(false);
        expect(Object.values(DETACHED_STATE.marks).every((v) => v === false)).toBe(true);
    });
});
