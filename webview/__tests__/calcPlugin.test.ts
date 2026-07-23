/**
 * Inline-calc plugin tests, driving the REAL Milkdown editor: the advisory
 * caret suggestion (default) and its Tab confirmation (Return stays a newline), the opt-in
 * auto-insert input rule, and the enabled/auto-insert gating. The pure engine
 * is covered separately in calc.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    calcSuggestPlugin,
    calcAutoInsertPlugin,
    calcRefreshPlugin,
    calcArrowSuggestPlugin,
} from "../plugins/calc";

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
        .use(calcSuggestPlugin)
        .use(calcAutoInsertPlugin)
        .create();
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function placeCursorAtEnd(v: EditorView): void {
    const end = v.state.doc.content.size - 1;
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, end)));
}

function typeText(v: EditorView, text: string): void {
    const { from, to } = v.state.selection;
    v.dispatch(v.state.tr.insertText(text, from, to));
}

/** Simulates real typing of `text` at the caret, exercising input rules. */
function typeViaInput(v: EditorView, text: string): boolean {
    const { from, to } = v.state.selection;
    return (
        v.someProp("handleTextInput", (f) => f(v, from, to, text)) ?? false
    );
}

/** Row labels only — the confirm-key hint span and the trailing settings
 *  action row ("Always insert result") are chrome, not results. */
function optionTexts(): string[] {
    return Array.from(
        document.querySelectorAll(".fm-suggest-menu .fm-suggest-item:not(.fm-suggest-item--action)"),
    ).map((li) => li.querySelector(".fm-suggest-item__label")?.textContent ?? li.textContent ?? "");
}

describe("advisory inline calc", () => {
    let editor: Editor;
    let v: EditorView;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        delete window.__i18n; // defaults: calc enabled, advisory (not auto-insert)
        editor = await makeEditor("x\n");
        v = view(editor);
        placeCursorAtEnd(v);
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    it("typing an expression then = should show the result as a suggestion", async () => {
        typeText(v, " 2+3=");
        await vi.advanceTimersByTimeAsync(250);

        expect(optionTexts()).toEqual(["5"]);
    });

    it("Tab should insert the result, keeping the expression", async () => {
        typeText(v, " 2+3=");
        await vi.advanceTimersByTimeAsync(250);
        expect(optionTexts()).toEqual(["5"]);

        v.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

        expect(v.state.doc.textContent).toBe("x 2+3= 5");
    });

    it("Enter after the menu appears should keep its newline meaning (not insert)", async () => {
        typeText(v, " 6*7=");
        await vi.advanceTimersByTimeAsync(250);
        expect(optionTexts()).toEqual(["42"]);

        // Enter must NOT be captured by the pre-highlighted calc row: a
        // suggestion applies only on explicit consent (Tab), so the first Enter
        // proceeds to ProseMirror as a real newline. The result is never
        // inserted, the menu closes so it can't outlive the block, and the
        // paragraph splits (a new block appears) — proof Enter kept its meaning.
        const blocksBefore = v.state.doc.childCount;
        const ev = new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
        });
        v.dom.dispatchEvent(ev);

        expect(v.state.doc.textContent).toBe("x 6*7=");
        expect(optionTexts()).toEqual([]);
        expect(v.state.doc.childCount).toBe(blocksBefore + 1);
    });

    it("clicking the suggestion row should insert the result", async () => {
        typeText(v, " (3+4)/2=");
        await vi.advanceTimersByTimeAsync(250);

        const row = document.querySelector(".fm-suggest-menu .fm-suggest-item")!;
        row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        expect(v.state.doc.textContent).toBe("x (3+4)/2= 3.5");
    });

    it("the leading form =5+7 should offer 12 and Tab should produce 12=5+7", async () => {
        typeText(v, " =5+7");
        await vi.advanceTimersByTimeAsync(250);
        expect(optionTexts()).toEqual(["12"]);

        v.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

        expect(v.state.doc.textContent).toBe("x 12=5+7");
    });

    it("the result row should carry a Tab confirm hint", async () => {
        typeText(v, " 2+3=");
        await vi.advanceTimersByTimeAsync(250);

        const hint = document.querySelector(
            ".fm-suggest-menu .fm-suggest-item .fm-suggest-item__hint",
        );
        expect(hint?.textContent).toBe("Tab");
    });

    it("the 'Always insert result' action row should enable auto-insert AND answer the current ask", async () => {
        // Production always bakes __i18n into the HTML before any script runs;
        // the settings row flips its calcAutoInsert field in place.
        window.__i18n = { translations: {}, isMac: false, calcAutoInsert: false };
        typeText(v, " 2+3=");
        await vi.advanceTimersByTimeAsync(250);

        const actionRow = document.querySelector(
            ".fm-suggest-menu .fm-suggest-item--action",
        )!;
        expect(actionRow.textContent).toBe("Always insert result");
        actionRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        // The current expression completed…
        expect(v.state.doc.textContent).toBe("x 2+3= 5");
        // …the local gate flipped…
        expect(window.__i18n?.calcAutoInsert).toBe(true);
        // …and the advisory menu never shows again (auto-insert owns `=` now).
        typeText(v, " 6*7=");
        await vi.advanceTimersByTimeAsync(250);
        expect(document.querySelector(".fm-suggest-menu")).toBeNull();
    });

    it("Escape should dismiss the suggestion without inserting", async () => {
        typeText(v, " 2+3=");
        await vi.advanceTimersByTimeAsync(250);
        expect(optionTexts()).toEqual(["5"]);

        v.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

        expect(optionTexts()).toEqual([]);
        expect(v.state.doc.textContent).toBe("x 2+3=");
    });

    it("prose containing = should not trigger a suggestion", async () => {
        typeText(v, " total 42=");
        await vi.advanceTimersByTimeAsync(250);

        expect(optionTexts()).toEqual([]);
    });

    it("a non-computable expression should not trigger a suggestion", async () => {
        typeText(v, " 1/0=");
        await vi.advanceTimersByTimeAsync(250);

        expect(optionTexts()).toEqual([]);
    });

    it("should be silent when calc is disabled", async () => {
        window.__i18n = { translations: {}, isMac: false, calcEnabled: false };
        typeText(v, " 2+3=");
        await vi.advanceTimersByTimeAsync(250);

        expect(optionTexts()).toEqual([]);
    });
});

describe("`=>` living calculations (variables + units)", () => {
    async function makeArrowEditor(markdown: string): Promise<Editor> {
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
            .use(calcSuggestPlugin)
            .use(calcArrowSuggestPlugin)
            .create();
    }

    let editor: Editor;
    let v: EditorView;

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        delete window.__i18n; // defaults: calc enabled
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    it("typing an expression then => should show the result", async () => {
        editor = await makeArrowEditor("x\n");
        v = view(editor);
        placeCursorAtEnd(v);
        typeText(v, " 2+3 =>");
        await vi.advanceTimersByTimeAsync(250);

        expect(optionTexts()).toEqual(["5"]);
    });

    it("Tab should write the result after the =>, keeping the expression", async () => {
        editor = await makeArrowEditor("x\n");
        v = view(editor);
        placeCursorAtEnd(v);
        typeText(v, " 2+3 =>");
        await vi.advanceTimersByTimeAsync(250);
        v.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

        expect(v.state.doc.textContent).toBe("x 2+3 => 5");
    });

    it("a variable defined elsewhere in the document should resolve", async () => {
        editor = await makeArrowEditor("budget = 5000\n\nz\n");
        v = view(editor);
        placeCursorAtEnd(v);
        typeText(v, " budget / 100 =>");
        await vi.advanceTimersByTimeAsync(250);

        expect(optionTexts()).toEqual(["50"]);
    });

    it("an offline unit conversion should compute", async () => {
        editor = await makeArrowEditor("x\n");
        v = view(editor);
        placeCursorAtEnd(v);
        typeText(v, " 3 km in mi =>");
        await vi.advanceTimersByTimeAsync(250);

        const rows = optionTexts();
        expect(rows).toHaveLength(1);
        expect(rows[0].startsWith("1.864")).toBe(true);
    });

    // Place the caret at the end of the i-th top-level block.
    function caretAtBlockEnd(vw: EditorView, i: number): void {
        let start = 0;
        for (let j = 0; j < i; j++) { start += vw.state.doc.child(j).nodeSize; }
        const node = vw.state.doc.child(i);
        const pos = start + 1 + node.content.size;
        vw.dispatch(vw.state.tr.setSelection(TextSelection.create(vw.state.doc, pos)));
    }

    it("only definitions ABOVE the caret resolve (a later redefinition can't win)", async () => {
        editor = await makeArrowEditor("x = 1\n\nMID\n\nx = 9\n");
        v = view(editor);
        caretAtBlockEnd(v, 1); // in the middle block, between the two definitions
        typeText(v, " x * 10 =>");
        await vi.advanceTimersByTimeAsync(250);

        // x resolves to 1 (the definition above), not 9 (below the caret) → 10.
        expect(optionTexts()).toEqual(["10"]);
    });

    it("a definition inside a heading should be ignored (a title is not data)", async () => {
        editor = await makeArrowEditor("# Budget = 5000\n\nz\n");
        v = view(editor);
        placeCursorAtEnd(v);
        typeText(v, " Budget * 2 =>");
        await vi.advanceTimersByTimeAsync(250);

        expect(optionTexts()).toEqual([]); // Budget never defined → nothing offered
    });

    it("an undefined variable should offer nothing", async () => {
        editor = await makeArrowEditor("x\n");
        v = view(editor);
        placeCursorAtEnd(v);
        typeText(v, " mystery * 2 =>");
        await vi.advanceTimersByTimeAsync(250);

        expect(optionTexts()).toEqual([]);
    });

    it("a bare number before => should offer nothing", async () => {
        editor = await makeArrowEditor("x\n");
        v = view(editor);
        placeCursorAtEnd(v);
        typeText(v, " 42 =>");
        await vi.advanceTimersByTimeAsync(250);

        expect(optionTexts()).toEqual([]);
    });

    it("should be silent when calc is disabled", async () => {
        window.__i18n = { translations: {}, isMac: false, calcEnabled: false };
        editor = await makeArrowEditor("x\n");
        v = view(editor);
        placeCursorAtEnd(v);
        typeText(v, " 2+3 =>");
        await vi.advanceTimersByTimeAsync(250);

        expect(optionTexts()).toEqual([]);
    });
});

describe("auto-insert inline calc", () => {
    let editor: Editor;
    let v: EditorView;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        window.__i18n = { translations: {}, isMac: false, calcAutoInsert: true };
        editor = await makeEditor("x\n");
        v = view(editor);
        placeCursorAtEnd(v);
    });

    afterEach(async () => {
        await editor.destroy();
    });

    it("typing = after an expression should insert the result immediately", () => {
        typeText(v, " 12*4");
        const handled = typeViaInput(v, "=");

        expect(handled).toBe(true);
        expect(v.state.doc.textContent).toBe("x 12*4= 48");
    });

    it("typing = after prose should not be handled", () => {
        typeText(v, " hello");
        const handled = typeViaInput(v, "=");

        expect(handled).toBe(false);
        expect(v.state.doc.textContent).toBe("x hello");
    });

    it("a comma-grouped number must NOT auto-insert a fragment answer", () => {
        // The old handler detected against the pre-stripped run (match[0]),
        // so the left-boundary guards never fired: `1,000 + 2=` evaluated the
        // fragment `000 + 2` and inserted a WRONG `= 2`.
        typeText(v, " 1,000 + 2");
        const handled = typeViaInput(v, "=");

        expect(handled).toBe(false);
        expect(v.state.doc.textContent).toBe("x 1,000 + 2");
    });

    it("an operator with a prose operand must NOT auto-insert", () => {
        typeText(v, " y - 4");
        const handled = typeViaInput(v, "=");

        expect(handled).toBe(false);
        expect(v.state.doc.textContent).toBe("x y - 4");
    });

    it("should not fire when auto-insert is off (advisory mode)", () => {
        window.__i18n = { translations: {}, isMac: false, calcAutoInsert: false };
        typeText(v, " 12*4");
        const handled = typeViaInput(v, "=");

        expect(handled).toBe(false);
    });

    it("the LEADING form should stay advisory even in auto-insert mode", async () => {
        // `=5+7` has no finishing keystroke (the user may still be typing
        // digits), so auto-insert never fires for it — the menu offers instead.
        vi.useFakeTimers();
        typeText(v, " =5+7");
        await vi.advanceTimersByTimeAsync(250);

        expect(v.state.doc.textContent).toBe("x =5+7"); // nothing auto-inserted
        expect(document.querySelector(".fm-suggest-menu")).not.toBeNull();
        vi.useRealTimers();
    });
});

describe("auto-insert result refresh (editing an existing equation)", () => {
    async function makeRefreshEditor(markdown: string): Promise<Editor> {
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
            .use(calcSuggestPlugin)
            .use(calcAutoInsertPlugin)
            .use(calcRefreshPlugin)
            .create();
    }

    beforeEach(() => {
        document.body.innerHTML = "";
        (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
            translations: {}, isMac: true, calcEnabled: true, calcAutoInsert: true,
        };
    });
    afterEach(() => { vi.restoreAllMocks(); });

    /** Replace one character of the doc's first paragraph via a transaction. */
    function editChar(v: EditorView, offset: number, ch: string): void {
        // +1: paragraph start (block open token).
        v.dispatch(v.state.tr.insertText(ch, 1 + offset, 1 + offset + 1));
    }
    const blockText = (v: EditorView) => v.state.doc.firstChild?.textContent ?? "";

    it("editing the expression refreshes the stale answer", async () => {
        const editor = await makeRefreshEditor("3+4= 7");
        const v = view(editor);
        editChar(v, 0, "4"); // 3+4= 7 → 4+4= 7 → refresh → 4+4= 8
        expect(blockText(v)).toBe("4+4= 8");
        editor.destroy();
    });

    it("editing the RESULT is the user's override and is left alone", async () => {
        const editor = await makeRefreshEditor("3+4= 7");
        const v = view(editor);
        editChar(v, 5, "9"); // user rewrites the answer by hand
        expect(blockText(v)).toBe("3+4= 9");
        editor.destroy();
    });

    it("a mid-edit invalid expression leaves the text untouched until whole", async () => {
        const editor = await makeRefreshEditor("3+4= 7");
        const v = view(editor);
        // Delete the "4": "3+= 7" — not valid arithmetic; nothing rewrites.
        v.dispatch(v.state.tr.delete(3, 4));
        expect(blockText(v)).toBe("3+= 7");
        editor.destroy();
    });

    it("advisory mode (autoInsert off) never rewrites the document", async () => {
        (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
            translations: {}, isMac: true, calcEnabled: true, calcAutoInsert: false,
        };
        const editor = await makeRefreshEditor("3+4= 7");
        const v = view(editor);
        editChar(v, 0, "4");
        expect(blockText(v)).toBe("4+4= 7"); // stale, but untouched — consent rule
        editor.destroy();
    });

    it("LEADING form: editing the expression refreshes the answer before the =", async () => {
        const editor = await makeRefreshEditor("12=5+7");
        const v = view(editor);
        // "5" is at offset 3; make it 6 → 12=6+7 → refresh → 13=6+7.
        editChar(v, 3, "6");
        expect(blockText(v)).toBe("13=6+7");
        editor.destroy();
    });

    it("LEADING form: editing the RESULT is the user's override and left alone", async () => {
        const editor = await makeRefreshEditor("12=5+7");
        const v = view(editor);
        editChar(v, 0, "9"); // hand-edit the answer → 92=5+7, untouched
        expect(blockText(v)).toBe("92=5+7");
        editor.destroy();
    });

    it("LEADING form: a prose assignment (letter before the number) never rewrites", async () => {
        const editor = await makeRefreshEditor("a12=5+7");
        const v = view(editor);
        // Edit the 5 → 6: the excised text is "a=6+7", which the leading
        // boundary rule rejects (prose assignment), so nothing rewrites.
        editChar(v, 4, "6");
        expect(blockText(v)).toBe("a12=6+7");
        editor.destroy();
    });

    it("undo reverts the edit and the refreshed answer together", async () => {
        const editor = await makeRefreshEditor("3+4= 7");
        const v = view(editor);
        editChar(v, 0, "4");
        expect(blockText(v)).toBe("4+4= 8");
        editor.destroy();
    });
});
