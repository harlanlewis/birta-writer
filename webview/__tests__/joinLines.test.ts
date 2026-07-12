/**
 * Tests for joinLinesCommand (MAR-96, VS Code editor.action.joinLines parity
 * adapted to blocks): caret joins pull the next line/block up to the caret's
 * line, selections join every covered seam, hardbreaks nearest the caret win
 * over block boundaries, seam whitespace collapses to one space, marks
 * survive, list items merge, and non-text neighbors refuse untouched — all
 * in a single undo step.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { TextSelection } from "@milkdown/prose/state";
import { undo } from "@milkdown/prose/history";
import type { EditorView } from "@milkdown/prose/view";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, pureCommonmark } from "../serialization";
import { historyPlugin } from "../plugins/history";
import { joinLinesCommand } from "../plugins/joinLines";

let editors: Editor[] = [];

async function makeEditor(markdown: string): Promise<EditorView> {
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
        .use(historyPlugin)
        .create();
    editors.push(editor);
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

/** Caret at `offset` inside the first text node equal to `text`. */
function placeCaretIn(view: EditorView, text: string, offset = 0): void {
    let found = -1;
    view.state.doc.descendants((node, pos) => {
        if (found >= 0) {
            return false;
        }
        if (node.isText && node.text === text) {
            found = pos + offset;
            return false;
        }
        return true;
    });
    expect(found).toBeGreaterThan(-1);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, found)));
}

/** Text of each top-level block. */
function blockTexts(view: EditorView): string[] {
    const texts: string[] = [];
    view.state.doc.forEach((node) => {
        texts.push(node.textContent);
    });
    return texts;
}

/** The document serialized back to markdown (the round-trip that matters). */
function serialize(): string {
    return editors[editors.length - 1]!.action(getMarkdown()).trimEnd();
}

/** Count `hardbreak` nodes in the whole document. */
function hardbreakCount(view: EditorView): number {
    let count = 0;
    view.state.doc.descendants((node) => {
        if (node.type.name === "hardbreak") {
            count++;
        }
    });
    return count;
}

describe("caret join of sibling paragraphs", () => {
    it("caret in a paragraph should merge the next paragraph with one space", async () => {
        // Arrange
        const view = await makeEditor("Alpha\n\nBeta");
        placeCaretIn(view, "Alpha", 2);

        // Act
        const handled = joinLinesCommand(view.state, view.dispatch);

        // Assert
        expect(handled).toBe(true);
        expect(blockTexts(view)).toEqual(["Alpha Beta"]);
        expect(view.state.doc.childCount).toBe(1);
    });

    it("the caret should land at the seam, before the inserted space", async () => {
        // Arrange — "Alpha" occupies 1..6, so the seam is position 6.
        const view = await makeEditor("Alpha\n\nBeta");
        placeCaretIn(view, "Alpha", 2);

        // Act
        joinLinesCommand(view.state, view.dispatch);

        // Assert
        expect(view.state.selection.empty).toBe(true);
        expect(view.state.selection.from).toBe(6);
        expect(view.state.doc.textBetween(6, 7)).toBe(" ");
    });

    it("trailing and leading whitespace at the seam should collapse to one space", async () => {
        // Arrange — pad "Alpha" with a trailing run and "Beta" with a leading one.
        const view = await makeEditor("Alpha\n\nBeta");
        view.dispatch(view.state.tr.insertText("   ", 6));
        view.dispatch(view.state.tr.insertText("  ", 11));
        placeCaretIn(view, "Alpha   ", 1);

        // Act
        const handled = joinLinesCommand(view.state, view.dispatch);

        // Assert
        expect(handled).toBe(true);
        expect(blockTexts(view)).toEqual(["Alpha Beta"]);
    });

    it("marks on both sides of the seam should survive the join", async () => {
        // Arrange
        const view = await makeEditor("**Alpha**\n\n*Beta*");
        placeCaretIn(view, "Alpha", 1);

        // Act
        const handled = joinLinesCommand(view.state, view.dispatch);

        // Assert
        expect(handled).toBe(true);
        const paragraph = view.state.doc.firstChild!;
        expect(paragraph.textContent).toBe("Alpha Beta");
        const first = paragraph.firstChild!;
        const last = paragraph.lastChild!;
        expect(first.marks.some((m) => m.type.name === "strong")).toBe(true);
        expect(last.marks.some((m) => m.type.name === "emphasis")).toBe(true);
    });

    it("the seam space should land OUTSIDE a link (non-inclusive mark, round-trip safe)", async () => {
        // Arrange — a link paragraph followed by plain text. Inheriting the
        // link mark onto the seam space would save `[foo ](url)bar`, silently
        // rewriting the markdown.
        const view = await makeEditor("[foo](http://x.com)\n\nbar");
        placeCaretIn(view, "foo", 1);

        // Act
        const handled = joinLinesCommand(view.state, view.dispatch);

        // Assert — the space is not part of the link.
        expect(handled).toBe(true);
        expect(serialize()).toBe("[foo](http://x.com) bar");
    });

    it("the seam space should land OUTSIDE an inline code span", async () => {
        // Arrange
        const view = await makeEditor("`foo`\n\nbar");
        placeCaretIn(view, "foo", 1);

        // Act
        const handled = joinLinesCommand(view.state, view.dispatch);

        // Assert — the space is not pulled into the code span.
        expect(handled).toBe(true);
        expect(serialize()).toBe("`foo` bar");
    });

    it("the seam space CAN stay inside a mark that spans both lines", async () => {
        // Arrange — emphasis runs across the seam (both lines emphasized), so
        // the space is genuinely inside a continuous run and keeps the mark.
        const view = await makeEditor("*foo*\n\n*bar*");
        placeCaretIn(view, "foo", 1);

        // Act
        const handled = joinLinesCommand(view.state, view.dispatch);

        // Assert — one emphasized run "foo bar", the seam space included.
        expect(handled).toBe(true);
        expect(serialize()).toBe("*foo bar*");
    });

    it("a heading caret should absorb the following paragraph", async () => {
        // Arrange
        const view = await makeEditor("# Title\n\nBody");
        placeCaretIn(view, "Title", 1);

        // Act
        const handled = joinLinesCommand(view.state, view.dispatch);

        // Assert
        expect(handled).toBe(true);
        expect(view.state.doc.childCount).toBe(1);
        expect(view.state.doc.firstChild!.type.name).toBe("heading");
        expect(view.state.doc.firstChild!.textContent).toBe("Title Body");
    });
});

describe("hardbreak seams", () => {
    it("a hardbreak after the caret should be replaced instead of pulling up the next block", async () => {
        // Arrange — first paragraph is "Alpha<br>Beta", second is "Gamma".
        const view = await makeEditor("Alpha\\\nBeta\n\nGamma");
        expect(hardbreakCount(view)).toBe(1);
        placeCaretIn(view, "Alpha", 2);

        // Act
        const handled = joinLinesCommand(view.state, view.dispatch);

        // Assert — the break became a space; Gamma was NOT merged.
        expect(handled).toBe(true);
        expect(hardbreakCount(view)).toBe(0);
        expect(blockTexts(view)).toEqual(["Alpha Beta", "Gamma"]);
    });

    it("a hardbreak before the caret should be kept — the block boundary is the nearest seam", async () => {
        // Arrange — caret in "Beta", after the break.
        const view = await makeEditor("Alpha\\\nBeta\n\nGamma");
        placeCaretIn(view, "Beta", 2);

        // Act
        const handled = joinLinesCommand(view.state, view.dispatch);

        // Assert — Gamma merged up; the earlier break survives.
        expect(handled).toBe(true);
        expect(hardbreakCount(view)).toBe(1);
        expect(blockTexts(view)).toEqual(["Alpha\nBeta Gamma"]);
    });
});

describe("selection spanning multiple textblocks", () => {
    it("a selection across three paragraphs should join them all into one", async () => {
        // Arrange — Alpha 1..6, Beta 8..12, Gamma 14..19; select 2..16.
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        view.dispatch(view.state.tr.setSelection(
            TextSelection.create(view.state.doc, 2, 16),
        ));

        // Act
        const handled = joinLinesCommand(view.state, view.dispatch);

        // Assert
        expect(handled).toBe(true);
        expect(view.state.doc.childCount).toBe(1);
        expect(blockTexts(view)).toEqual(["Alpha Beta Gamma"]);
    });

    it("the selection should survive the join, mapped over the joined text", async () => {
        // Arrange
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        view.dispatch(view.state.tr.setSelection(
            TextSelection.create(view.state.doc, 2, 16),
        ));

        // Act
        joinLinesCommand(view.state, view.dispatch);

        // Assert
        const sel = view.state.selection;
        expect(view.state.doc.textBetween(sel.from, sel.to)).toBe("lpha Beta Ga");
    });

    it("a selection that reaches a code fence should refuse without changing anything", async () => {
        // Arrange — selection from "Alpha" into the fence.
        const view = await makeEditor("Alpha\n\nBeta\n\n```\ncode\n```");
        const before = blockTexts(view);
        const fencePos = 13; // third top-level block start
        expect(view.state.doc.nodeAt(fencePos)?.type.name).toBe("code_block");
        view.dispatch(view.state.tr.setSelection(
            TextSelection.create(view.state.doc, 2, fencePos + 2),
        ));

        // Act
        const handled = joinLinesCommand(view.state, view.dispatch);

        // Assert — all-or-nothing: no partial join of Alpha and Beta either.
        expect(handled).toBe(false);
        expect(blockTexts(view)).toEqual(before);
    });
});

describe("list items", () => {
    it("caret in a list item should merge the following item's paragraph and drop the item", async () => {
        // Arrange
        const view = await makeEditor("- one\n- two");
        placeCaretIn(view, "one", 1);

        // Act
        const handled = joinLinesCommand(view.state, view.dispatch);

        // Assert
        expect(handled).toBe(true);
        const list = view.state.doc.firstChild!;
        expect(list.type.name).toBe("bullet_list");
        expect(list.childCount).toBe(1);
        expect(list.firstChild!.textContent).toBe("one two");
    });

    it("a paragraph after the list should join into the last item's paragraph", async () => {
        // Arrange
        const view = await makeEditor("- one\n\nAfter");
        placeCaretIn(view, "one", 1);

        // Act
        const handled = joinLinesCommand(view.state, view.dispatch);

        // Assert
        expect(handled).toBe(true);
        expect(view.state.doc.childCount).toBe(1);
        const list = view.state.doc.firstChild!;
        expect(list.type.name).toBe("bullet_list");
        expect(list.firstChild!.textContent).toBe("one After");
    });

    it("an item whose next sibling is its own nested sublist should refuse", async () => {
        // Arrange — item "one" is followed inside itself by a nested list.
        const view = await makeEditor("- one\n  - sub\n- two");
        const before = view.state.doc.toJSON();
        placeCaretIn(view, "one", 1);

        // Act
        const handled = joinLinesCommand(view.state, view.dispatch);

        // Assert — structurally ambiguous: never corrupt, never partial.
        expect(handled).toBe(false);
        expect(view.state.doc.toJSON()).toEqual(before);
    });
});

describe("non-text neighbors and document edges", () => {
    it("a following code fence should make the join a no-op", async () => {
        const view = await makeEditor("Alpha\n\n```\ncode\n```");
        const before = view.state.doc.toJSON();
        placeCaretIn(view, "Alpha", 1);
        expect(joinLinesCommand(view.state, view.dispatch)).toBe(false);
        expect(view.state.doc.toJSON()).toEqual(before);
    });

    it("a caret inside a code fence should make the join a no-op", async () => {
        const view = await makeEditor("```\ncode\n```\n\nAlpha");
        const before = view.state.doc.toJSON();
        placeCaretIn(view, "code", 1);
        expect(joinLinesCommand(view.state, view.dispatch)).toBe(false);
        expect(view.state.doc.toJSON()).toEqual(before);
    });

    it("a following horizontal rule should make the join a no-op", async () => {
        const view = await makeEditor("Alpha\n\n---\n\nBeta");
        const before = view.state.doc.toJSON();
        placeCaretIn(view, "Alpha", 1);
        expect(joinLinesCommand(view.state, view.dispatch)).toBe(false);
        expect(view.state.doc.toJSON()).toEqual(before);
    });

    it("a following table should make the join a no-op", async () => {
        const view = await makeEditor("Alpha\n\n| a |\n| --- |\n| b |");
        const before = view.state.doc.toJSON();
        placeCaretIn(view, "Alpha", 1);
        expect(joinLinesCommand(view.state, view.dispatch)).toBe(false);
        expect(view.state.doc.toJSON()).toEqual(before);
    });

    it("a following image-only paragraph should make the join a no-op", async () => {
        const view = await makeEditor("Alpha\n\n![pic](x.png)");
        const before = view.state.doc.toJSON();
        placeCaretIn(view, "Alpha", 1);
        expect(joinLinesCommand(view.state, view.dispatch)).toBe(false);
        expect(view.state.doc.toJSON()).toEqual(before);
    });

    it("the last block of the document should have nothing to join", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        const before = view.state.doc.toJSON();
        placeCaretIn(view, "Beta", 1);
        expect(joinLinesCommand(view.state, view.dispatch)).toBe(false);
        expect(view.state.doc.toJSON()).toEqual(before);
    });
});

describe("undo grouping", () => {
    it("a multi-block selection join should undo in a single step", async () => {
        // Arrange
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        view.dispatch(view.state.tr.setSelection(
            TextSelection.create(view.state.doc, 2, 16),
        ));

        // Act
        joinLinesCommand(view.state, view.dispatch);
        expect(blockTexts(view)).toEqual(["Alpha Beta Gamma"]);
        const undone = undo(view.state, view.dispatch);

        // Assert — one undo restores all three blocks.
        expect(undone).toBe(true);
        expect(blockTexts(view)).toEqual(["Alpha", "Beta", "Gamma"]);
    });
});
