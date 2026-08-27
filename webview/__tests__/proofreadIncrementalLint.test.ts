/**
 * A keystroke must cost a one-block question, not a whole-document one.
 *
 * The proofread rescan collects every textblock and posts them all as
 * `lintBlocks` for the host to check. The host's checker is not free and is not
 * always on a spare thread: in Birta Writer for Mac it is `NSSpellChecker`,
 * which is AppKit and runs on the main thread, the same thread key events
 * arrive on. So a rescan that re-asks about the whole document is paid in caret
 * latency, and because the rescan is a TRAILING debounce it fires once per
 * keystroke exactly when a person types slower than the debounce, which is what
 * a person does the moment the editor starts feeling slow. That is the loop this
 * pins: cost per keystroke that scales with the document rather than the edit.
 *
 * The browser typing harness cannot see this class of defect at all. It types
 * at 30 ms/key, so a 350 ms trailing debounce never fires mid-burst, and it has
 * no host to answer a lint. Both instruments have to be read together; this is
 * the one that runs in CI.
 *
 * Driven through the real `createEditor` stack, and asserted on what actually
 * leaves the page, because the defect lives in the message rather than in any
 * function's return value.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { editorViewCtx, type Editor } from "@milkdown/core";
import type { EditorView } from "../pm";
import { createEditor } from "../editor";
import { applyLintResults } from "../plugins/proofread";
import { clearLintCache } from "../proofread/lintCache";
import type { LintBlock } from "../../shared/messages";

// Same budget rationale as proofreadRescanMeasure.test.ts: the full Milkdown
// stack is built per test, plus the one-time deferred first pass.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

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
 * Eight distinct paragraphs. Distinct matters: identical blocks are collapsed
 * into one question by design, so a fixture of repeated text would satisfy the
 * assertions below without the cache doing anything.
 */
const DOC = [
    "# Notes",
    "Alpha paragraph about the first thing entirely.",
    "Beta paragraph about the second thing entirely.",
    "Gamma paragraph about the third thing entirely.",
    "Delta paragraph about the fourth thing entirely.",
    "Epsilon paragraph about the fifth thing entirely.",
    "Zeta paragraph about the sixth thing entirely.",
    "Eta paragraph about the seventh thing entirely.",
].join("\n\n") + "\n";

type LintRequest = { type: string; id: number; blocks: LintBlock[] };

function postMessageSpy(): ReturnType<typeof vi.fn> {
    const api = (globalThis as unknown as {
        acquireVsCodeApi: () => { postMessage: ReturnType<typeof vi.fn> };
    }).acquireVsCodeApi();
    return api.postMessage;
}

/** Every `lintBlocks` message the page has posted, in order. */
function lintRequests(spy: ReturnType<typeof vi.fn>): LintRequest[] {
    return spy.mock.calls
        .map(([msg]) => msg as LintRequest)
        .filter((msg) => msg?.type === "lintBlocks");
}

/**
 * Answer a request the way a host does: no findings for every block it asked
 * about. An UNANSWERED request teaches the cache nothing, so a test that skips
 * this measures the un-cached path and passes for the wrong reason.
 */
function answer(request: LintRequest): void {
    applyLintResults(request.id, request.blocks.map((b) => ({ key: b.key, lints: [] })));
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

describe("the proofread rescan asks the host only about what changed", () => {
    let editor: Editor;
    let spy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.clearAllMocks();
        // The cache is module state and outlives a test file's editors.
        clearLintCache();
        document.body.innerHTML = "";
        vi.useFakeTimers();
        spy = postMessageSpy();
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, DOC, vi.fn());
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    it("the first pass should ask about the whole document", async () => {
        // Arrange, Act — let the idle arm and the first scan run
        await vi.advanceTimersByTimeAsync(2000);

        // Assert — nothing is known yet, so everything is asked about. This is
        // the control: without it, an assertion that later passes ask about one
        // block would also pass on a page that never asks about anything.
        const requests = lintRequests(spy);
        expect(requests).toHaveLength(1);
        expect(requests[0].blocks.length).toBeGreaterThanOrEqual(8);
    });

    it("typing one character should ask about one block", async () => {
        // Arrange — first pass done and answered, so the cache knows the document
        await vi.advanceTimersByTimeAsync(2000);
        const first = lintRequests(spy);
        expect(first).toHaveLength(1);
        answer(first[0]);
        spy.mockClear();

        // Act — one character into the last paragraph, then the debounce elapses
        const v = view(editor);
        v.dispatch(v.state.tr.insertText("x", v.state.doc.content.size - 2));
        await vi.advanceTimersByTimeAsync(2000);

        // Assert — one block, not eight. The edit's size, not the document's.
        const requests = lintRequests(spy);
        expect(requests).toHaveLength(1);
        expect(requests[0].blocks).toHaveLength(1);
    });

    it("typing in the FIRST paragraph should still ask about one block", async () => {
        // Every block after the edit shifts position. The cache is keyed by text
        // and not by position precisely so that costs nothing; keyed by position
        // this case would re-ask about the whole document and the previous test
        // would not notice, because it edits the last block.
        await vi.advanceTimersByTimeAsync(2000);
        const first = lintRequests(spy);
        answer(first[0]);
        spy.mockClear();

        const v = view(editor);
        v.dispatch(v.state.tr.insertText("x", 3));
        await vi.advanceTimersByTimeAsync(2000);

        const requests = lintRequests(spy);
        expect(requests).toHaveLength(1);
        expect(requests[0].blocks).toHaveLength(1);
    });

    it("an edit that restores text the host has already answered for should ask nothing at all", async () => {
        await vi.advanceTimersByTimeAsync(2000);
        answer(lintRequests(spy)[0]);
        spy.mockClear();

        // Type a character, let it settle and be answered, then delete it: the
        // document is back to a state every block of which is known.
        const v = view(editor);
        const at = v.state.doc.content.size - 2;
        v.dispatch(v.state.tr.insertText("x", at));
        await vi.advanceTimersByTimeAsync(2000);
        for (const request of lintRequests(spy)) { answer(request); }
        spy.mockClear();

        v.dispatch(v.state.tr.delete(at, at + 1));
        await vi.advanceTimersByTimeAsync(2000);

        // No round trip at all, and the decorations are still applied from what
        // is known rather than left to whatever the mapping happened to leave.
        expect(lintRequests(spy)).toHaveLength(0);
    });

    it("a run of keystrokes should ask about one block per settle, never the document", async () => {
        // The shape a person types in when the editor already feels slow: each
        // character followed by a pause longer than the debounce, so every one
        // buys a whole rescan. This is the loop the defect lived in.
        await vi.advanceTimersByTimeAsync(2000);
        answer(lintRequests(spy)[0]);
        spy.mockClear();

        const v = view(editor);
        for (let i = 0; i < 5; i++) {
            v.dispatch(v.state.tr.insertText("x", v.state.doc.content.size - 2));
            await vi.advanceTimersByTimeAsync(2000);
            for (const request of lintRequests(spy)) { answer(request); }
        }

        const asked = lintRequests(spy).map((r) => r.blocks.length);
        expect(asked).toHaveLength(5);
        expect(asked.every((n) => n === 1)).toBe(true);
    });
});
