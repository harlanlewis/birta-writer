/**
 * Inline-calc plugin tests, driving the REAL Milkdown editor: the advisory
 * `=` and `=>` caret suggestions and their Tab confirmation (Return stays a
 * newline), the opt-in auto-insert input rule, and the enabled gating. The
 * pure engine is covered in calc.test.ts; the refresh/cascade/withdrawal
 * engine in calcRefresh.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { ensureCalcUnits } from "../utils/calc";

// The `=>` fetch path awaits the lazy unit engine; preload once (under real
// timers) so the fake-timer tests below see synchronous resolution.
beforeAll(() => ensureCalcUnits());
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    calcSuggestPlugin,
    calcAutoInsertPlugin,
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

describe("inline calc inside an inline-code span", () => {
    // The caret-suggest controller refuses inline code for the link/wikilink
    // autocompletes — a `[text](partial` in backticks is source being shown,
    // not a link being authored. Calc opts out of that refusal: a backticked
    // expression is exactly where a writer puts arithmetic, and the answer is
    // plain digits either way. (The link side's refusal stays pinned in
    // linkUrlComplete.test.ts.)
    let editor: Editor;
    let v: EditorView;

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        delete window.__i18n; // defaults: calc enabled, advisory
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    /** Caret at the END of the leading inline-code span, inside the mark. */
    function caretInsideCode(len: number): void {
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1 + len)));
        expect(v.state.selection.$from.marks().some((m) => m.type.spec.code)).toBe(true);
    }

    it("typing = inside inline code should offer the result", async () => {
        vi.useRealTimers();
        editor = await makeEditor("`2+3`\n");
        vi.useFakeTimers();
        v = view(editor);
        caretInsideCode(3);

        typeText(v, "=");
        await vi.advanceTimersByTimeAsync(250);

        expect(optionTexts()).toEqual(["5"]);
    });

    it("Tab should write the answer INSIDE the code span, not beside it", async () => {
        vi.useRealTimers();
        editor = await makeEditor("`2+3`\n");
        vi.useFakeTimers();
        v = view(editor);
        caretInsideCode(3);

        typeText(v, "=");
        await vi.advanceTimersByTimeAsync(250);
        v.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

        expect(v.state.doc.textContent).toBe("2+3= 5");
        // Every character still carries the code mark: the result was written
        // at a position inside the span, so it inherited it.
        const para = v.state.doc.firstChild!;
        para.forEach((child) => {
            expect(child.marks.some((m) => m.type.spec.code)).toBe(true);
        });
    });

    it("`=>` should still refuse inside inline code, unlike `=`", async () => {
        // Not an oversight — the reason is a design constraint, so it is pinned.
        // An accepted `=>` answer is MAINTAINED (calcRefresh updates it,
        // calcStale cues it when it can't), and both engines read blockCalcText,
        // which masks inline code. Offering here would plant an answer where its
        // premise can change with no update and no cue. Unmasking those engines
        // is not the alternative: `=>` is a JS arrow function, so `` `n => 1` ``
        // would collect a broken-answer strikethrough on the `1`.
        vi.useRealTimers();
        const root = document.createElement("div");
        document.body.appendChild(root);
        editor = await Editor.make()
            .config((ctx) => {
                ctx.set(rootCtx, root);
                ctx.set(defaultValueCtx, "budget = 100\n\n`budget*2 `\n");
                configureSerialization(ctx);
            })
            .use(pureCommonmark)
            .use(gfmFidelity)
            .use(calcArrowSuggestPlugin)
            .create();
        vi.useFakeTimers();
        v = view(editor);
        // Caret at the end of the code text, inside the mark.
        const codePara = v.state.doc.child(1);
        const at = v.state.doc.content.size - 1 - (codePara.content.size - "budget*2 ".length);
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, at)));
        expect(v.state.selection.$from.marks().some((m) => m.type.spec.code)).toBe(true);

        typeText(v, "=>");
        await vi.advanceTimersByTimeAsync(250);

        expect(optionTexts()).toEqual([]);
    });

    it("a code BLOCK should still refuse (a formula there is source)", async () => {
        vi.useRealTimers();
        editor = await makeEditor("```\n2+3\n```\n");
        vi.useFakeTimers();
        v = view(editor);
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 4)));

        typeText(v, "=");
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

    it("a definition carrying its inserted answer feeds the next `=>` (screenshot bug)", async () => {
        // `e=d => 6` must define e as 6; `e =>` below then offers 6 — never
        // Euler's 2.718282 (removed as a constant for exactly this trap).
        editor = await makeArrowEditor("a=2\n\nb=4\n\nd=a+b\n\ne=d => 6\n\ne =>");
        v = view(editor);
        placeCursorAtEnd(v);
        v.dispatch(v.state.tr.setSelection(v.state.selection)); // nudge an update
        await vi.advanceTimersByTimeAsync(250);
        expect(optionTexts()).toEqual(["6"]);
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

    // ── A name the world reads two ways (`log`): offer, never guess ──────────
    // e2e/calcAmbiguous drives the same flow in a real browser, but CI does not
    // run e2e — so the branch that decides between "one answer" and "one row
    // per reading", and the rewrite that a pick performs, are guarded here.

    async function arrowMenu(markdown: string, typed: string): Promise<void> {
        editor = await makeArrowEditor(markdown);
        v = view(editor);
        placeCursorAtEnd(v);
        typeText(v, typed);
        await vi.advanceTimersByTimeAsync(250);
    }

    /** Row labels paired with their right-aligned hint (the reading's answer). */
    function optionHints(): Array<[string, string]> {
        return Array.from(
            document.querySelectorAll(".fm-suggest-menu .fm-suggest-item:not(.fm-suggest-item--action)"),
        ).map((li) => [
            li.querySelector(".fm-suggest-item__label")?.textContent ?? "",
            li.querySelector(".fm-suggest-item__hint")?.textContent ?? "",
        ]);
    }

    it("an ambiguous `log` should offer one row per reading, each with its own answer", async () => {
        await arrowMenu("x\n", " log(100) =>");
        const rows = optionHints();
        expect(rows.map(([label]) => label)).toEqual(["log10", "ln"]);
        // The two numbers sit side by side, so the choice is made against them
        // rather than in the abstract — this is the whole point of refusing.
        expect(rows[0][1]).toBe("2");
        expect(rows[1][1]).toMatch(/^4\.60517/);
        expect(rows[0][1]).not.toBe(rows[1][1]);
    });

    it("the disambiguation menu should name the ambiguity and say how to confirm", async () => {
        await arrowMenu("x\n", " log(100) =>");
        const footer = document.querySelector(".fm-suggest-menu .fm-suggest-footer");
        // Named from the engine's table, not hardcoded; and the row hints are
        // spent on the answers, so the footer is the only place "Tab" can be.
        expect(footer?.textContent).toContain("log");
        expect(footer?.textContent).toContain("Tab");
        expect(footer?.getAttribute("aria-hidden")).toBe("true");
    });

    it("picking a reading should rewrite the EQUATION as well as write the answer", async () => {
        await arrowMenu("x\n", " log(100) =>");
        v.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        // Both halves, or the document keeps an answer whose expression still
        // reads two ways — the exact thing the refusal exists to prevent.
        expect(v.state.doc.textContent).toBe("x log10(100) => 2");
        expect(v.state.doc.textContent).not.toContain("log(");
    });

    it("arrowing to the second reading should write THAT name and THAT answer", async () => {
        await arrowMenu("x\n", " log(100) =>");
        v.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        v.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        expect(v.state.doc.textContent).toMatch(/^x ln\(100\) => 4\.60517/);
    });

    it("every ambiguous call in the expression should be settled, not just the first", async () => {
        await arrowMenu("x\n", " log(100) + log(10) =>");
        v.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        expect(v.state.doc.textContent).toBe("x log10(100) + log10(10) => 3");
    });

    it("an unambiguous expression should still get the ordinary single answer row", async () => {
        await arrowMenu("x\n", " log10(1000) =>");
        expect(optionTexts()).toEqual(["3"]);
        v.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        expect(v.state.doc.textContent).toBe("x log10(1000) => 3");
    });

    it("an ambiguous expression no reading can answer should offer nothing", async () => {
        // `log(0)` is -Infinity either way: there is no reading to choose
        // between, so the menu stays shut rather than offering a dead row.
        await arrowMenu("x\n", " log(0) =>");
        expect(optionTexts()).toEqual([]);
        expect(document.querySelector(".fm-suggest-menu")).toBeNull();
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
