/**
 * The answer-maintenance engine (plugins/calcRefresh.ts), driving the REAL
 * Milkdown editor: expression-edit refresh for every equation form, the
 * variable cascade, withdrawal of orphaned answers with its three proofs, and
 * the consent boundaries (result edits are overrides; inline code is source;
 * advisory `=` refuses prose-annotation tails). The pure text layer is
 * covered in calc.test.ts; the advisory menus in calcPlugin.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { ensureCalcUnits } from "../utils/calc";

// The refresh engine may consult the lazy unit engine; preload once so every
// test below is synchronous and deterministic.
beforeAll(() => ensureCalcUnits());
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection, history, undo } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { calcSuggestPlugin, calcAutoInsertPlugin } from "../plugins/calc";
import { calcRefreshPlugin } from "../plugins/calcRefresh";
import { EXTERNAL_SYNC_META } from "../plugins/docChange";

/** One call sets the whole calc flag surface; only deviations are named. */
function setCalcFlags(flags: { enabled?: boolean; autoInsert?: boolean } = {}): void {
    (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
        translations: {},
        isMac: true,
        calcEnabled: flags.enabled ?? true,
        calcAutoInsert: flags.autoInsert ?? false,
    };
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Every top-level block's text, in order — the doc at a glance. */
function blockTexts(v: EditorView): string[] {
    const texts: string[] = [];
    v.state.doc.forEach((child) => { texts.push(child.textContent); });
    return texts;
}

describe("answer refresh — =, =>, cascade, withdrawal", () => {
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
        setCalcFlags({ autoInsert: true });
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
        await editor.destroy();
    });

    it("editing the RESULT is the user's override and is left alone", async () => {
        const editor = await makeRefreshEditor("3+4= 7");
        const v = view(editor);
        editChar(v, 5, "9"); // user rewrites the answer by hand
        expect(blockText(v)).toBe("3+4= 9");
        await editor.destroy();
    });

    it("a mid-edit invalid expression leaves the text untouched until whole", async () => {
        const editor = await makeRefreshEditor("3+4= 7");
        const v = view(editor);
        // Delete the "4": "3+= 7" — not valid arithmetic; nothing rewrites.
        v.dispatch(v.state.tr.delete(3, 4));
        expect(blockText(v)).toBe("3+= 7");
        await editor.destroy();
    });

    it("`=` refreshes in advisory mode too — maintenance is not insertion", async () => {
        // autoInsert governs only whether typing `=` INSERTS unprompted; an
        // answer that already exists updates when its expression is edited,
        // whatever the mode (the maintainer's expectation: `3+4=7` edited to
        // `4+4=` reads `=8`, live).
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("3+4=7");
        const v = view(editor);
        editChar(v, 0, "4");
        expect(blockText(v)).toBe("4+4=8");
        await editor.destroy();
    });

    it("calc disabled: nothing ever refreshes", async () => {
        setCalcFlags({ enabled: false });
        const editor = await makeRefreshEditor("3+4= 7\n\n2+3 => 5");
        const v = view(editor);
        editChar(v, 0, "4");
        expect(blockText(v)).toBe("4+4= 7");
        await editor.destroy();
    });

    it("LEADING form: editing the expression refreshes the answer before the =", async () => {
        const editor = await makeRefreshEditor("12=5+7");
        const v = view(editor);
        // "5" is at offset 3; make it 6 → 12=6+7 → refresh → 13=6+7.
        editChar(v, 3, "6");
        expect(blockText(v)).toBe("13=6+7");
        await editor.destroy();
    });

    it("LEADING form: editing the RESULT is the user's override and left alone", async () => {
        const editor = await makeRefreshEditor("12=5+7");
        const v = view(editor);
        editChar(v, 0, "9"); // hand-edit the answer → 92=5+7, untouched
        expect(blockText(v)).toBe("92=5+7");
        await editor.destroy();
    });

    it("LEADING form: a prose assignment (letter before the number) never rewrites", async () => {
        const editor = await makeRefreshEditor("a12=5+7");
        const v = view(editor);
        // Edit the 5 → 6: the excised text is "a=6+7", which the leading
        // boundary rule rejects (prose assignment), so nothing rewrites.
        editChar(v, 4, "6");
        expect(blockText(v)).toBe("a12=6+7");
        await editor.destroy();
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
        await editor.destroy();
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
        await editor.destroy();
    });

    it("`=>` refreshes on expression edits even in ADVISORY mode (no auto-insert)", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("2+3 => 5");
        const v = view(editor);
        editChar(v, 0, "4"); // 2+3 => 5  →  4+3 => 7
        expect(blockText(v)).toBe("4+3 => 7");
        await editor.destroy();
    });

    it("editing an upstream definition cascades to every `=>` below it", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("x = 4\n\ny = 2\n\nx+y => 6\n\nx*2 => 8");
        const v = view(editor);
        // Rewrite the definition's value: x = 4 → x = 5 ("4" is at offset 4).
        editChar(v, 4, "5");
        const texts: string[] = [];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts).toEqual(["x = 5", "y = 2", "x+y => 7", "x*2 => 10"]);
        await editor.destroy();
    });

    it("editing the `=>` RESULT is the user's override and is left alone", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("2+3 => 5");
        const v = view(editor);
        editChar(v, 7, "9"); // hand-rewrite the answer
        expect(blockText(v)).toBe("2+3 => 9");
        await editor.destroy();
    });

    it("a `=>` with no accepted answer is never touched (nothing to maintain)", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("x = 4\n\nx+1 =>");
        const v = view(editor);
        editChar(v, 4, "5");
        const texts: string[] = [];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts).toEqual(["x = 5", "x+1 =>"]); // the advisory menu owns this case
        await editor.destroy();
    });

    it("a definition on a HARDBREAK line still cascades (not just first-line defs)", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("Notes:\\\nx = 4\n\nx*2 => 8");
        const v = view(editor);
        // "x = 4" is the second visual line of the first block; edit its 4.
        const idx = v.state.doc.firstChild!.textContent.indexOf("4");
        editChar(v, idx, "5");
        const texts: string[] = [];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts[1]).toBe("x*2 => 10");
        await editor.destroy();
    });

    it("a prose comma directly after the result survives a refresh", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("2+3 => 5, then more");
        const v = view(editor);
        editChar(v, 2, "4");
        expect(blockText(v)).toBe("2+4 => 6, then more");
        await editor.destroy();
    });

    it("editing an arrow's RESULT in a definition-bearing block is NOT refought", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("x = 4\\\nx*2 => 8");
        const v = view(editor);
        // Hand-edit the 8 → 9: the block holds a definition, so the cascade
        // runs — but the user's own edit is the override and must stand.
        const idx = v.state.doc.firstChild!.textContent.indexOf("8");
        editChar(v, idx, "9");
        expect(v.state.doc.firstChild!.textContent).toContain("x*2 => 9");
        await editor.destroy();
    });

    it("a constant-only arrow never depends on definitions (overrides persist)", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("x = 4\n\n2+3 => 99");
        const v = view(editor);
        editChar(v, 4, "5"); // edit x — 2+3 has no variables, 99 is the user's
        const texts: string[] = [];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts[1]).toBe("2+3 => 99");
        await editor.destroy();
    });

    it("advisory `=` leaves prose annotations alone (result followed by a word)", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("Dec 24-26 = 3 days off");
        const v = view(editor);
        const idx = v.state.doc.firstChild!.textContent.indexOf("24");
        editChar(v, idx + 1, "3"); // 24 → 23
        expect(blockText(v)).toBe("Dec 23-26 = 3 days off"); // never "-3 days"
        await editor.destroy();
    });

    it("a definition inside inline code never feeds the scope or cascades", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("`x = 4`\n\nx*2 => 8");
        const v = view(editor);
        const idx = v.state.doc.firstChild!.textContent.indexOf("4");
        editChar(v, idx, "5"); // edit inside the backticks
        const texts: string[] = [];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts[1]).toBe("x*2 => 8"); // untouched — backticked text is source
        await editor.destroy();
    });

    it("an equation inside inline code is source, never rewritten", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("see `2+3 => 5` here");
        const v = view(editor);
        // Edit the "2" inside the backticked span (offset 4 in the text).
        editChar(v, 4, "4");
        expect(blockText(v)).toBe("see 4+3 => 5 here"); // stale, untouched
        await editor.destroy();
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
        await editor.destroy();
    });

    it("a vanished variable WITHDRAWS the dependent answer (silence over a stale lie)", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("x = 4\n\nx*2 => 8");
        const v = view(editor);
        // Delete the entire definition paragraph.
        v.dispatch(v.state.tr.delete(0, v.state.doc.firstChild!.nodeSize));
        expect(v.state.doc.firstChild?.textContent).toBe("x*2 =>"); // answer gone, no lie left
        await editor.destroy();
    });

    it("withdrawal is one undo away, together with the deletion that caused it", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("x = 4\n\nx*2 => 8");
        const v = view(editor);
        v.updateState(v.state.reconfigure({ plugins: [...v.state.plugins, history()] }));
        v.dispatch(v.state.tr.delete(0, v.state.doc.firstChild!.nodeSize));
        expect(v.state.doc.firstChild?.textContent).toBe("x*2 =>");
        undo(v.state, v.dispatch);
        const texts: string[] = [];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts).toEqual(["x = 4", "x*2 => 8"]); // definition AND answer restored
        await editor.destroy();
    });

    it("renaming a variable also withdraws answers it justified", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("x = 4\n\nx*2 => 8");
        const v = view(editor);
        editChar(v, 0, "y"); // x = 4 → y = 4: nothing defines x anymore
        const texts: string[] = [];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts).toEqual(["y = 4", "x*2 =>"]);
        await editor.destroy();
    });

    it("multiple definitions on one line feed the cascade and the `=>` scope", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("a=5, b=2\n\na+b => 7");
        const v = view(editor);
        editChar(v, 2, "9"); // a=5 → a=9
        const texts: string[] = [];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts).toEqual(["a=9, b=2", "a+b => 11"]);
        await editor.destroy();
    });

    it("withdrawal NEVER deletes digits from prose the feature didn't answer", async () => {
        setCalcFlags({ autoInsert: false });
        // `load` never resolved, so `5 servers` is prose — an unrelated
        // definition edit must not strip its digits.
        const editor = await makeRefreshEditor("x = 4\n\nload => 5 servers\n\nnext steps => 3 items");
        const v = view(editor);
        editChar(v, 4, "5"); // x = 4 → x = 5
        const texts: string[] = [];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts).toEqual(["x = 5", "load => 5 servers", "next steps => 3 items"]);
        await editor.destroy();
    });

    it("backspacing a definition's value does NOT destroy dependent answers", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("x = 4\n\nx*2 => 8");
        const v = view(editor);
        // Backspace the 4: `x = ` is a definition MID-EDIT, not vanished.
        v.dispatch(v.state.tr.delete(5, 6));
        let texts: string[] = [];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts[1]).toBe("x*2 => 8"); // stale for a keystroke, intact
        // Retype a new value: the answer catches up, never having been lost.
        v.dispatch(v.state.tr.insertText("5", 5, 5));
        texts = [];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts).toEqual(["x = 5", "x*2 => 10"]);
        await editor.destroy();
    });

    it("typing over the arrow's own variable never withdraws via the same-block cascade", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("x = 4\\\nx*2 => 8");
        const v = view(editor);
        const idx = v.state.doc.firstChild!.textContent.indexOf("x*2");
        editChar(v, idx, "y"); // rename the arrow's own x — local edit territory
        expect(v.state.doc.firstChild!.textContent).toContain("y*2 => 8"); // preserved
        await editor.destroy();
    });

    it("superscript `=` equations refresh like their caret twins", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("5²= 25");
        const v = view(editor);
        editChar(v, 0, "6");
        expect(blockText(v)).toBe("6²= 36");
        await editor.destroy();
    });

    it("a composite transaction (insert then delete a definition) still withdraws", async () => {
        setCalcFlags({ autoInsert: false });
        const editor = await makeRefreshEditor("intro\n\nx = 4\n\nx*2 => 8");
        const v = view(editor);
        // One transaction: pad block 1, THEN delete the definition paragraph
        // at post-insert coordinates — the old-state trigger must back-map.
        const defNode = v.state.doc.child(1);
        const defPos = v.state.doc.firstChild!.nodeSize;
        const tr = v.state.tr.insertText(" padded", 6, 6);
        tr.delete(tr.mapping.map(defPos), tr.mapping.map(defPos + defNode.nodeSize));
        v.dispatch(tr);
        const texts: string[] = [];
        v.state.doc.forEach((child) => { texts.push(child.textContent); });
        expect(texts[texts.length - 1]).toBe("x*2 =>"); // withdrawn, not stale
        await editor.destroy();
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
        await editor.destroy();
    });

    it("equations inside a fenced code block are never refreshed", async () => {
        setCalcFlags({ autoInsert: true }); // even the aggressive mode stays out
        const editor = await makeRefreshEditor("```\n3+4= 7\n```");
        const v = view(editor);
        // Edit the 3 inside the fence (code_block content starts at pos 1).
        v.dispatch(v.state.tr.insertText("4", 1, 2));
        expect(blockText(v)).toBe("4+4= 7"); // source, untouched
        await editor.destroy();
    });

    it("one transaction touching two equations in the SAME block refreshes only the first (pinned)", async () => {
        // Deliberate: the local pass breaks after one refresh per block; the
        // second equation catches up on its next own edit. This pin exists so
        // a change to that trade-off is a conscious one. (Auto-insert mode:
        // in advisory mode the mid-prose tails would refuse anyway.)
        setCalcFlags({ autoInsert: true });
        const editor = await makeRefreshEditor("3+4= 7 and 6+7= 13");
        const v = view(editor);
        const tr = v.state.tr.insertText("4", 1, 2).insertText("7", 12, 13);
        v.dispatch(tr);
        expect(blockText(v)).toBe("4+4= 8 and 7+7= 13");
        await editor.destroy();
    });
});
