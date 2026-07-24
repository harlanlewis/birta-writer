/**
 * The stale/broken cue plugin against the REAL editor with the refresh engine
 * alongside (plugins/calcStale.ts + calcRefresh.ts): cues appear exactly where
 * maintenance can't reach (external-sync edits), never where it can (in-editor
 * edits), and the click actions write once, undo once, and never ripple. The
 * pure classifier is covered in calcStaleDecorations.test.ts; the idle/gating
 * lifecycle in calcStaleDeferred.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { ensureCalcUnits } from "../utils/calc";

// Preload the lazy unit engine once so every scan below is synchronous.
beforeAll(() => ensureCalcUnits());
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { history, undo } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { calcRefreshPlugin } from "../plugins/calcRefresh";
import {
    calcStalePlugin,
    calcStalePluginKey,
    clearCueIgnores,
    ignoreCueSession,
    refreshCalcCues,
    removeCueAnswer,
    updateCueResult,
    type CalcCueSpec,
} from "../plugins/calcStale";
import { EXTERNAL_SYNC_META } from "../plugins/docChange";

function setCalcFlags(flags: { enabled?: boolean } = {}): void {
    (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
        translations: {},
        isMac: true,
        calcEnabled: flags.enabled ?? true,
        calcAutoInsert: false,
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

/** The current cues: decorated text + spec + live positions. */
function cues(v: EditorView): Array<{ text: string; from: number; to: number; cue: CalcCueSpec["cue"] }> {
    const set = calcStalePluginKey.getState(v.state)?.set;
    if (!set) { return []; }
    return set.find().map((d) => ({
        text: v.state.doc.textBetween(d.from, d.to),
        from: d.from,
        to: d.to,
        cue: (d.spec as CalcCueSpec).cue,
    }));
}

/** Doc position of `substr` inside the `blockIdx`-th top-level block. */
function posOf(v: EditorView, blockIdx: number, substr: string): number {
    let result = -1;
    let idx = 0;
    v.state.doc.forEach((child, offset) => {
        if (idx === blockIdx) {
            const at = child.textContent.indexOf(substr);
            if (at !== -1) { result = offset + 1 + at; }
        }
        idx++;
    });
    if (result === -1) { throw new Error(`"${substr}" not found in block ${blockIdx}`); }
    return result;
}

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
        .use(calcRefreshPlugin)
        .use(calcStalePlugin)
        .create();
}

/** Fire the idle arm (setTimeout-0 fallback in jsdom) plus a debounce window. */
async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(400);
}

describe("stale/broken cues in the live editor", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
        setCalcFlags();
        clearCueIgnores();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("an external-sync definition edit cues the orphaned answer and leaves the file alone", async () => {
        const editor = await makeEditor("x = 4\n\nx\\*2 => 8");
        const v = view(editor);
        await settle();
        expect(cues(v)).toHaveLength(0); // the answer holds at open

        // The raw editor (or a git checkout) changes the definition: the
        // refresh engine deliberately never rewrites synced content …
        v.dispatch(
            v.state.tr.insertText("5", posOf(v, 0, "4"), posOf(v, 0, "4") + 1)
                .setMeta(EXTERNAL_SYNC_META, true),
        );
        expect(blockTexts(v)).toEqual(["x = 5", "x*2 => 8"]); // untouched, as on disk
        await settle();
        // … so the cue layer is what says the number no longer follows.
        const after = cues(v);
        expect(after).toHaveLength(1);
        expect(after[0].text).toBe("8");
        expect(after[0].cue.kind).toBe("stale");
        expect(after[0].cue.newValue).toBe("10");
        expect(blockTexts(v)).toEqual(["x = 5", "x*2 => 8"]); // decoration only
        await editor.destroy();
    });

    it("an in-editor definition edit is maintained by calcRefresh, so no cue survives", async () => {
        const editor = await makeEditor("x = 4\n\nx\\*2 => 8");
        const v = view(editor);
        await settle();
        v.dispatch(v.state.tr.insertText("5", posOf(v, 0, "4"), posOf(v, 0, "4") + 1));
        expect(blockTexts(v)).toEqual(["x = 5", "x*2 => 10"]); // cascade refreshed it
        await settle();
        expect(cues(v)).toHaveLength(0);
        await editor.destroy();
    });

    it("[Update] writes the fresh value, clears the cue instantly, and is one undo step", async () => {
        const editor = await makeEditor("x = 4\n\nx\\*2 => 8");
        const v = view(editor);
        v.updateState(v.state.reconfigure({ plugins: [...v.state.plugins, history()] }));
        await settle();
        v.dispatch(
            v.state.tr.insertText("5", posOf(v, 0, "4"), posOf(v, 0, "4") + 1)
                .setMeta(EXTERNAL_SYNC_META, true),
        );
        await settle();
        const [cue] = cues(v);
        expect(cue.cue.newValue).toBe("10");

        updateCueResult(v, cue.from, cue.to, cue.cue.newValue!);
        expect(blockTexts(v)).toEqual(["x = 5", "x*2 => 10"]);
        expect(cues(v)).toHaveLength(0); // cleared synchronously, no debounce wait

        undo(v.state, v.dispatch);
        expect(blockTexts(v)).toEqual(["x = 5", "x*2 => 8"]); // one undo restores
        await settle();
        expect(cues(v)).toHaveLength(1); // and the cue honestly returns
        await editor.destroy();
    });

    it("clicking a cued number should open the popup WITHOUT moving the caret", async () => {
        // Deliberate divergence from proofread (which lets the caret land): a
        // caret placed inside a maintained `=> answer` summons the inline-calc
        // suggestion menu over this popup — two advisory surfaces fighting for
        // one position. The click claims the event, shows the merged popup,
        // and leaves the selection where it was.
        const editor = await makeEditor("x = 4\n\nx\\*2 => 8");
        const v = view(editor);
        await settle();
        v.dispatch(
            v.state.tr.insertText("5", posOf(v, 0, "4"), posOf(v, 0, "4") + 1)
                .setMeta(EXTERNAL_SYNC_META, true),
        );
        await settle();
        const [cue] = cues(v);
        expect(cue).toBeDefined();
        const selectionBefore = v.state.selection;

        const target = document.createElement("span");
        target.className = "calc-cue";
        const event = { target } as unknown as MouseEvent;
        let claimed = false;
        for (const p of v.state.plugins) {
            if (p.props.handleClick?.call(p, v, cue.from, event)) {
                claimed = true;
                break;
            }
        }

        expect(claimed).toBe(true); // proofread's handler never re-shows its subset
        expect(document.querySelector(".pf-popup, [class*=popup]")).not.toBeNull();
        expect(v.state.selection.eq(selectionBefore)).toBe(true); // caret untouched
        await editor.destroy();
    });

    it("[Remove answer] leaves `expr =>` — the withdrawal shape — in one undo step", async () => {
        const editor = await makeEditor("x\\*2 => 8\n\nx = 4");
        const v = view(editor);
        v.updateState(v.state.reconfigure({ plugins: [...v.state.plugins, history()] }));
        await settle();
        const [cue] = cues(v);
        expect(cue.cue.kind).toBe("broken"); // the arrow sits above its definition

        removeCueAnswer(v, cue.from, cue.to);
        expect(blockTexts(v)).toEqual(["x*2 =>", "x = 4"]);
        expect(cues(v)).toHaveLength(0);

        undo(v.state, v.dispatch);
        expect(blockTexts(v)).toEqual(["x*2 => 8", "x = 4"]);
        await editor.destroy();
    });

    it("a cue write never ripples into sibling equations", async () => {
        const editor = await makeEditor("x = 4\n\nx\\*2 => 6\n\nx\\*3 => 12");
        const v = view(editor);
        await settle();
        const before = cues(v);
        expect(before).toHaveLength(1); // only the first arrow is stale
        expect(before[0].cue.newValue).toBe("8");

        updateCueResult(v, before[0].from, before[0].to, before[0].cue.newValue!);
        expect(blockTexts(v)).toEqual(["x = 4", "x*2 => 8", "x*3 => 12"]);
        expect(cues(v)).toHaveLength(0);
        await editor.destroy();
    });

    it("[Ignore] silences the equation for the session, across rescans", async () => {
        const editor = await makeEditor("x = 4\n\nx\\*2 => 6");
        const v = view(editor);
        await settle();
        const [cue] = cues(v);
        expect(cue.cue.kind).toBe("stale");

        ignoreCueSession(cue.cue.expr, cue.cue.resultText);
        refreshCalcCues(v);
        expect(cues(v)).toHaveLength(0);

        // A later unrelated edit rescans — the ignore must hold.
        v.dispatch(v.state.tr.insertText("!", v.state.doc.content.size - 1));
        await settle();
        expect(cues(v)).toHaveLength(0);
        await editor.destroy();
    });

    it("a hand-edited result reads as stale (the acknowledged override ambiguity)", async () => {
        const editor = await makeEditor("x = 4\n\nx\\*2 => 8");
        const v = view(editor);
        await settle();
        // The user overrides the answer by hand; calcRefresh respects it …
        v.dispatch(v.state.tr.insertText("9", posOf(v, 1, "8"), posOf(v, 1, "8") + 1));
        expect(blockTexts(v)).toEqual(["x = 4", "x*2 => 9"]);
        await settle();
        // … and the cue layer flags it — indistinguishable from staleness by
        // text alone. [Ignore] is the escape hatch; the file is never touched.
        const after = cues(v);
        expect(after).toHaveLength(1);
        expect(after[0].cue.kind).toBe("stale");
        await editor.destroy();
    });
});
