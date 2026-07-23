/**
 * Inline-calc plugin tests, driving the REAL Milkdown editor: the advisory
 * caret suggestion (default) and its Tab confirmation (Return stays a newline), the opt-in
 * auto-insert input rule, and the enabled/auto-insert gating. The pure engine
 * is covered separately in calc.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { ensureCalcUnits } from "../utils/calc";

// The `=>` fetch path awaits the lazy unit engine; preload once (under real
// timers) so the fake-timer tests below see synchronous resolution.
beforeAll(() => ensureCalcUnits());
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection, history, undo } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    calcSuggestPlugin,
    calcAutoInsertPlugin,
    calcRefreshPlugin,
    calcArrowSuggestPlugin,
} from "../plugins/calc";
import { EXTERNAL_SYNC_META } from "../plugins/docChange";

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

    it("the = menu should carry a non-interactive footer teaching =>", async () => {
        typeText(v, " 2+3=");
        await vi.advanceTimersByTimeAsync(250);

        const footer = document.querySelector(".fm-suggest-menu .fm-suggest-footer");
        // Present, decorative (aria-hidden), and never a pickable option row.
        expect(footer?.textContent).toContain("=>");
        expect(footer?.getAttribute("aria-hidden")).toBe("true");
        expect(footer?.getAttribute("role")).toBeNull();
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

    it("should be silent when calc is disabled (advisory `=`)", async () => {
        window.__i18n = { translations: {}, isMac: false, calcEnabled: false };
        typeText(v, " 2+3=");
        await vi.advanceTimersByTimeAsync(250);

        expect(optionTexts()).toEqual([]);
    });

    it("re-accepting at `expr =| old` REPLACES the stale answer, never inserts beside it", async () => {
        const stale = await makeEditor("3+4= 9");
        const sv = view(stale);
        // Park the caret right after the `=` — the old answer sits beyond it,
        // outside the caret-anchored match, and used to survive the insert.
        sv.dispatch(sv.state.tr.setSelection(TextSelection.create(sv.state.doc, 5)));
        await vi.advanceTimersByTimeAsync(250);
        sv.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        expect(sv.state.doc.firstChild?.textContent).toBe("3+4= 7"); // not "3+4= 7 9"
        await stale.destroy();
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

    it("re-accepting at `expr =>| old` REPLACES the stale answer, never inserts beside it", async () => {
        editor = await makeArrowEditor("2+3 => 99");
        v = view(editor);
        // Caret right after the `=>` — the stale 99 sits beyond it, outside
        // the caret-anchored match, and used to survive the insert.
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 7)));
        await vi.advanceTimersByTimeAsync(250);
        v.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        expect(v.state.doc.firstChild?.textContent).toBe("2+3 => 5"); // not "2+3 => 5 99"
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

    it("`=` refreshes in advisory mode too — maintenance is not insertion", async () => {
        // autoInsert governs only whether typing `=` INSERTS unprompted; an
        // answer that already exists updates when its expression is edited,
        // whatever the mode (the maintainer's expectation: `3+4=7` edited to
        // `4+4=` reads `=8`, live).
        (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
            translations: {}, isMac: true, calcEnabled: true, calcAutoInsert: false,
        };
        const editor = await makeRefreshEditor("3+4=7");
        const v = view(editor);
        editChar(v, 0, "4");
        expect(blockText(v)).toBe("4+4=8");
        editor.destroy();
    });

    it("calc disabled: nothing ever refreshes", async () => {
        (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
            translations: {}, isMac: true, calcEnabled: false, calcAutoInsert: true,
        };
        const editor = await makeRefreshEditor("3+4= 7\n\n2+3 => 5");
        const v = view(editor);
        editChar(v, 0, "4");
        expect(blockText(v)).toBe("4+4= 7");
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

    it("one transaction touching equations in TWO blocks refreshes both without corruption", async () => {
        // Regression: the second rewrite's positions were computed against
        // newState but never mapped through the first rewrite's step — when
        // the first result changed length (7 → 14), the second landed at
        // shifted offsets and produced garbage like "9+7=163".
        const editor = await makeRefreshEditor("4+5= 9\n\n6+7= 13");
        const v = view(editor);
        // Paragraph 1 content starts at 1, paragraph 2 at nodeSize(p1)+1 = 9.
        const tr = v.state.tr
            .insertText("9", 1, 2)   // 4+5= 9 → 9+5= 9
            .insertText("9", 9, 10); // 6+7= 13 → 9+7= 13 (same-length edits: no shift)
        v.dispatch(tr);
        const texts = [] as string[];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts).toEqual(["9+5= 14", "9+7= 16"]);
        editor.destroy();
    });

    it("an external-sync transaction never triggers a refresh", async () => {
        // An edit replayed from OUTSIDE this editor (raw text editor, git)
        // carries EXTERNAL_SYNC_META; whatever result the on-disk author
        // wrote is their text. Rewriting it would dirty the document with no
        // user action and fight the file on disk (anchorSync's exemption).
        const editor = await makeRefreshEditor("3+4= 7");
        const v = view(editor);
        v.dispatch(
            v.state.tr.insertText("4", 1, 2).setMeta(EXTERNAL_SYNC_META, true),
        );
        expect(blockText(v)).toBe("4+4= 7"); // stale exactly as on disk
        editor.destroy();
    });

    it("`=>` refreshes on expression edits even in ADVISORY mode (no auto-insert)", async () => {
        (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
            translations: {}, isMac: true, calcEnabled: true, calcAutoInsert: false,
        };
        const editor = await makeRefreshEditor("2+3 => 5");
        const v = view(editor);
        editChar(v, 0, "4"); // 2+3 => 5  →  4+3 => 7
        expect(blockText(v)).toBe("4+3 => 7");
        editor.destroy();
    });

    it("editing an upstream definition cascades to every `=>` below it", async () => {
        (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
            translations: {}, isMac: true, calcEnabled: true, calcAutoInsert: false,
        };
        const editor = await makeRefreshEditor("x = 4\n\ny = 2\n\nx+y => 6\n\nx*2 => 8");
        const v = view(editor);
        // Rewrite the definition's value: x = 4 → x = 5 ("4" is at offset 4).
        editChar(v, 4, "5");
        const texts: string[] = [];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts).toEqual(["x = 5", "y = 2", "x+y => 7", "x*2 => 10"]);
        editor.destroy();
    });

    it("editing the `=>` RESULT is the user's override and is left alone", async () => {
        (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
            translations: {}, isMac: true, calcEnabled: true, calcAutoInsert: false,
        };
        const editor = await makeRefreshEditor("2+3 => 5");
        const v = view(editor);
        editChar(v, 7, "9"); // hand-rewrite the answer
        expect(blockText(v)).toBe("2+3 => 9");
        editor.destroy();
    });

    it("a `=>` with no accepted answer is never touched (nothing to maintain)", async () => {
        (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
            translations: {}, isMac: true, calcEnabled: true, calcAutoInsert: false,
        };
        const editor = await makeRefreshEditor("x = 4\n\nx+1 =>");
        const v = view(editor);
        editChar(v, 4, "5");
        const texts: string[] = [];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts).toEqual(["x = 5", "x+1 =>"]); // the advisory menu owns this case
        editor.destroy();
    });

    it("a definition on a HARDBREAK line still cascades (not just first-line defs)", async () => {
        (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
            translations: {}, isMac: true, calcEnabled: true, calcAutoInsert: false,
        };
        const editor = await makeRefreshEditor("Notes:\\\nx = 4\n\nx*2 => 8");
        const v = view(editor);
        // "x = 4" is the second visual line of the first block; edit its 4.
        const idx = v.state.doc.firstChild!.textContent.indexOf("4");
        editChar(v, idx, "5");
        const texts: string[] = [];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts[1]).toBe("x*2 => 10");
        editor.destroy();
    });

    it("a prose comma directly after the result survives a refresh", async () => {
        (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
            translations: {}, isMac: true, calcEnabled: true, calcAutoInsert: false,
        };
        const editor = await makeRefreshEditor("2+3 => 5, then more");
        const v = view(editor);
        editChar(v, 2, "4");
        expect(blockText(v)).toBe("2+4 => 6, then more");
        editor.destroy();
    });

    it("editing an arrow's RESULT in a definition-bearing block is NOT refought", async () => {
        (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
            translations: {}, isMac: true, calcEnabled: true, calcAutoInsert: false,
        };
        const editor = await makeRefreshEditor("x = 4\\\nx*2 => 8");
        const v = view(editor);
        // Hand-edit the 8 → 9: the block holds a definition, so the cascade
        // runs — but the user's own edit is the override and must stand.
        const idx = v.state.doc.firstChild!.textContent.indexOf("8");
        editChar(v, idx, "9");
        expect(v.state.doc.firstChild!.textContent).toContain("x*2 => 9");
        editor.destroy();
    });

    it("a constant-only arrow never depends on definitions (overrides persist)", async () => {
        (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
            translations: {}, isMac: true, calcEnabled: true, calcAutoInsert: false,
        };
        const editor = await makeRefreshEditor("x = 4\n\n2+3 => 99");
        const v = view(editor);
        editChar(v, 4, "5"); // edit x — 2+3 has no variables, 99 is the user's
        const texts: string[] = [];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts[1]).toBe("2+3 => 99");
        editor.destroy();
    });

    it("advisory `=` leaves prose annotations alone (result followed by a word)", async () => {
        (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
            translations: {}, isMac: true, calcEnabled: true, calcAutoInsert: false,
        };
        const editor = await makeRefreshEditor("Dec 24-26 = 3 days off");
        const v = view(editor);
        const idx = v.state.doc.firstChild!.textContent.indexOf("24");
        editChar(v, idx + 1, "3"); // 24 → 23
        expect(blockText(v)).toBe("Dec 23-26 = 3 days off"); // never "-3 days"
        editor.destroy();
    });

    it("a definition inside inline code never feeds the scope or cascades", async () => {
        (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
            translations: {}, isMac: true, calcEnabled: true, calcAutoInsert: false,
        };
        const editor = await makeRefreshEditor("`x = 4`\n\nx*2 => 8");
        const v = view(editor);
        const idx = v.state.doc.firstChild!.textContent.indexOf("4");
        editChar(v, idx, "5"); // edit inside the backticks
        const texts: string[] = [];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts[1]).toBe("x*2 => 8"); // untouched — backticked text is source
        editor.destroy();
    });

    it("an equation inside inline code is source, never rewritten", async () => {
        (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
            translations: {}, isMac: true, calcEnabled: true, calcAutoInsert: false,
        };
        const editor = await makeRefreshEditor("see `2+3 => 5` here");
        const v = view(editor);
        // Edit the "2" inside the backticked span (offset 4 in the text).
        editChar(v, 4, "4");
        expect(blockText(v)).toBe("see 4+3 => 5 here"); // stale, untouched
        editor.destroy();
    });

    it("a digit-heavy long line stays responsive (no quadratic scan)", async () => {
        // The old refresh regexes backtracked quadratically on exactly this
        // shape (seconds per keystroke at 40k chars); the bounded scanner
        // must keep a keystroke effectively instant.
        const long = `${"1 ".repeat(20000)}and 3+4= 7`;
        const editor = await makeRefreshEditor(long);
        const v = view(editor);
        const started = performance.now();
        editChar(v, 0, "2");
        expect(performance.now() - started).toBeLessThan(500);
        editor.destroy();
    });

    it("undo reverts the edit and the refreshed answer together", async () => {
        const editor = await makeRefreshEditor("3+4= 7");
        const v = view(editor);
        // A real history plugin, registered onto the live state so this test
        // actually exercises undo (it used to only re-assert the refresh).
        const withHistory = v.state.reconfigure({
            plugins: [...v.state.plugins, history()],
        });
        v.updateState(withHistory);
        editChar(v, 0, "4");
        expect(blockText(v)).toBe("4+4= 8");
        undo(v.state, v.dispatch);
        expect(blockText(v)).toBe("3+4= 7"); // one undo: expression AND answer
        editor.destroy();
    });
});
