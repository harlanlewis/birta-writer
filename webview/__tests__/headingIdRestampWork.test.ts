/**
 * Promoting a block to a heading rebuilds the fold gutter ONCE, not twice.
 *
 * Turning a paragraph into a heading is two transactions, not one: the
 * structural change itself, and then `plugins/headingIdSync.ts`'s restamp of
 * the heading's `id`. The first legitimately rebuilds the gutter over every
 * top-level block, because a block changed type and a fold range may have
 * appeared. The second changes an attribute and nothing else, so it must take
 * the leaf-edit path in `headingFold/plugin.ts` (`singleBlockEditKeepsStructure`,
 * whose own comment names this restamp as the case it exists for) and cost one
 * block rather than the document.
 *
 * There was no guard on that, and its absence is the reason this file exists:
 * the fast path is reached through a chain of equality checks (same node type,
 * same heading level, same fold set, same pinned span, an equal per-block
 * fingerprint), and any one of them quietly ceasing to hold would restore the
 * second whole-document walk with every existing test still green. MAR-438 was
 * filed against a survey that measured exactly that second walk; it is gone
 * now, and this is what stops it coming back unnoticed.
 *
 * The assertion is a COUNT, not a duration, for the reasons
 * `perKeystrokeWork.test.ts` sets out at length: a count reads the same on a
 * loaded machine as on an idle one. It is written against `doc.childCount`
 * rather than a stored figure, so it cannot go stale as the fixture changes.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { editorViewCtx, type Editor } from "@milkdown/core";
import type { EditorView } from "../pm";
import { createEditor } from "../editor";
import { applyLintResults, clearStyleCache } from "../plugins/proofread";
import { clearLintCache } from "../proofread/lintCache";
import { setHeadingLevelAt } from "../plugins/headingFold";
import type { LintBlock } from "../../shared/messages";

// Mounting a real editor over a 121-block document, twice per case.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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

type Counter = { name: string; amounts: Record<string, number> };

/**
 * Counters are captured at the `performance.mark` call rather than read back
 * off the timeline: these tests run under fake timers, which replace
 * `performance` with the fake clock's own object whose `getEntriesBy*` return
 * nothing. `perKeystrokeWork.test.ts` explains this at length.
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

function postMessageSpy(): ReturnType<typeof vi.fn> {
    const api = (globalThis as unknown as {
        acquireVsCodeApi: () => { postMessage: ReturnType<typeof vi.fn> };
    }).acquireVsCodeApi();
    return api.postMessage;
}

function answerAll(spy: ReturnType<typeof vi.fn>): void {
    const requests = spy.mock.calls
        .map(([m]) => m as { type: string; id: number; blocks: LintBlock[] })
        .filter((m) => m?.type === "lintBlocks");
    for (const r of requests) {
        applyLintResults(r.id, r.blocks.map((b) => ({ key: b.key, lints: [] })));
    }
}

const view = (editor: Editor): EditorView => editor.action((ctx) => ctx.get(editorViewCtx));

interface Promotion {
    childCount: number;
    /** Every `fold-build` this gesture stamped, in order, as block counts. */
    foldBuilds: number[];
}

/** Mount, settle, then promote a mid-document paragraph to a heading. */
async function promoteParagraphToHeading(): Promise<Promotion> {
    clearLintCache();
    clearStyleCache();
    document.body.innerHTML = "";
    vi.useFakeTimers();
    const spy = postMessageSpy();
    spy.mockClear();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const editor = await createEditor(container, workingNote(40), vi.fn());
    try {
        await vi.advanceTimersByTimeAsync(2000);
        answerAll(spy);
        spy.mockClear();

        const v = view(editor);
        const doc = v.state.doc;
        const childCount = doc.childCount;

        // A paragraph well inside the document, so the promotion is an
        // ordinary mid-document edit rather than an edge case.
        let target = -1;
        let offset = 0;
        for (let i = 0; i < doc.childCount; i++) {
            if (target === -1 && i > 2 && doc.child(i).type.name === "paragraph") {
                target = offset;
            }
            offset += doc.child(i).nodeSize;
        }
        expect(target).toBeGreaterThan(0);

        const capture = captureCounters();
        try {
            expect(setHeadingLevelAt(v, target, 2)).toBe(true);
            await vi.advanceTimersByTimeAsync(2000);
        } finally {
            capture.restore();
        }

        return {
            childCount,
            foldBuilds: capture.seen
                .filter((c) => c.name.endsWith("fold-build"))
                .map((c) => c.amounts.blocks ?? 0),
        };
    } finally {
        vi.useRealTimers();
        await editor.destroy();
    }
}

describe("promoting a paragraph to a heading", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("should rebuild the whole gutter once and leave the id restamp a leaf edit", async () => {
        const { childCount, foldBuilds } = await promoteParagraphToHeading();

        // The instrument reached its subject. A gesture that stamped no
        // `fold-build` at all would satisfy every count assertion below by
        // having nothing to count, which is the failure mode this repo's
        // testing rules single out.
        expect(foldBuilds.length).toBeGreaterThan(0);
        expect(childCount).toBeGreaterThan(50);

        // Exactly one pass is allowed to walk the document: the structural
        // change. Asserted against childCount rather than a stored number.
        const wholeDocument = foldBuilds.filter((b) => b > 1);
        expect(wholeDocument).toEqual([childCount]);

        // And every other pass the gesture stamps is a leaf edit. This is the
        // half that regressing would restore MAR-438's second walk.
        const leaf = foldBuilds.filter((b) => b <= 1);
        expect(leaf.length).toBeGreaterThan(0);
        expect(leaf.every((b) => b === 1)).toBe(true);
    });
});
