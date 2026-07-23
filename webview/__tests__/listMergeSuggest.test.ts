/**
 * The "Merge with list above" caret advisory (listMergeSuggestPlugin),
 * driving the REAL Milkdown editor through the shared caret-suggest
 * controller. Contract (the inline-calc pattern): the row appears only while
 * the caret sits in the FIRST item of a list with a same-type sibling list
 * directly above; Tab confirms the merge; Enter keeps its newline meaning;
 * Escape dismisses until the caret leaves the context.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import type { Node as ProseNode } from "../pm";
import { TextSelection } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { listMergeSuggestPlugin } from "../plugins/listMergeSuggest";
import { calcSuggestPlugin } from "../plugins/calc";

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
        .use(listMergeSuggestPlugin)
        .create();
    editors.push(editor);
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Caret at the END of the text of item `itemIndex` in top-level list `listIndex`. */
function placeCaret(v: EditorView, listIndex: number, itemIndex: number): void {
    let listPos = -1;
    let i = 0;
    v.state.doc.forEach((_child: ProseNode, offset: number) => {
        if (i === listIndex) {
            listPos = offset;
        }
        i++;
    });
    const list = v.state.doc.nodeAt(listPos)!;
    let itemPos = listPos + 1;
    for (let j = 0; j < itemIndex; j++) {
        itemPos += list.child(j).nodeSize;
    }
    const item = list.child(itemIndex);
    const textEnd = itemPos + 2 + item.firstChild!.content.size;
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, textEnd)));
}

function menuRows(): string[] {
    return Array.from(
        document.querySelectorAll(".fm-suggest-menu .fm-suggest-item"),
    ).map((li) => li.querySelector(".fm-suggest-item__label")?.textContent ?? "");
}

const SPLIT = "- foo\n- bar\n\n* bingo\n* wingo\n";

describe("list-merge caret advisory", () => {
    let editor: Editor;
    let v: EditorView;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        editor = await makeEditor(SPLIT);
        v = view(editor);
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        for (const e of editors) {
            await e.destroy();
        }
        editors = [];
    });

    it("caret in the first item of the lower list should offer the merge", async () => {
        placeCaret(v, 1, 0);
        await vi.advanceTimersByTimeAsync(250);

        expect(menuRows()).toEqual(["Merge with list above"]);
    });

    it("caret elsewhere should offer nothing", async () => {
        placeCaret(v, 1, 1);
        await vi.advanceTimersByTimeAsync(250);
        expect(menuRows()).toEqual([]);

        placeCaret(v, 0, 0);
        await vi.advanceTimersByTimeAsync(250);
        expect(menuRows()).toEqual([]);
    });

    it("Tab should merge the lists into one", async () => {
        placeCaret(v, 1, 0);
        await vi.advanceTimersByTimeAsync(250);
        expect(menuRows()).toEqual(["Merge with list above"]);

        v.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

        expect(v.state.doc.childCount).toBe(1);
        expect(editor.action(getMarkdown())).toBe("- foo\n- bar\n- bingo\n- wingo\n");
        // The context is gone, so the menu must be too.
        await vi.advanceTimersByTimeAsync(250);
        expect(menuRows()).toEqual([]);
    });

    it("Enter should keep its newline meaning and never merge", async () => {
        placeCaret(v, 1, 0);
        await vi.advanceTimersByTimeAsync(250);
        expect(menuRows()).toEqual(["Merge with list above"]);

        const itemsBefore = v.state.doc.child(1).childCount;
        v.dom.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );

        // Still two lists (no merge), the menu closed, and Enter reached
        // ProseMirror (the item split — one more item in the lower list).
        expect(v.state.doc.childCount).toBe(2);
        expect(menuRows()).toEqual([]);
        expect(v.state.doc.child(1).childCount).toBe(itemsBefore + 1);
    });

    it("Escape should dismiss without merging", async () => {
        placeCaret(v, 1, 0);
        await vi.advanceTimersByTimeAsync(250);
        expect(menuRows()).toEqual(["Merge with list above"]);

        v.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

        expect(menuRows()).toEqual([]);
        expect(v.state.doc.childCount).toBe(2);
    });

    it("the row should carry a Tab confirm hint", async () => {
        placeCaret(v, 1, 0);
        await vi.advanceTimersByTimeAsync(250);

        const hint = document.querySelector(
            ".fm-suggest-menu .fm-suggest-item .fm-suggest-item__hint",
        );
        expect(hint?.textContent).toBe("Tab");
    });
});

describe("co-occurrence with text-construct suggestions", () => {
    afterEach(async () => {
        vi.useRealTimers();
        for (const e of editors) {
            await e.destroy();
        }
        editors = [];
    });

    it("typing a calc expression in the trigger item should show ONE menu (calc wins)", async () => {
        document.body.innerHTML = "";
        const root = document.createElement("div");
        document.body.appendChild(root);
        const editor = await Editor.make()
            .config((ctx) => {
                ctx.set(rootCtx, root);
                ctx.set(defaultValueCtx, SPLIT);
                configureSerialization(ctx);
            })
            .use(pureCommonmark)
            .use(gfmFidelity)
            .use(calcSuggestPlugin)
            .use(listMergeSuggestPlugin)
            .create();
        editors.push(editor);
        const cv = view(editor);
        placeCaret(cv, 1, 0); // end of "bingo" — the merge advisory's context
        vi.useFakeTimers();
        const { from } = cv.state.selection;
        cv.dispatch(cv.state.tr.insertText(" 2+3=", from));
        await vi.advanceTimersByTimeAsync(300);

        // Both specs match here; the advisory declares yieldsToOpenMenus, so
        // exactly one menu opens and it is the calc result (the construct the
        // user is actively typing), never a stacked pair claiming Tab twice.
        const menus = document.querySelectorAll(".fm-suggest-menu");
        expect(menus).toHaveLength(1);
        expect(menus[0]!.textContent).toContain("5");
        expect(menus[0]!.textContent).not.toContain("Merge with list above");
    });
});
