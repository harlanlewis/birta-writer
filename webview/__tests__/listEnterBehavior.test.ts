/**
 * End-to-end tests for Enter on an EMPTY list item (Slack / Google Docs
 * behavior), driving the REAL Milkdown editor: real parser, real schema,
 * the production serialization config, and the list plugins registered
 * exactly as webview/editor.ts registers them.
 *
 * Required behavior:
 * - Enter on an empty NESTED list item outdents it exactly one level
 *   (repeated Enter walks back level by level).
 * - Enter on an empty TOP-LEVEL list item exits the list entirely, leaving
 *   an empty paragraph after (splitting the list if the item was in the
 *   middle).
 * - Non-empty items keep the default split behavior.
 * - An empty paragraph with a nested sublist below is NOT an empty item.
 *
 * Enter is simulated through view.someProp("handleKeyDown", ...), which runs
 * every plugin's key handler in real plugin order — our $prose keymap first,
 * then Milkdown's built keymap (commonmark's splitListItem + base keymap) —
 * so these tests also pin the keymap precedence.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    listEnterPlugin,
    listLiftPlugin,
    listSpreadNormalizePlugin,
} from "../plugins";

let editors: Editor[] = [];

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
        .use(listLiftPlugin)
        .use(listEnterPlugin)
        .use(listSpreadNormalizePlugin)
        .create();
    editors.push(editor);
    return editor;
}

afterEach(async () => {
    for (const editor of editors) await editor.destroy();
    editors = [];
});

function getView(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Place the caret right after the first text node equal to `text`. */
function placeCaretAfterText(view: EditorView, text: string): void {
    let found = -1;
    view.state.doc.descendants((node, pos) => {
        if (found >= 0) return false;
        if (node.isText && node.text === text) {
            found = pos + text.length;
            return false;
        }
        return true;
    });
    if (found < 0) throw new Error(`text not found in doc: ${text}`);
    view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, found)),
    );
}

/** Delete all content of the paragraph the caret sits in, leaving it empty. */
function clearCurrentParagraph(view: EditorView): void {
    const { $from } = view.state.selection;
    view.dispatch(view.state.tr.delete($from.start(), $from.end()));
}

/**
 * Simulate pressing Enter through the real keydown pipeline: every plugin's
 * handleKeyDown runs in plugin order, exactly as a real keypress would.
 */
function pressEnter(view: EditorView): boolean {
    const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
    });
    return (
        view.someProp("handleKeyDown", (handler) => handler(view, event)) ??
        false
    );
}

/** All (type name, textContent) pairs of the doc's top-level children. */
function topLevel(view: EditorView): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    view.state.doc.forEach((node) => out.push([node.type.name, node.textContent]));
    return out;
}

describe("Enter on an empty nested list item", () => {
    it("empty item at depth 2 should outdent to depth 1", async () => {
        // Arrange — `- a\n  - b`, then empty out "b"
        const editor = await makeEditor("- a\n  - b\n");
        const view = getView(editor);
        placeCaretAfterText(view, "b");
        clearCurrentParagraph(view);

        // Act
        const handled = pressEnter(view);

        // Assert — the empty item is now a sibling of "a" in the outer list
        expect(handled).toBe(true);
        expect(view.state.doc.childCount).toBe(1);
        const list = view.state.doc.child(0);
        expect(list.type.name).toBe("bullet_list");
        expect(list.childCount).toBe(2);
        expect(list.child(0).textContent).toBe("a");
        const lifted = list.child(1);
        expect(lifted.type.name).toBe("list_item");
        expect(lifted.childCount).toBe(1);
        expect(lifted.firstChild?.type.name).toBe("paragraph");
        expect(lifted.firstChild?.content.size).toBe(0);
        // Serialized markdown: `- a` followed by an empty `-` item, no nesting
        const serialized = editor.action(getMarkdown());
        expect(serialized.startsWith("- a\n")).toBe(true);
        expect(serialized).not.toMatch(/^\s+-/m); // no indented (nested) item left
    });

    it("Enter again on the now-top-level empty item should exit the list into an empty paragraph", async () => {
        // Arrange — same starting point, walked back one level already
        const editor = await makeEditor("- a\n  - b\n");
        const view = getView(editor);
        placeCaretAfterText(view, "b");
        clearCurrentParagraph(view);
        pressEnter(view); // depth 2 → depth 1

        // Act — second Enter on the top-level empty item
        const handled = pressEnter(view);

        // Assert — the list keeps only "a"; an empty paragraph follows it
        expect(handled).toBe(true);
        expect(topLevel(view)).toEqual([
            ["bullet_list", "a"],
            ["paragraph", ""],
        ]);
        expect(view.state.doc.child(0).childCount).toBe(1);
        // The caret ended up in the escaped paragraph
        expect(view.state.selection.$from.parent.type.name).toBe("paragraph");
        // Serialized markdown has no empty `- ` item line left anywhere
        const serialized = editor.action(getMarkdown());
        expect(serialized).not.toMatch(/^[-*+]\s*$/m);
    });
});

describe("Enter on an empty top-level list item", () => {
    it("empty middle item should split the list with a paragraph between", async () => {
        // Arrange — `- a / - b / - c`, then empty out "b"
        const editor = await makeEditor("- a\n- b\n- c\n");
        const view = getView(editor);
        placeCaretAfterText(view, "b");
        clearCurrentParagraph(view);

        // Act
        const handled = pressEnter(view);

        // Assert — list split in two, empty paragraph in the middle
        expect(handled).toBe(true);
        expect(topLevel(view)).toEqual([
            ["bullet_list", "a"],
            ["paragraph", ""],
            ["bullet_list", "c"],
        ]);
        const serialized = editor.action(getMarkdown());
        expect(serialized).not.toMatch(/^[-*+]\s*$/m);
    });
});

describe("Enter on a non-empty list item keeps the default behavior", () => {
    it("Enter mid-text in a non-empty item should split it into two items", async () => {
        // Arrange — caret between "a" and "b" of the single item "ab"
        const editor = await makeEditor("- ab\n");
        const view = getView(editor);
        placeCaretAfterText(view, "ab");
        const { $from } = view.state.selection;
        view.dispatch(
            view.state.tr.setSelection(
                TextSelection.create(view.state.doc, $from.pos - 1),
            ),
        );

        // Act
        const handled = pressEnter(view);

        // Assert — default splitListItem ran: two items, both in the list
        expect(handled).toBe(true);
        expect(view.state.doc.childCount).toBe(1);
        const list = view.state.doc.child(0);
        expect(list.childCount).toBe(2);
        expect(list.child(0).textContent).toBe("a");
        expect(list.child(1).textContent).toBe("b");
    });
});

describe("task lists (GFM checkbox items)", () => {
    it("Enter on an empty top-level task item should exit the list", async () => {
        // Arrange — real task list (checked attr set), then empty out "b"
        const editor = await makeEditor("- [ ] a\n- [x] b\n");
        const view = getView(editor);
        // Sanity: these really are task items, not plain list items
        expect(view.state.doc.child(0).child(1).attrs.checked).toBe(true);
        placeCaretAfterText(view, "b");
        clearCurrentParagraph(view);

        // Act
        const handled = pressEnter(view);

        // Assert — empty task item left the list; empty paragraph follows
        expect(handled).toBe(true);
        expect(topLevel(view)).toEqual([
            ["bullet_list", "a"],
            ["paragraph", ""],
        ]);
        const serialized = editor.action(getMarkdown());
        expect(serialized).not.toMatch(/^[-*+]\s*(\[[ x]\])?\s*$/m);
    });

    it("Enter on an empty nested task item should outdent one level", async () => {
        // Arrange
        const editor = await makeEditor("- [ ] a\n  - [ ] b\n");
        const view = getView(editor);
        placeCaretAfterText(view, "b");
        clearCurrentParagraph(view);

        // Act
        const handled = pressEnter(view);

        // Assert — item lifted to the outer list, no nested list left
        expect(handled).toBe(true);
        expect(view.state.doc.childCount).toBe(1);
        const list = view.state.doc.child(0);
        expect(list.childCount).toBe(2);
        expect(list.child(0).textContent).toBe("a");
        expect(list.child(1).firstChild?.content.size).toBe(0);
        let nestedList = false;
        view.state.doc.descendants((node, _pos, parent) => {
            if (
                node.type.name === "bullet_list" &&
                parent?.type.name === "list_item"
            ) {
                nestedList = true;
            }
            return true;
        });
        expect(nestedList).toBe(false);
    });
});

describe("an empty paragraph with a nested sublist is NOT an empty item", () => {
    it("Enter should keep the default behavior and never lift the item out", async () => {
        // Arrange — empty out "a", whose item still owns the sublist with "b"
        const editor = await makeEditor("- a\n  - b\n");
        const view = getView(editor);
        placeCaretAfterText(view, "a");
        clearCurrentParagraph(view);

        // Act
        pressEnter(view);

        // Assert — no top-level paragraph escaped the list, and the sublist
        // (with "b") is still nested inside a list item
        expect(view.state.doc.childCount).toBe(1);
        expect(view.state.doc.child(0).type.name).toBe("bullet_list");
        let nestedListWithB = false;
        view.state.doc.descendants((node, _pos, parent) => {
            if (
                node.type.name === "bullet_list" &&
                parent?.type.name === "list_item" &&
                node.textContent === "b"
            ) {
                nestedListWithB = true;
            }
            return true;
        });
        expect(nestedListWithB).toBe(true);
    });
});
