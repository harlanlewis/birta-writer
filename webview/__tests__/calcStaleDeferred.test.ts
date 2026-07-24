/**
 * The stale-cue plugin's launch discipline (plugins/calcStale.ts): the first
 * pass waits for an idle window after mount, a disabled feature schedules
 * nothing and never loads the lazy unit chunk, and a live settings flip
 * re-gates in place. Deliberately NO ensureCalcUnits preload here — this file
 * owns the "units never load unless needed" assertions, and vitest's per-file
 * isolation keeps that state fresh.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { calcRefreshPlugin } from "../plugins/calcRefresh";
import {
    calcStalePlugin,
    calcStalePluginKey,
    clearCueIgnores,
    regateCalcCues,
} from "../plugins/calcStale";
import { calcUnitsReady } from "../utils/calcUnits";

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

function cueCount(v: EditorView): number {
    return calcStalePluginKey.getState(v.state)?.set.find().length ?? 0;
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

describe("cue scheduling: idle arm, disabled-costs-zero, live re-gate", () => {
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

    it("nothing scans on the mount path — cues settle in on idle", async () => {
        const editor = await makeEditor("x = 4\n\nx\\*2 => 6");
        const v = view(editor);
        // Before any timer fires (the idle arm's jsdom fallback is a
        // timeout), the mismatched doc shows NO cue — mount stayed clean.
        expect(cueCount(v)).toBe(0);
        await vi.advanceTimersByTimeAsync(50);
        expect(cueCount(v)).toBe(1);
        await editor.destroy();
    });

    it("disabled at mount: no cue ever, and the lazy unit chunk is never loaded", async () => {
        setCalcFlags({ enabled: false });
        // A unit-shaped arrow would need the unit chunk — but with calc off,
        // nothing is armed, so nothing ever asks for it.
        const editor = await makeEditor("3 km in mi => 5\n\nx = 4\n\nx\\*2 => 6");
        const v = view(editor);
        await vi.advanceTimersByTimeAsync(3000);
        expect(cueCount(v)).toBe(0);
        expect(calcUnitsReady()).toBe(false);
        await editor.destroy();
    });

    it("a live settings flip re-gates in place: on scans now, off clears now", async () => {
        setCalcFlags({ enabled: false });
        const editor = await makeEditor("x = 4\n\nx\\*2 => 6");
        const v = view(editor);
        await vi.advanceTimersByTimeAsync(2000);
        expect(cueCount(v)).toBe(0);

        (window.__i18n as unknown as Record<string, unknown>).calcEnabled = true;
        regateCalcCues(v);
        await vi.advanceTimersByTimeAsync(50);
        expect(cueCount(v)).toBe(1);

        (window.__i18n as unknown as Record<string, unknown>).calcEnabled = false;
        regateCalcCues(v);
        expect(cueCount(v)).toBe(0); // cleared synchronously, no debounce wait
        await editor.destroy();
    });
});
