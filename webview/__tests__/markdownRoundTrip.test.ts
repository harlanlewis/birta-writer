/**
 * End-to-end round-trip tests for paragraph breaks and empty-paragraph
 * serialization, driving the REAL Milkdown editor (real parser, real
 * remark-stringify, the production serialization config from
 * webview/serialization.ts) plus the real minimal-diff merge — no mocks.
 *
 * Regressions covered:
 * 1. Pressing Enter created a new paragraph but the saved file got a single
 *    newline (a Markdown soft break), so formatters collapsed the two
 *    "paragraphs" back into one line.
 * 2. Empty paragraphs (e.g. from pressing Enter twice) were written to the
 *    file as literal `<br />` HTML.
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { splitBlock } from "@milkdown/prose/commands";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { applyMinimalChanges } from "../utils/minimalDiff";

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
        .create();
}

/** Place the text cursor at the very end of the doc's n-th top-level block. */
function placeCursorAtEndOfBlock(view: EditorView, n: number): void {
    const { state } = view;
    let pos = 0;
    for (let i = 0; i < n; i++) pos += state.doc.child(i).nodeSize;
    const endOfText = pos + state.doc.child(n).nodeSize - 1;
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, endOfText)));
}

/** Simulate pressing Enter (what the base keymap binds it to in paragraphs). */
function pressEnter(view: EditorView): void {
    splitBlock(view.state, view.dispatch);
}

function typeText(view: EditorView, text: string): void {
    view.dispatch(view.state.tr.insertText(text));
}

function paragraphTexts(editor: Editor): string[] {
    return editor.action((ctx) => {
        const texts: string[] = [];
        ctx.get(editorViewCtx).state.doc.forEach((node) => {
            if (node.type.name === "paragraph") texts.push(node.textContent);
        });
        return texts;
    });
}

describe("Enter should create a real Markdown paragraph break", () => {
    it("Enter at the end of a paragraph followed by typing should save a blank-separated paragraph", async () => {
        // Arrange
        const saved = "para1\n";
        const editor = await makeEditor(saved);
        const view = editor.action((ctx) => ctx.get(editorViewCtx));

        // Act — what the user does: Enter, then type
        placeCursorAtEndOfBlock(view, 0);
        pressEnter(view);
        typeText(view, "para2");
        const merged = applyMinimalChanges(saved, editor.action(getMarkdown()));

        // Assert — a blank line separates the paragraphs
        expect(merged).toBe("para1\n\npara2\n");
        await editor.destroy();

        // ...and the real parser agrees they are two paragraphs (a soft break
        // would collapse them into one — the original bug)
        const reparsed = await makeEditor(merged);
        expect(paragraphTexts(reparsed)).toEqual(["para1", "para2"]);
        await reparsed.destroy();
    });

    it("Enter in the middle of a paragraph should split it into two blank-separated paragraphs", async () => {
        // Arrange
        const saved = "intro\n\nfirstsecond\n";
        const editor = await makeEditor(saved);
        const view = editor.action((ctx) => ctx.get(editorViewCtx));

        // Act — cursor between "first" and "second"
        let pos = view.state.doc.child(0).nodeSize; // skip "intro"
        pos += 1 + "first".length; // into the paragraph, after "first"
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
        pressEnter(view);
        const merged = applyMinimalChanges(saved, editor.action(getMarkdown()));
        await editor.destroy();

        // Assert
        expect(merged).toBe("intro\n\nfirst\n\nsecond\n");
        const reparsed = await makeEditor(merged);
        expect(paragraphTexts(reparsed)).toEqual(["intro", "first", "second"]);
        await reparsed.destroy();
    });
});

describe("empty paragraphs should never write <br /> into the file", () => {
    it("pressing Enter twice without typing should leave the saved file unchanged", async () => {
        // Arrange
        const saved = "para1\n\npara2\n";
        const editor = await makeEditor(saved);
        const view = editor.action((ctx) => ctx.get(editorViewCtx));

        // Act — Enter twice at the end of para1 leaves empty paragraphs in the doc
        placeCursorAtEndOfBlock(view, 0);
        pressEnter(view);
        pressEnter(view);
        const serialized = editor.action(getMarkdown());
        const merged = applyMinimalChanges(saved, serialized);
        await editor.destroy();

        // Assert — no <br /> anywhere, and the transient empty paragraphs
        // don't touch the file at all (identity)
        expect(serialized).not.toContain("<br");
        expect(merged).toBe(saved);
    });

    it("an empty paragraph left before typed text should degrade to blank lines, not <br />", async () => {
        // Arrange
        const saved = "para1\n\npara2\n";
        const editor = await makeEditor(saved);
        const view = editor.action((ctx) => ctx.get(editorViewCtx));

        // Act — Enter twice, then type: an empty paragraph stays in the doc
        placeCursorAtEndOfBlock(view, 0);
        pressEnter(view);
        pressEnter(view);
        typeText(view, "middle");
        const serialized = editor.action(getMarkdown());
        const merged = applyMinimalChanges(saved, serialized);
        await editor.destroy();

        // Assert — pure Markdown output, and all three paragraphs survive a re-parse
        expect(serialized).not.toContain("<br");
        expect(merged).not.toContain("<br");
        const reparsed = await makeEditor(merged);
        expect(paragraphTexts(reparsed)).toEqual(["para1", "middle", "para2"]);
        await reparsed.destroy();
    });

    it("an empty table cell should serialize as an empty cell, not <br />", async () => {
        // Arrange
        const saved = "| a | b |\n| --- | --- |\n|  | x |\n";
        const editor = await makeEditor(saved);

        // Act — serialize the untouched document
        const serialized = editor.action(getMarkdown());
        const merged = applyMinimalChanges(saved, serialized);
        await editor.destroy();

        // Assert
        expect(serialized).not.toContain("<br");
        expect(merged).toBe(saved);
    });

    it("a legacy standalone <br /> line already in the file should round-trip unchanged", async () => {
        // Arrange — a file polluted by the old behavior
        const saved = "para1\n\n<br />\n\npara2\n";
        const editor = await makeEditor(saved);

        // Act
        const merged = applyMinimalChanges(saved, editor.action(getMarkdown()));
        await editor.destroy();

        // Assert — no churn, no data loss
        expect(merged).toBe(saved);
    });

    it("a legacy lone <br /> table cell should round-trip unchanged", async () => {
        // Arrange — an empty cell as the old serializer wrote it
        const saved = "| a | b |\n| --- | --- |\n| <br /> | x |\n";
        const editor = await makeEditor(saved);

        // Act
        const merged = applyMinimalChanges(saved, editor.action(getMarkdown()));
        await editor.destroy();

        // Assert
        expect(merged).toBe(saved);
    });
});

describe("intentional <br> content survives (the removed plugin used to destroy it)", () => {
    // Milkdown's remark-preserve-empty-line plugin stripped EVERY <br> HTML
    // node at parse time, so `line1<br>line2` saved back as `line1line2`.
    // These tests pin the fix: with the plugin removed, intentional <br>
    // round-trips byte-for-byte. They also guard against anyone reinstating
    // the plugin for empty-paragraph handling.

    it("an inline <br> inside a paragraph should round-trip unchanged", async () => {
        // Arrange
        const saved = "line1<br>line2\n";
        const editor = await makeEditor(saved);

        // Act
        const serialized = editor.action(getMarkdown());
        const merged = applyMinimalChanges(saved, serialized);
        await editor.destroy();

        // Assert — the <br> is neither stripped nor rewritten
        expect(serialized).toContain("<br>");
        expect(merged).toBe(saved);
    });

    it("a multi-line table cell using <br> should round-trip unchanged", async () => {
        // Arrange — the standard GFM idiom for line breaks inside a cell
        const saved = "| a | b |\n| --- | --- |\n| one<br>two | x |\n";
        const editor = await makeEditor(saved);

        // Act
        const serialized = editor.action(getMarkdown());
        const merged = applyMinimalChanges(saved, serialized);
        await editor.destroy();

        // Assert
        expect(serialized).toContain("one<br>two");
        expect(merged).toBe(saved);
    });
});

describe("the merge keeps untouched formatting through the real pipeline", () => {
    it("typing into one paragraph should not reformat a hand-padded table elsewhere", async () => {
        // Arrange — table with deliberate non-canonical padding
        const saved =
            "# Title\n\npara old\n\n| fruit | price |\n| ----- | ----- |\n| apple | 1     |\n";
        const editor = await makeEditor(saved);
        const view = editor.action((ctx) => ctx.get(editorViewCtx));

        // Act — append text to the paragraph (block 1, after the heading)
        placeCursorAtEndOfBlock(view, 1);
        typeText(view, " edited");
        const merged = applyMinimalChanges(saved, editor.action(getMarkdown()));
        await editor.destroy();

        // Assert — only the paragraph line changed; the table kept its padding
        expect(merged).toBe(
            "# Title\n\npara old edited\n\n| fruit | price |\n| ----- | ----- |\n| apple | 1     |\n",
        );
    });
});
