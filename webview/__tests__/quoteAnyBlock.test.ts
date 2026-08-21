/**
 * Quoting ANY block: the toolbar Quote dropdown / slash menu / palette
 * `toggleBlockquote`, and the callout wrap that shares its mechanism
 * (editing/wrapBlocks), against the REAL Milkdown editor.
 *
 * The shipped bug: both wrapped through prosemirror-commands' `wrapIn`, which
 * takes the INNERMOST block range and gives up when the schema forbids the
 * wrapper there. A list item's content is `paragraph block*` and a table
 * cell's is `paragraph`, so quoting a list or a table was a silent no-op —
 * the gesture consumed the click and the document did not move.
 *
 * What is asserted here is deliberately not a table of expected strings. Two
 * invariants carry the file:
 *   - round trip: quote then unquote returns the document byte for byte, so
 *     the toggle is a real toggle for every shape;
 *   - markdown survival: the wrapped document reparses to the same doc it
 *     serialized from, so the result is markdown a parser agrees with rather
 *     than a shape only this schema can hold.
 * The per-shape strings are then a readable record of what the gesture DOES.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { insertCalloutCommand } from "../plugins/callouts";
import { headingFoldPlugin, foldPluginKey } from "../plugins/headingFold";
import { runEditorCommand } from "../editorCommands";
import { TextSelection } from "../pm";
import type { EditorView } from "../pm";
import type { Node as ProseNode } from "../pm";

let editors: Editor[] = [];
let activeEditor: Editor | null = null;
const getEditor = (): Editor | null => activeEditor;

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
        .use(gfmFidelity)
        .use(insertCalloutCommand)
        .create();
    editors.push(editor);
    activeEditor = editor;
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function markdown(editor: Editor): string {
    return editor.action(getMarkdown());
}

/** Caret into the first text node starting with `text`. */
function placeCaretAt(v: EditorView, text: string): void {
    let target = -1;
    v.state.doc.descendants((node: ProseNode, pos: number) => {
        if (target === -1 && node.isText && node.text?.startsWith(text)) {
            target = pos;
        }
        return target === -1;
    });
    expect(target, `no text node starting with ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, target + 1)));
}

/** Caret into the first block of the document, text-bearing or not. */
function placeCaretAtStart(v: EditorView): void {
    v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(0))));
}

/**
 * Reparses `md` in a second editor and returns ITS markdown. Equal to `md`
 * means a parser reads the bytes back as the document that wrote them —
 * the round-trip check that catches a schema-legal shape markdown cannot
 * spell.
 */
async function reparse(md: string): Promise<string> {
    const probe = await makeEditor(md);
    return markdown(probe);
}

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    activeEditor = null;
    document.body.innerHTML = "";
});

/** Every block shape a document is made of, with the caret target inside it. */
const SHAPES: ReadonlyArray<{
    name: string;
    source: string;
    caret?: string;
    quoted: string;
}> = [
    {
        name: "a paragraph",
        source: "plain text\n",
        caret: "plain",
        quoted: "> plain text\n",
    },
    {
        name: "a bullet list",
        source: "- one\n- two\n",
        caret: "one",
        quoted: "> - one\n> - two\n",
    },
    {
        name: "an ordered list",
        source: "1. one\n2. two\n",
        caret: "one",
        quoted: "> 1. one\n> 2. two\n",
    },
    {
        name: "a task list",
        source: "- [ ] one\n- [x] two\n",
        caret: "one",
        quoted: "> - [ ] one\n> - [x] two\n",
    },
    {
        name: "a list with a nested sublist",
        source: "- one\n  - deep\n- two\n",
        caret: "one",
        quoted: "> - one\n>   - deep\n> - two\n",
    },
    {
        name: "a heading",
        source: "## Title\n",
        caret: "Title",
        quoted: "> ## Title\n",
    },
    {
        name: "a code fence",
        source: "```js\ncode\n```\n",
        caret: "code",
        quoted: "> ```js\n> code\n> ```\n",
    },
    {
        name: "a table",
        source: "| a | b |\n|---|---|\n| c | d |\n",
        caret: "a",
        quoted: "> | a | b |\n> |---|---|\n> | c | d |\n",
    },
    {
        name: "a horizontal rule",
        source: "---\n",
        quoted: "> ---\n",
    },
];

describe("toggleBlockquote over every block shape", () => {
    it.each(SHAPES)("$name should go inside the quote whole", async ({ source, caret, quoted }) => {
        // Arrange
        const editor = await makeEditor(source);
        const v = view(editor);
        if (caret) { placeCaretAt(v, caret); } else { placeCaretAtStart(v); }

        // Act
        runEditorCommand("toggleBlockquote", getEditor);

        // Assert: quoted, schema-valid, and markdown a parser reads back the same
        expect(markdown(editor)).toBe(quoted);
        expect(() => v.state.doc.check()).not.toThrow();
        expect(await reparse(markdown(editor))).toBe(quoted);
    });

    it.each(SHAPES)("$name should come back out unchanged", async ({ source, caret }) => {
        // Arrange
        const editor = await makeEditor(source);
        const v = view(editor);
        if (caret) { placeCaretAt(v, caret); } else { placeCaretAtStart(v); }

        // Act: quote, then put the caret back in the same block and unquote
        runEditorCommand("toggleBlockquote", getEditor);
        if (caret) { placeCaretAt(v, caret); } else { placeCaretAtStart(v); }
        runEditorCommand("toggleBlockquote", getEditor);

        // Assert
        expect(markdown(editor)).toBe(source);
        expect(() => v.state.doc.check()).not.toThrow();
    });
});

describe("toggleBlockquote over a selection", () => {
    it("a selection spanning several blocks should quote them as one", async () => {
        const editor = await makeEditor("intro\n\n- one\n- two\n");
        const v = view(editor);
        v.dispatch(v.state.tr.setSelection(
            TextSelection.create(v.state.doc, 1, v.state.doc.content.size - 3),
        ));

        runEditorCommand("toggleBlockquote", getEditor);

        expect(markdown(editor)).toBe("> intro\n>\n> - one\n> - two\n");
    });

    it("a second press should quote nothing further, it should unquote", async () => {
        const editor = await makeEditor("- one\n- two\n");
        const v = view(editor);
        placeCaretAt(v, "one");

        runEditorCommand("toggleBlockquote", getEditor);
        placeCaretAt(v, "one");
        runEditorCommand("toggleBlockquote", getEditor);
        placeCaretAt(v, "one");
        runEditorCommand("toggleBlockquote", getEditor);

        // Three presses land where one press does, never on "> > - one".
        expect(markdown(editor)).toBe("> - one\n> - two\n");
    });

    it("an already-quoted list should unquote from a caret inside an item", async () => {
        const editor = await makeEditor("> - one\n> - two\n");
        const v = view(editor);
        placeCaretAt(v, "two");

        runEditorCommand("toggleBlockquote", getEditor);

        // Plain `lift` here lifted the paragraph out of its LIST ITEM — a list
        // edit ("- one\n\ntwo") rather than an unquote.
        expect(markdown(editor)).toBe("- one\n- two\n");
    });

    it("one block of a multi-block quote should leave the rest quoted", async () => {
        const editor = await makeEditor("> one\n>\n> two\n");
        const v = view(editor);
        placeCaretAt(v, "two");

        runEditorCommand("toggleBlockquote", getEditor);

        expect(markdown(editor)).toBe("> one\n\ntwo\n");
    });
});

describe("quoting inside a container", () => {
    // A list item's SECOND block can hold a quote, so the block the caret is
    // in is quoted where the schema allows it; only where it does not (an
    // item's first child) does the gesture climb to the whole list.
    it("a later block of a list item should be quoted in place", async () => {
        const editor = await makeEditor("- one\n\n  extra\n- two\n");
        const v = view(editor);
        placeCaretAt(v, "extra");

        runEditorCommand("toggleBlockquote", getEditor);

        const md = markdown(editor);
        expect(md).toBe("- one\n\n  > extra\n- two\n");
        expect(await reparse(md)).toBe(md);
    });

    it("a paragraph in a callout should be quoted where it stands", async () => {
        const editor = await makeEditor("> [!NOTE]\n> body\n");
        const v = view(editor);
        placeCaretAt(v, "body");

        runEditorCommand("toggleBlockquote", getEditor);

        // A callout is `block+`, so the quote is legal right there: quoting the
        // block the caret is in never reaches for the container around it. The
        // blank `>` line appears because the body no longer LEADS with a
        // paragraph, so it can no longer share the marker's line.
        const md = markdown(editor);
        expect(md).toBe("> [!NOTE]\n>\n> > body\n");
        expect(await reparse(md)).toBe(md);
    });

    it("a nested sublist should be quoted without touching its parent", async () => {
        const editor = await makeEditor("- one\n  - deep\n- two\n");
        const v = view(editor);
        placeCaretAt(v, "deep");

        runEditorCommand("toggleBlockquote", getEditor);

        const md = markdown(editor);
        expect(md).toContain("> - deep");
        expect(md.startsWith("- one")).toBe(true);
        expect(await reparse(md)).toBe(md);
    });
});

describe("quoting a collapsed heading", () => {
    /** The quote factory plus the fold plugin, so a heading can collapse. */
    async function makeFoldEditor(md: string): Promise<Editor> {
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
            .use(headingFoldPlugin)
            .create();
        editors.push(editor);
        activeEditor = editor;
        return editor;
    }

    /** Collapse the top-level heading at `pos`. */
    function collapse(v: EditorView, pos: number): void {
        v.dispatch(v.state.tr.setMeta(foldPluginKey, { type: "toggle", pos }));
    }

    // A collapsed heading is inseparable from its hidden section — the rule
    // every mover keeps. Quoting the heading line alone would leave the
    // invisible body outside the new quote and silently expand the fold
    // (a nested heading cannot fold), stranding content the user never saw
    // move.
    it("the quote should carry the whole hidden section", async () => {
        const editor = await makeFoldEditor("## Head\n\nbody one\n\nbody two\n");
        const v = view(editor);
        collapse(v, 0);
        placeCaretAt(v, "Head");

        runEditorCommand("toggleBlockquote", getEditor);

        const md = markdown(editor);
        expect(md).toBe("> ## Head\n>\n> body one\n>\n> body two\n");
        expect(await reparse(md)).toBe(md);
    });

    it("content after the collapsed section should stay outside the quote", async () => {
        const editor = await makeFoldEditor("## Head\n\nbody\n\n## Next\n\nafter\n");
        const v = view(editor);
        collapse(v, 0);
        placeCaretAt(v, "Head");

        runEditorCommand("toggleBlockquote", getEditor);

        const md = markdown(editor);
        expect(md).toBe("> ## Head\n>\n> body\n\n## Next\n\nafter\n");
        expect(await reparse(md)).toBe(md);
    });

    it("a callout insert should carry the whole hidden section the same way", async () => {
        const editor = await makeFoldEditor("## Head\n\nbody\n");
        const v = view(editor);
        collapse(v, 0);
        placeCaretAt(v, "Head");

        runEditorCommand("insertCallout", getEditor, "note");

        const md = markdown(editor);
        expect(md).toBe("> [!NOTE]\n>\n> ## Head\n>\n> body\n");
        expect(await reparse(md)).toBe(md);
    });

    it("an expanded heading should still be quoted as its line alone", async () => {
        const editor = await makeFoldEditor("## Head\n\nbody\n");
        const v = view(editor);
        placeCaretAt(v, "Head");

        runEditorCommand("toggleBlockquote", getEditor);

        expect(markdown(editor)).toBe("> ## Head\n\nbody\n");
    });
});

describe("insertCallout shares the wrap", () => {
    it("a list should go inside the callout whole", async () => {
        const editor = await makeEditor("- one\n- two\n");
        placeCaretAt(view(editor), "one");

        runEditorCommand("insertCallout", getEditor, "note");

        // The blank `>` line is the callout's `attached: false`: a list cannot
        // share the marker's line, so the body starts on its own — which is
        // what makes the result reparse to itself.
        const md = markdown(editor);
        expect(md).toBe("> [!NOTE]\n>\n> - one\n> - two\n");
        expect(await reparse(md)).toBe(md);
    });

    it("a paragraph should still share the marker's line", async () => {
        const editor = await makeEditor("plain text\n");
        placeCaretAt(view(editor), "plain");

        runEditorCommand("insertCallout", getEditor, "tip");

        const md = markdown(editor);
        expect(md).toBe("> [!TIP]\n> plain text\n");
        expect(await reparse(md)).toBe(md);
    });

    it("a callout whose body stops leading with a paragraph should detach it", async () => {
        // `attached` is an invariant the parse establishes (a body can share
        // the marker's line only when it starts with a paragraph) and any edit
        // that puts a list or a quote first breaks it. Serializing an attached
        // callout whose body no longer leads with prose writes bytes that
        // reparse detached, so the file gains a `>` line on the NEXT save
        // rather than this one.
        const editor = await makeEditor("> [!NOTE]\n> body\n");
        placeCaretAt(view(editor), "body");

        runEditorCommand("toggleBulletList", getEditor);

        const md = markdown(editor);
        expect(md).toBe("> [!NOTE]\n>\n> - body\n");
        expect(await reparse(md)).toBe(md);
    });

    it("a callout holding a list should uncheck back to the bare list", async () => {
        const editor = await makeEditor("> [!NOTE]\n> - one\n> - two\n");
        placeCaretAt(view(editor), "one");

        // The toolbar Quote dropdown's callout rows are menuitemcheckbox: the
        // checked row unchecks, which must lift out of the CALLOUT and not out
        // of the caret's own list item.
        runEditorCommand("toggleCallout", getEditor, "note");

        expect(markdown(editor)).toBe("- one\n- two\n");
    });
});
