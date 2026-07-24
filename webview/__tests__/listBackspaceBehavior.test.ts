/**
 * End-to-end tests for the list Backspace/Delete plugin (listLiftPlugin) and
 * the list spread normalization plugin, driving the REAL Milkdown editor:
 * real parser, real schema, the production serialization config, and the
 * list plugins registered exactly as webview/editor.ts registers them.
 *
 * Required behavior:
 * - Backspace (and Cmd+Backspace) at the start of a NESTED item joins it
 *   onto the previous visible line, its subtree following one level up.
 * - Backspace/Delete on an EMPTY top-level item (that is not the list's
 *   only item) deletes the item; Backspace places the caret in the
 *   previous item.
 * - Backspace at the START of a non-empty TOP-LEVEL item lifts it out of
 *   the list as a paragraph ("remove the bullet").
 * - Backspace mid-text is not intercepted by the plugin.
 * - Spread: the editor never flips a list's tight/loose character on its
 *   own — normalization only ADDS the blank line Markdown requires (a
 *   paragraph following another block in an item). The deliberate switch
 *   is the explicit Tighten/Loosen List action (setListTreeSpread).
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, commandsCtx } from "@milkdown/core";
import { wrapInBulletListCommand } from "@milkdown/preset-commonmark";
import { TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    listEnterPlugin,
    listLiftPlugin,
    listSpreadNormalizePlugin,
} from "../plugins";
import { listTreeIsLoose, setListTreeSpread } from "../plugins/list";

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
function pressKey(
    view: EditorView,
    key: string,
    modifiers?: { ctrlKey?: boolean; metaKey?: boolean },
): boolean {
    const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...modifiers,
    });
    return (
        view.someProp("handleKeyDown", (handler) => handler(view, event)) ??
        false
    );
}

/** Place the caret at the START of the first text node equal to `text`. */
function placeCaretBeforeText(view: EditorView, text: string): void {
    placeCaretAfterText(view, text);
    const { $from } = view.state.selection;
    view.dispatch(
        view.state.tr.setSelection(
            TextSelection.create(view.state.doc, $from.start()),
        ),
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

    it("a nested item should JOIN onto its parent's line, not outdent", async () => {
        // Arrange — the maintainer ruling (2026-07-23): Backspace at a nested
        // item's start deletes the item BREAK, like a text editor joining
        // lines — repeated outdenting was unpredictable.
        const editor = await makeEditor("- a\n  - b\n");
        const view = getView(editor);
        placeCaretBeforeText(view, "b");

        // Act
        const handled = pressKey(view, "Backspace");

        // Assert — "b" merged into "a"'s own line; no sublist remains
        expect(handled).toBe(true);
        expect(view.state.doc.childCount).toBe(1);
        const list = view.state.doc.child(0);
        expect(list.childCount).toBe(1);
        expect(list.child(0).textContent).toBe("ab");
        expect(editor.action(getMarkdown())).toBe("- ab\n");
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

describe("Backspace/Cmd+Backspace joining nested items", () => {
    it("a deep item should join the previous line and carry its children up one level", async () => {
        const editor = await makeEditor(
            "- foo\n- bar\n  - baz\n    - juj\n      - rex\n        - umi\n  - bin\n",
        );
        const view = getView(editor);
        placeCaretBeforeText(view, "juj");

        const handled = pressKey(view, "Backspace");

        expect(handled).toBe(true);
        // bar keeps two children: the merged "bazjuj" item, then "bin".
        const bar = view.state.doc.child(0).child(1);
        const barList = bar.lastChild!;
        expect(barList.childCount).toBe(2);
        const merged = barList.child(0);
        expect(merged.firstChild?.textContent).toBe("bazjuj");
        expect(barList.child(1).textContent).toBe("bin");
        // juj's subtree is re-parented under the merged item, one level up.
        const mergedSub = merged.lastChild!;
        expect(mergedSub.type.name).toBe("bullet_list");
        expect(mergedSub.child(0).firstChild?.textContent).toBe("rex");
        expect(mergedSub.child(0).lastChild?.child(0).textContent).toBe("umi");
        expect(editor.action(getMarkdown())).toBe(
            "- foo\n- bar\n  - bazjuj\n    - rex\n      - umi\n  - bin\n",
        );
    });

    it("an emptied nested first child should delete on Cmd+Backspace with the caret on the parent line", async () => {
        const editor = await makeEditor("- foo\n- bar\n  - baz\n  - bin\n");
        const view = getView(editor);
        placeCaretAfterText(view, "baz");
        clearCurrentParagraph(view);

        // prosemirror-keymap reads Mod- as Ctrl on jsdom's non-mac platform.
        const handled = pressKey(view, "Backspace", { ctrlKey: true });

        expect(handled).toBe(true);
        const bar = view.state.doc.child(0).child(1);
        expect(bar.firstChild?.textContent).toBe("bar");
        expect(bar.lastChild?.childCount).toBe(1);
        expect(bar.lastChild?.child(0).textContent).toBe("bin");
        expect(view.state.selection.$from.parent.textContent).toBe("bar");
    });

    it("a nested later item with children should join and keep them one level down", async () => {
        const editor = await makeEditor("- a\n  - b\n  - c\n    - kid\n");
        const view = getView(editor);
        placeCaretBeforeText(view, "c");

        const handled = pressKey(view, "Backspace");

        expect(handled).toBe(true);
        const sub = view.state.doc.child(0).child(0).lastChild!;
        expect(sub.childCount).toBe(1);
        const merged = sub.child(0);
        expect(merged.firstChild?.textContent).toBe("bc");
        expect(merged.lastChild?.child(0).textContent).toBe("kid");
    });

    it("a nested LATER item should join onto the previous sibling's line", async () => {
        const editor = await makeEditor("- a\n  - b\n  - c\n");
        const view = getView(editor);
        placeCaretBeforeText(view, "c");

        const handled = pressKey(view, "Backspace");

        expect(handled).toBe(true);
        const sub = view.state.doc.child(0).child(0).lastChild!;
        expect(sub.childCount).toBe(1);
        expect(sub.child(0).textContent).toBe("bc");
    });

    it("join with children AND trailing siblings should land them at one shared level", async () => {
        const editor = await makeEditor("- top\n  - baz\n    - juj\n      - rex\n    - sib\n");
        const view = getView(editor);
        placeCaretBeforeText(view, "juj");

        const handled = pressKey(view, "Backspace");

        expect(handled).toBe(true);
        // juj's child (rex) follows it up one level, becoming sib's sibling.
        expect(editor.action(getMarkdown())).toBe(
            "- top\n  - bazjuj\n    - rex\n    - sib\n",
        );
    });

    it("an item after a code block must NEVER join into the code — falls back to lift", async () => {
        // Fidelity guard: joining would pour "juj" verbatim inside the fence
        // (one keystroke silently converting prose into code).
        const editor = await makeEditor("- alpha\n\n  ```\n  code\n  ```\n\n  - juj\n");
        const view = getView(editor);
        placeCaretBeforeText(view, "juj");

        const handled = pressKey(view, "Backspace");

        expect(handled).toBe(true);
        const serialized = editor.action(getMarkdown());
        expect(serialized).not.toContain("codejuj");
        expect(serialized).toContain("juj");
    });

    it("Cmd+Backspace mid-line must not be intercepted (delete-to-line-start is the DOM's)", async () => {
        const editor = await makeEditor("- a\n  - b\n");
        const view = getView(editor);
        placeCaretAfterText(view, "b");
        const before = view.state.doc;

        const handled = pressKey(view, "Backspace", { ctrlKey: true });

        expect(handled).toBe(false);
        expect(view.state.doc.eq(before)).toBe(true);
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

describe("list spread normalization — the editor never flips a list's character", () => {
    it("deleting a loose item's sublist should KEEP the list's loose character", async () => {
        // Maintainer ruling (2026-07-24): tight/loose is the author's call —
        // it changes the RENDERED output (<p> wrapping), so no edit may
        // rewrite it. Cleanup is the explicit Tighten List action.
        const editor = await makeEditor("- a\n\n  - x\n\n- b\n");
        const view = getView(editor);

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

        expect(editor.action(getMarkdown())).toBe("- a\n\n- b\n");
    });

    it("Enter splitting an item in a TIGHT list should stay tight", async () => {
        const editor = await makeEditor("- aa\n- b\n");
        const view = getView(editor);
        placeCaretAfterText(view, "aa");
        const { $from } = view.state.selection;
        view.dispatch(
            view.state.tr.setSelection(
                TextSelection.create(view.state.doc, $from.pos - 1),
            ),
        );
        pressKey(view, "Enter");

        expect(editor.action(getMarkdown())).toBe("- a\n- a\n- b\n");
    });

    it("Enter splitting an item in a LOOSE list should stay loose", async () => {
        const editor = await makeEditor("- aa\n\n- b\n");
        const view = getView(editor);
        placeCaretAfterText(view, "aa");
        const { $from } = view.state.selection;
        view.dispatch(
            view.state.tr.setSelection(
                TextSelection.create(view.state.doc, $from.pos - 1),
            ),
        );
        pressKey(view, "Enter");

        expect(editor.action(getMarkdown())).toBe("- a\n\n- a\n\n- b\n");
    });

    it("typing inside a TIGHT nested list should keep it tight", async () => {
        // Regression: the normalizer used to force spread=true on any item
        // with more than one child, so one keystroke inside a nested list
        // loosened the whole structure with blank lines.
        const editor = await makeEditor("- bar\n  - baz\n");
        const view = getView(editor);
        placeCaretAfterText(view, "baz");
        view.dispatch(view.state.tr.insertText("!"));

        expect(editor.action(getMarkdown())).toBe("- bar\n  - baz!\n");
    });

    it("typing inside an authored-LOOSE list should keep its blank lines", async () => {
        // Regression: pure typing must never rewrite authored spacing — a
        // stale spread is only relaxed after a STRUCTURAL change (the
        // delete-sublist case above), never by a keystroke.
        const editor = await makeEditor("- a\n\n- b\n");
        const view = getView(editor);
        placeCaretAfterText(view, "a");
        view.dispatch(view.state.tr.insertText("!"));

        expect(editor.action(getMarkdown())).toBe("- a!\n\n- b\n");
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

describe("editor-created list items are born tight", () => {
    it("turning a paragraph into a list should create a TIGHT item", async () => {
        // The stock schema default was spread:true — masked by the old
        // aggressive normalizer, fatal under force-only preservation.
        const editor = await makeEditor("hello\n\nworld\n");
        const view = getView(editor);
        view.dispatch(
            view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)),
        );
        editor.action((ctx) =>
            ctx.get(commandsCtx).call(wrapInBulletListCommand.key),
        );

        const item = view.state.doc.firstChild?.firstChild;
        expect(item?.type.name).toBe("list_item");
        expect(item?.attrs["spread"]).toBe(false);

        // Growing the list keeps it tight (split copies the item's attrs).
        placeCaretAfterText(view, "hello");
        pressKey(view, "Enter");
        view.dispatch(view.state.tr.insertText("x"));
        expect(editor.action(getMarkdown())).toBe("- hello\n- x\n\nworld\n");
    });
});

describe("setListTreeSpread — the explicit Tighten / Loosen List action", () => {
    async function listAt(md: string) {
        const editor = await makeEditor(md);
        const view = getView(editor);
        let pos = -1;
        view.state.doc.forEach((node, offset) => {
            if (pos < 0 && node.type.name === "bullet_list") pos = offset;
        });
        expect(pos).toBeGreaterThanOrEqual(0);
        return { editor, view, pos };
    }

    it("tightening a loose list should remove its blank lines (nested lists too)", async () => {
        const { editor, view, pos } = await listAt("- a\n\n  - x\n\n  - y\n\n- b\n");
        expect(listTreeIsLoose(view.state.doc, pos)).toBe(true);

        expect(setListTreeSpread(view, pos, false)).toBe(true);

        expect(editor.action(getMarkdown())).toBe("- a\n  - x\n  - y\n- b\n");
        expect(listTreeIsLoose(view.state.doc, pos)).toBe(false);
    });

    it("tightening should keep the blank line a multi-paragraph item requires", async () => {
        const { editor, view, pos } = await listAt("- a\n\n  second\n\n- b\n");

        setListTreeSpread(view, pos, false);

        // The multi-paragraph item stays loose (tight would lazy-merge the
        // paragraphs on reparse — byte loss); the sibling boundary follows
        // the list's loose serialization.
        expect(editor.action(getMarkdown())).toContain("- a\n\n  second");
    });

    it("loosening a tight list should blank-line every boundary and round-trip back", async () => {
        const { editor, view, pos } = await listAt("- a\n  - x\n- b\n");

        expect(setListTreeSpread(view, pos, true)).toBe(true);
        expect(editor.action(getMarkdown())).toBe("- a\n\n  - x\n\n- b\n");

        expect(setListTreeSpread(view, pos, false)).toBe(true);
        expect(editor.action(getMarkdown())).toBe("- a\n  - x\n- b\n");
    });

    it("a no-op call should not dispatch (already tight)", async () => {
        const { view, pos } = await listAt("- a\n- b\n");
        expect(setListTreeSpread(view, pos, false)).toBe(false);
    });
});
