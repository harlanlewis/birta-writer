/**
 * The heading commands are toggles: a second press at the same level puts the
 * block back to a paragraph.
 *
 * Headings were the one block-type family in the toolbar that was not one.
 * `toggleBlockquote` and the three list kinds all invert on a second press,
 * and the Format picker already fills the row for the caret's level, so a lit
 * row that did nothing when clicked was the visible half of the gap.
 *
 * Drives the REAL Milkdown editor through the shared command registry, so what
 * is pinned here is what the chord, the Format row, the slash menu and the
 * palette all do — they are one entry in `editorCommands.ts`, not four.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { Selection, TextSelection } from "../pm";
import type { EditorView } from "../pm";
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

/** Select from inside the first `a` text node through inside the first `b` one. */
function selectAcross(editor: Editor, a: string, b: string): void {
    const v = view(editor);
    let from = -1;
    let to = -1;
    v.state.doc.descendants((n, p) => {
        if (from < 0 && n.isText && n.text === a) { from = p + 1; }
        if (n.isText && n.text === b) { to = p + 1; }
    });
    if (from < 0 || to < 0) { throw new Error(`text not found: ${a} / ${b}`); }
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to)));
}

const md = (editor: Editor): string => editor.action(getMarkdown()).trim();

/** The heading level the caret sits in, read back off the document. */
function levelAtCaret(editor: Editor): number {
    const v = view(editor);
    const { $from } = v.state.selection;
    for (let depth = $from.depth; depth >= 0; depth--) {
        const node = $from.node(depth);
        if (node.type.name === "heading") { return node.attrs["level"] as number; }
    }
    return 0;
}

afterEach(async () => {
    for (const editor of editors) { await editor.destroy(); }
    editors = [];
});

describe("heading level toggle", () => {
    it("the same level pressed on a heading already at it should demote it to a paragraph", async () => {
        const editor = await makeEditor("# title");
        caretInText(editor, "title");
        runEditorCommand("setHeading1", () => editor);
        expect(md(editor)).toBe("title");
    });

    it("a heading command on a paragraph should still make it that heading", async () => {
        // The other half of the toggle, and the half that must not regress:
        // the first press is what it always was.
        const editor = await makeEditor("plain");
        caretInText(editor, "plain");
        runEditorCommand("setHeading2", () => editor);
        expect(md(editor)).toBe("## plain");
    });

    it("a DIFFERENT level pressed on a heading should retype it, not demote it", async () => {
        // The toggle keys on the level, not on being a heading at all. An H1
        // that answered ⌥⌘2 by becoming a paragraph would make the Format
        // menu unusable as a picker.
        const editor = await makeEditor("# title");
        caretInText(editor, "title");
        runEditorCommand("setHeading3", () => editor);
        expect(md(editor)).toBe("### title");
    });

    it("pressing the same level twice should return the document to where it started", async () => {
        // The round trip is the claim a user makes when they press a chord
        // twice, and it is stronger than either half alone: it fails if the
        // demotion drops the text, splits the block, or leaves an attr behind.
        const editor = await makeEditor("plain");
        caretInText(editor, "plain");
        runEditorCommand("setHeading4", () => editor);
        expect(md(editor)).toBe("#### plain");
        runEditorCommand("setHeading4", () => editor);
        expect(md(editor)).toBe("plain");
    });

    it("every level should toggle, not only the one a test happened to pick", async () => {
        // Derived from the six commands rather than sampling one: a level
        // wired to a different code path is exactly what a hand-picked case
        // would miss.
        const levels = [1, 2, 3, 4, 5, 6] as const;
        for (const level of levels) {
            const editor = await makeEditor("word");
            caretInText(editor, "word");
            runEditorCommand(`setHeading${level}` as "setHeading1", () => editor);
            expect(md(editor), `level ${level} did not apply`).toBe(`${"#".repeat(level)} word`);
            expect(levelAtCaret(editor), `level ${level} left the caret outside its heading`).toBe(level);
            runEditorCommand(`setHeading${level}` as "setHeading1", () => editor);
            expect(md(editor), `level ${level} did not toggle back`).toBe("word");
        }
    });

    it("a demotion should leave the caret in the block it just retyped", async () => {
        // A toggle whose caret jumps is a toggle nobody presses twice. Read
        // off the document rather than inferred from the markdown.
        const editor = await makeEditor("# one\n\n## two");
        caretInText(editor, "one");
        runEditorCommand("setHeading1", () => editor);
        const v = view(editor);
        expect(levelAtCaret(editor)).toBe(0);
        expect(v.state.doc.resolve(v.state.selection.from).parent.textContent).toBe("one");
    });

    it("a selection spanning several headings at the level should demote all of them", async () => {
        // Decided from the caret's block, applied to the selection: the same
        // asymmetry the wrap already has, so the two halves cover the same
        // range.
        const editor = await makeEditor("# one\n\n# two\n\n# three");
        selectAcross(editor, "one", "two");
        runEditorCommand("setHeading1", () => editor);
        const out = md(editor);
        expect(out).toBe("one\n\ntwo\n\n# three");
    });

    it("a selection spanning mixed levels should demote every heading it covers", async () => {
        // The decision comes from the selection's start, which is the level
        // the Format picker lights. An H2 caught in the range goes with it
        // rather than surviving as the one block the gesture missed.
        const editor = await makeEditor("# one\n\n## two\n\nplain");
        selectAcross(editor, "one", "two");
        runEditorCommand("setHeading1", () => editor);
        expect(md(editor)).toBe("one\n\ntwo\n\nplain");
    });

    it("a heading command on a list line should still lift it out of the list", async () => {
        // setHeadingInList.test.ts owns this behaviour; repeated here because
        // the toggle branch runs BEFORE the lift and could swallow it.
        const editor = await makeEditor("- one\n- two");
        caretInText(editor, "two");
        runEditorCommand("setHeading1", () => editor);
        expect(md(editor)).toBe("- one\n\n# two");
    });

    it("setParagraph should stay the unconditional way to say paragraph", async () => {
        // It is contributed, palette-visible and menu-visible, and it means
        // paragraph regardless of the current level. A toggle on the heading
        // commands does not make it redundant or change it.
        const editor = await makeEditor("### three");
        caretInText(editor, "three");
        runEditorCommand("setParagraph", () => editor);
        expect(md(editor)).toBe("three");
        runEditorCommand("setParagraph", () => editor);
        expect(md(editor)).toBe("three");
    });
});
