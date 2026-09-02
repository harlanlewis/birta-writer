/**
 * Per-keystroke work must not scale with the document.
 *
 * This is a COUNTING gate, not a timing one, and the distinction is the whole
 * reason it can live here. A per-keystroke cost that grows with the document is
 * a complexity defect, and a duration is a poor instrument for complexity: it
 * needs an idle machine, a noise floor, a merge-base interleave and a
 * double-confirm, which is exactly why `typing-perf` is expensive, paths
 * filtered and advisory. A count needs none of that. It reads the same on a
 * loaded CI runner as on an idle laptop, so it can be gated hard, and it runs in
 * `pnpm test` on every push.
 *
 * The question it asks is not "is this number big", which would need a baseline
 * nobody can keep honest. It is "does this number grow with the document", asked
 * as a DIFFERENTIAL between two fixtures whose only difference is size. A gate
 * shaped that way needs no stored figure and cannot go stale.
 *
 * It is deliberately generic over the counters `webview/perf.ts`'s `countWork`
 * stamps rather than naming one, so a new counter joins this gate by existing.
 * Each case asserts its own reach for that reason: a sweep over no counters, or
 * over counters reading zero on both sides, would satisfy every differential
 * here by having nothing to compare.
 *
 * What it cannot see: per-keystroke work that crosses no instrumented boundary.
 * Counters find only what they are put on. The rule that goes with this gate is
 * to call `countWork` when you WRITE a whole-document walk, not when you come
 * looking for one.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { editorViewCtx, type Editor } from "@milkdown/core";
import type { EditorView } from "../pm";
import { createEditor } from "../editor";
import { applyLintResults, clearStyleCache } from "../plugins/proofread";
import { clearLintCache } from "../proofread/lintCache";
import type { LintBlock } from "../../shared/messages";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

beforeAll(() => {
    if (typeof globalThis.ResizeObserver === "undefined") {
        globalThis.ResizeObserver = class {
            observe(): void {}
            unobserve(): void {}
            disconnect(): void {}
        } as unknown as typeof ResizeObserver;
    }
    if (typeof globalThis.requestAnimationFrame === "undefined") {
        globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
            setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame;
        globalThis.cancelAnimationFrame = ((id: number) =>
            clearTimeout(id)) as unknown as typeof cancelAnimationFrame;
    }
});

/**
 * Two documents whose only difference is SIZE. Same construct mix, same
 * paragraph shapes, same proportion of prose that trips a check: if they
 * differed in anything else, a count that grew between them would have a second
 * explanation and the gate would prove nothing.
 */
function workingNote(sections: number): string {
    let out = "# Working note\n\n";
    for (let i = 1; i <= sections; i++) {
        out += `## Section ${i}\n\n`;
        out += `Paragraph ${i} carries ordinary prose about the ${i}th thing, `
            + "long enough to look like a sentence somebody wrote on purpose.\n\n";
        out += `- A bullet in section ${i}\n- A second bullet in section ${i}\n\n`;
    }
    return out;
}

const SMALL = workingNote(4);
const LARGE = workingNote(40);

type Counter = { name: string; amounts: Record<string, number> };

function postMessageSpy(): ReturnType<typeof vi.fn> {
    const api = (globalThis as unknown as {
        acquireVsCodeApi: () => { postMessage: ReturnType<typeof vi.fn> };
    }).acquireVsCodeApi();
    return api.postMessage;
}

/**
 * Counters are captured AT THE CALL rather than read back off the timeline.
 *
 * Two reasons, and the first is the one that would otherwise be guessed wrong.
 * These tests run under `vi.useFakeTimers()`, which replaces `performance`
 * wholesale with the fake clock's own object; its `mark` ignores the options
 * argument and its `getEntriesBy*` return nothing. So there is no timeline to
 * read here whatever jsdom would have done, and a test written to read one
 * would report zero counters and pass its differential by having nothing to
 * compare. The second reason stands on its own: capturing at the call is what
 * makes a counter attributable to one keystroke.
 *
 * The consequence is a real limit on what this file can claim. It pins the
 * COUNTS, which is what the gate is for, and it cannot establish that
 * `countWork` reaches a real timeline at all. `e2e/perf/checks.mjs` asserts that
 * half, in a browser, where `e2e/perf-typing.mjs` actually reads it.
 */
function captureCounters(): { seen: Counter[]; restore: () => void } {
    const seen: Counter[] = [];
    const original = performance.mark;
    performance.mark = ((name: string, options?: { detail?: unknown }) => {
        const detail = options?.detail;
        if (typeof name === "string" && detail && typeof detail === "object") {
            seen.push({ name, amounts: detail as Record<string, number> });
        }
        return original?.call(performance, name);
    }) as typeof performance.mark;
    return { seen, restore: () => { performance.mark = original; } };
}

/** Answer every open lint request the way a host does, so the page settles. */
function answerAll(spy: ReturnType<typeof vi.fn>): void {
    const requests = spy.mock.calls
        .map(([m]) => m as { type: string; id: number; blocks: LintBlock[] })
        .filter((m) => m?.type === "lintBlocks");
    for (const r of requests) {
        applyLintResults(r.id, r.blocks.map((b) => ({ key: b.key, lints: [] })));
    }
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/**
 * Mount `doc`, let the first pass complete and be answered, then type one
 * character and return every counter that keystroke stamped.
 *
 * The first pass is skipped past on purpose: it legitimately scales with the
 * document, and a gate that included it would read "scales" forever and be
 * muted by the first person to look at it.
 */
async function workForOneKeystroke(doc: string): Promise<Counter[]> {
    clearLintCache();
    clearStyleCache();
    document.body.innerHTML = "";
    vi.useFakeTimers();
    const spy = postMessageSpy();
    spy.mockClear();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const editor = await createEditor(container, doc, vi.fn());
    try {
        await vi.advanceTimersByTimeAsync(2000);
        answerAll(spy);
        spy.mockClear();

        const capture = captureCounters();
        try {
            const v = view(editor);
            v.dispatch(v.state.tr.insertText("x", 3));
            await vi.advanceTimersByTimeAsync(2000);
        } finally {
            // In a `finally`, or a throw here leaks the patched `mark` into
            // every later test in the file.
            capture.restore();
        }
        return capture.seen;
    } finally {
        vi.useRealTimers();
        await editor.destroy();
    }
}

function total(counters: Counter[], name: string, key: string): number {
    return counters
        .filter((c) => c.name.endsWith(name))
        .reduce((n, c) => n + (c.amounts[key] ?? 0), 0);
}

describe("per-keystroke work does not scale with the document", () => {
    beforeEach(() => { vi.clearAllMocks(); });
    afterEach(() => { vi.useRealTimers(); });

    it("the instrument should reach at least one counter on both documents", async () => {
        // Asserted before anything leans on it. A sweep that stamped nothing
        // would satisfy every comparison below by having no numbers to compare,
        // which is the failure this whole file exists to avoid elsewhere.
        const small = await workForOneKeystroke(SMALL);
        const large = await workForOneKeystroke(LARGE);
        expect(small.length).toBeGreaterThan(0);
        expect(large.length).toBeGreaterThan(0);
        expect(large.map((c) => c.name).sort()).toEqual(small.map((c) => c.name).sort());
    });

    it("the larger document should be the larger document", () => {
        // The other half of the instrument check: if the two fixtures were not
        // actually different sizes, "the work did not grow" would be true for a
        // reason that has nothing to do with the code.
        expect(LARGE.length).toBeGreaterThan(SMALL.length * 5);
    });

    it("one keystroke should hand the host the same amount of work whatever the document's size", async () => {
        const smallWork = await workForOneKeystroke(SMALL);
        const largeWork = await workForOneKeystroke(LARGE);

        const smallBlocks = total(smallWork, "lint-request", "blocks");
        const largeBlocks = total(largeWork, "lint-request", "blocks");

        // The exact number, not merely equality between the two. `toBe(small)`
        // alone is satisfied by 0 === 0, which is what this reads if the
        // keystroke ever stops reaching the rescan: the gate would then report
        // success having measured nothing, in the one file whose whole subject
        // is instruments that measure nothing.
        //
        // One is the design's number rather than the fixture's: the edit is a
        // single character inserted inside one textblock (position 3 is in the
        // opening heading, which both documents have and neither repeats), so
        // exactly one block's text is new and exactly one is asked about. An
        // edit that split a block or landed in a repeated one would be a
        // different claim and would need a different number.
        expect(smallBlocks).toBe(1);
        // And then the differential: one edit touches one block whatever the
        // document's size, so any growth at all is the defect this is for.
        expect(largeBlocks).toBe(smallBlocks);
    });

    it("every counter a keystroke stamps should hold at the larger size", async () => {
        // Generic over the counters rather than naming one, so a counter added
        // later is gated the day it lands. `chars` is included, which is the
        // stricter half: the same block count over more text would still be
        // work that grew with the document.
        const smallWork = await workForOneKeystroke(SMALL);
        const largeWork = await workForOneKeystroke(LARGE);

        const keys = new Set<string>();
        for (const c of [...smallWork, ...largeWork]) {
            for (const k of Object.keys(c.amounts)) { keys.add(`${c.name}::${k}`); }
        }
        expect(keys.size).toBeGreaterThan(0);

        const grew: string[] = [];
        let counted = 0;
        for (const compound of keys) {
            const [name, key] = compound.split("::");
            const a = total(smallWork, name, key);
            const b = total(largeWork, name, key);
            // A counter reading zero on both sides can never enter `grew`, so
            // without this the sweep could be all zeroes and still pass. A key
            // existing is not the same as a number having been measured.
            if (a > 0 && b > 0) { counted++; }
            if (b > a) { grew.push(`${compound}: ${a} at 4 sections, ${b} at 40`); }
        }
        expect(counted, "every counter read zero on both sides, so nothing was compared")
            .toBeGreaterThan(0);
        expect(grew).toEqual([]);
    });
});
