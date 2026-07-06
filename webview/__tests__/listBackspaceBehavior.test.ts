/**
 * End-to-end tests for the list Backspace/Delete plugin (listLiftPlugin) and
 * the list spread normalization plugin, driving the REAL Milkdown editor:
 * real parser, real schema, the production serialization config, and the
 * list plugins registered exactly as webview/editor.ts registers them.
 *
 * Required behavior:
 * - Backspace/Delete on an EMPTY list item (that is not the list's only
 *   item) deletes the item; Backspace places the caret in the previous item.
 * - Backspace at the START of a non-empty item lifts it (outdent / exit).
 * - Backspace mid-text is not intercepted by the plugin.
 * - After deleting a nested sublist out of a loose item, the stale
 *   spread:true is reset so serialization does not insert blank lines.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, pureCommonmark } from "../serialization";
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
        .use(gfm)
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
    document.body.innerHTML = "";
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

/** Press a key through the real keydown pipeline (all plugins, real order). */
function pressKey(view: EditorView, key: string): boolean {
    const event = new KeyboardEvent("keydown", {
        key,
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

describe("Backspace on an empty list item", () => {
    it("an empty LATER item should be deleted with the caret in the previous item", async () => {
        // Arrange — `- a / - b`, then empty out "b"
        const editor = await makeEditor("- a\n- b\n");
        const view = getView(editor);
        placeCaretAfterText(view, "b");
        clearCurrentParagraph(view);

        // Act
        const handled = pressKey(view, "Backspace");

        // Assert — only "a" remains; caret ended up inside it
        expect(handled).toBe(true);
        expect(topLevel(view)).toEqual([["bullet_list", "a"]]);
        expect(view.state.doc.child(0).childCount).toBe(1);
        expect(view.state.selection.$from.parent.textContent).toBe("a");
    });

    it("an empty FIRST item should be deleted keeping the rest of the list", async () => {
        // Arrange — empty out "a" (index 0 → the other targetPos branch)
        const editor = await makeEditor("- a\n- b\n");
        const view = getView(editor);
        placeCaretAfterText(view, "a");
        clearCurrentParagraph(view);

        // Act
        const handled = pressKey(view, "Backspace");

        // Assert
        expect(handled).toBe(true);
        expect(topLevel(view)).toEqual([["bullet_list", "b"]]);
        expect(view.state.doc.child(0).childCount).toBe(1);
    });

    it("the ONLY empty item should lift out of the list into a paragraph", async () => {
        // Arrange — single item, emptied (deleteEmptyListItem declines:
        // childCount <= 1 — the lift fallback must handle it)
        const editor = await makeEditor("- a\n");
        const view = getView(editor);
        placeCaretAfterText(view, "a");
        clearCurrentParagraph(view);

        // Act
        const handled = pressKey(view, "Backspace");

        // Assert — no list left, just an empty paragraph
        expect(handled).toBe(true);
        expect(topLevel(view)).toEqual([["paragraph", ""]]);
    });
});

describe("Backspace at the start of a non-empty list item", () => {
    it("a top-level item should lift out of the list as a paragraph", async () => {
        // Arrange — caret at the START of "b" (parentOffset 0, non-empty)
        const editor = await makeEditor("- a\n- b\n");
        const view = getView(editor);
        placeCaretAfterText(view, "b");
        const { $from } = view.state.selection;
        view.dispatch(
            view.state.tr.setSelection(
                TextSelection.create(view.state.doc, $from.start()),
            ),
        );

        // Act
        const handled = pressKey(view, "Backspace");

        // Assert — "b" left the list, its text intact
        expect(handled).toBe(true);
        expect(topLevel(view)).toEqual([
            ["bullet_list", "a"],
            ["paragraph", "b"],
        ]);
    });

    it("a nested item should outdent one level", async () => {
        // Arrange
        const editor = await makeEditor("- a\n  - b\n");
        const view = getView(editor);
        placeCaretAfterText(view, "b");
        const { $from } = view.state.selection;
        view.dispatch(
            view.state.tr.setSelection(
                TextSelection.create(view.state.doc, $from.start()),
            ),
        );

        // Act
        const handled = pressKey(view, "Backspace");

        // Assert — "b" is now a top-level sibling of "a"
        expect(handled).toBe(true);
        expect(view.state.doc.childCount).toBe(1);
        const list = view.state.doc.child(0);
        expect(list.childCount).toBe(2);
        expect(list.child(0).textContent).toBe("a");
        expect(list.child(1).textContent).toBe("b");
        const serialized = editor.action(getMarkdown());
        expect(serialized).not.toMatch(/^\s+-/m); // no nested item left
    });

    it("Backspace mid-text should not be intercepted and must not change the doc", async () => {
        // Arrange — caret between "a" and "b" of "ab" (parentOffset > 0)
        const editor = await makeEditor("- ab\n");
        const view = getView(editor);
        placeCaretAfterText(view, "ab");
        const { $from } = view.state.selection;
        view.dispatch(
            view.state.tr.setSelection(
                TextSelection.create(view.state.doc, $from.pos - 1),
            ),
        );
        const before = view.state.doc;

        // Act — no keymap handles mid-text Backspace (the DOM does in a real
        // browser); the plugin must decline so it reaches the DOM path
        const handled = pressKey(view, "Backspace");

        // Assert
        expect(handled).toBe(false);
        expect(view.state.doc.eq(before)).toBe(true);
    });

    it("Backspace at the start of a plain paragraph outside any list should not be intercepted", async () => {
        // Arrange
        const editor = await makeEditor("plain\n");
        const view = getView(editor);
        view.dispatch(
            view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)),
        );
        const before = view.state.doc;

        // Act / Assert — listItemDepth < 0 → the plugin declines
        pressKey(view, "Backspace");
        expect(view.state.doc.eq(before)).toBe(true);
        expect(topLevel(view)).toEqual([["paragraph", "plain"]]);
    });
});

describe("Delete on a list item", () => {
    it("an empty item should be deleted", async () => {
        // Arrange
        const editor = await makeEditor("- a\n- b\n");
        const view = getView(editor);
        placeCaretAfterText(view, "b");
        clearCurrentParagraph(view);

        // Act
        const handled = pressKey(view, "Delete");

        // Assert
        expect(handled).toBe(true);
        expect(topLevel(view)).toEqual([["bullet_list", "a"]]);
    });

    it("Delete mid-text of a non-empty item should not be intercepted", async () => {
        // Arrange — caret between "a" and "b" of "ab": deleteEmptyListItem
        // declines (parentOffset > 0 and the item is not empty)
        const editor = await makeEditor("- ab\n- c\n");
        const view = getView(editor);
        placeCaretAfterText(view, "ab");
        const { $from } = view.state.selection;
        view.dispatch(
            view.state.tr.setSelection(
                TextSelection.create(view.state.doc, $from.pos - 1),
            ),
        );
        const before = view.state.doc;

        // Act — forward-delete mid-text is the DOM's job in a real browser;
        // every keymap (ours included) must decline
        const handled = pressKey(view, "Delete");

        // Assert
        expect(handled).toBe(false);
        expect(view.state.doc.eq(before)).toBe(true);
    });
});

describe("list spread normalization after deleting a nested sublist", () => {
    it("deleting a loose item's sublist should serialize the list tight again", async () => {
        // Arrange — loose list: item "a" holds a sublist, so the list
        // serializes with blank lines between items
        const editor = await makeEditor("- a\n\n  - x\n\n- b\n");
        const view = getView(editor);
        expect(editor.action(getMarkdown())).toContain("\n\n");

        // Act — delete the nested sublist (the whole bullet_list under "a")
        let sublist: { pos: number; size: number } | null = null;
        view.state.doc.descendants((node, pos, parent) => {
            if (
                node.type.name === "bullet_list" &&
                parent?.type.name === "list_item"
            ) {
                sublist = { pos, size: node.nodeSize };
                return false;
            }
            return true;
        });
        expect(sublist).not.toBeNull();
        view.dispatch(
            view.state.tr.delete(sublist!.pos, sublist!.pos + sublist!.size),
        );

        // Assert — the appendTransaction reset the stale spread flags, so no
        // blank lines are serialized between the remaining items
        const serialized = editor.action(getMarkdown());
        expect(serialized.trim()).toBe("- a\n- b");
    });

    it("editing OUTSIDE a loose list should not reset its spacing", async () => {
        // Arrange — a loose list plus a separate trailing paragraph
        const editor = await makeEditor("- a\n\n- b\n\ntail\n");
        const view = getView(editor);
        const before = editor.action(getMarkdown());
        expect(before).toContain("- a\n\n- b"); // genuinely loose

        // Act — edit only the trailing paragraph
        placeCaretAfterText(view, "tail");
        const { from } = view.state.selection;
        view.dispatch(view.state.tr.insertText("!", from));

        // Assert — the loose list keeps its blank lines
        expect(editor.action(getMarkdown())).toContain("- a\n\n- b");
    });
});
