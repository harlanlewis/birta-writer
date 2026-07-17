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
import { calcSuggestPlugin, calcAutoInsertPlugin } from "../plugins/calc";

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

function optionTexts(): string[] {
    return Array.from(
        document.querySelectorAll(".fm-suggest-menu .fm-suggest-item"),
    ).map((li) => li.textContent ?? "");
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

    it("should not fire when auto-insert is off (advisory mode)", () => {
        window.__i18n = { translations: {}, isMac: false, calcAutoInsert: false };
        typeText(v, " 12*4");
        const handled = typeViaInput(v, "=");

        expect(handled).toBe(false);
    });
});
