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
 * stamps rather than naming one: a new counter joins this gate by existing, and
 * `theCountersUnderTest` asserts a floor so a run that found none fails loudly
 * instead of passing having measured nothing.
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
import { applyLintResults } from "../plugins/proofread";
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
function document(sections: number): string {
    let out = "# Working note\n\n";
    for (let i = 1; i <= sections; i++) {
        out += `## Section ${i}\n\n`;
        out += `Paragraph ${i} carries ordinary prose about the ${i}th thing, `
            + "long enough to look like a sentence somebody wrote on purpose.\n\n";
        out += `- A bullet in section ${i}\n- A second bullet in section ${i}\n\n`;
    }
    return out;
}

const SMALL = document(4);
const LARGE = document(40);

type Counter = { name: string; amounts: Record<string, number> };

function postMessageSpy(): ReturnType<typeof vi.fn> {
    const api = (globalThis as unknown as {
        acquireVsCodeApi: () => { postMessage: ReturnType<typeof vi.fn> };
    }).acquireVsCodeApi();
    return api.postMessage;
}

/**
 * jsdom's `performance.mark` accepts the options form but does not retain
 * `detail`, so the counters are captured at the call rather than read back off
 * the timeline. Capturing at the call is also what makes them attributable to
 * one keystroke.
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
    document_reset();
    vi.useFakeTimers();
    const spy = postMessageSpy();
    spy.mockClear();
    const container = window.document.createElement("div");
    window.document.body.appendChild(container);
    const editor = await createEditor(container, doc, vi.fn());
    try {
        await vi.advanceTimersByTimeAsync(2000);
        answerAll(spy);
        spy.mockClear();

        const capture = captureCounters();
        const v = view(editor);
        v.dispatch(v.state.tr.insertText("x", 3));
        await vi.advanceTimersByTimeAsync(2000);
        capture.restore();
        return capture.seen;
    } finally {
        vi.useRealTimers();
        await editor.destroy();
    }
}

function document_reset(): void {
    window.document.body.innerHTML = "";
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

    it("the larger document should be the larger document", async () => {
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

        // Equal, not merely bounded. One edit touches one block, and any growth
        // at all between a 4-section and a 40-section document is the defect
        // this gate is for, whatever its size.
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
        for (const compound of keys) {
            const [name, key] = compound.split("::");
            const a = total(smallWork, name, key);
            const b = total(largeWork, name, key);
            if (b > a) { grew.push(`${compound}: ${a} at 4 sections, ${b} at 40`); }
        }
        expect(grew).toEqual([]);
    });
});
