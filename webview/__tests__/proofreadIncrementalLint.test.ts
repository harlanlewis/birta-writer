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
import {
    applyLintResults,
    hasProofreadFindings,
    listProofreadFindings,
    PROOFREAD_FINDINGS_CHANGED,
    proofreadPluginKey,
    sliceByChars,
} from "../plugins/proofread";
import { clearLintCache, lookupLints } from "../proofread/lintCache";
import type { LintBlock } from "../../shared/messages";
import type { Node as ProseNode } from "../pm";

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

    it("the first pass with no window measured should ask about the whole document", async () => {
        // Arrange, Act — let the idle arm and the first scan run. jsdom has no
        // layout, so the observer measures no window and the window is the
        // document; the windowed first pass is pinned further down.
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

    it("an answer that arrives after the document moved on should still be remembered", async () => {
        // Opening a long note and typing before the annotations settle. The
        // first pass is still in flight, so its reply is keyed to positions that
        // have moved and cannot be drawn from. Its FINDINGS are still valid,
        // because they are about text, and the rescan that follows must not
        // re-ask the host for the whole document to learn them again.
        await vi.advanceTimersByTimeAsync(2000);
        const first = lintRequests(spy);
        expect(first).toHaveLength(1);

        // Edit BEFORE answering, so the reply lands against a document that has
        // already changed.
        const v = view(editor);
        v.dispatch(v.state.tr.insertText("x", 3));
        answer(first[0]);
        spy.mockClear();

        await vi.advanceTimersByTimeAsync(2000);

        // One block: the edited one. Everything the discarded reply covered is
        // known. Before this, the whole document was asked about again.
        const requests = lintRequests(spy);
        expect(requests).toHaveLength(1);
        expect(requests[0].blocks).toHaveLength(1);
    });

    it("an answer overtaken by a newer request should still be remembered", async () => {
        // The other half of the case above, and the likelier ordering on the
        // documents this matters for: the host is slow enough that the next
        // rescan goes out BEFORE its reply arrives, so the reply answers a
        // request id the page has already moved past. On a large note the first
        // pass is the slow one, which is exactly when someone starts typing.
        await vi.advanceTimersByTimeAsync(2000);
        const first = lintRequests(spy);
        expect(first).toHaveLength(1);
        spy.mockClear();

        // Edit and let the rescan fire, all while the first reply is still out.
        const v = view(editor);
        v.dispatch(v.state.tr.insertText("x", 3));
        await vi.advanceTimersByTimeAsync(2000);
        const second = lintRequests(spy);
        expect(second).toHaveLength(1);
        // Nothing was known yet, so the second request had to ask broadly. That
        // is the control: it is what makes the third request's size meaningful.
        expect(second[0].blocks.length).toBeGreaterThanOrEqual(8);

        // ONLY the overtaken reply lands. Answering the newer one as well would
        // fill the cache by itself and this test would pass with the overtaken
        // reply thrown away, which is the thing it exists to rule out.
        answer(first[0]);
        spy.mockClear();

        v.dispatch(v.state.tr.insertText("y", 3));
        await vi.advanceTimersByTimeAsync(2000);

        // One block: the one both edits landed in. Every other block's text is
        // what the overtaken reply answered about.
        const third = lintRequests(spy);
        expect(third).toHaveLength(1);
        expect(third[0].blocks).toHaveLength(1);
    });

    it("a third open request should cost a repeated question, never a wrong decoration", async () => {
        // The bound on open requests is two, so a host slow enough to leave
        // three outstanding drops the oldest. What must survive that is
        // correctness: the page must still end up drawing findings for the whole
        // document, from the reply it does keep.
        await vi.advanceTimersByTimeAsync(2000);
        answer(lintRequests(spy)[0]);
        spy.mockClear();

        const v = view(editor);
        // Three edits, each settling into its own request, none answered.
        for (let i = 0; i < 3; i++) {
            v.dispatch(v.state.tr.insertText("x", 3));
            await vi.advanceTimersByTimeAsync(2000);
        }
        const open = lintRequests(spy);
        expect(open).toHaveLength(3);

        // Answer the OLDEST, which the bound has dropped: it must be ignored
        // rather than applied against positions three edits out of date.
        answer(open[0]);
        // Then the newest, which is the one the page is drawing from.
        answer(open[2]);
        spy.mockClear();

        // The document is fully known again, so the next settle asks nothing.
        v.dispatch(v.state.tr.insertText("y", 3));
        await vi.advanceTimersByTimeAsync(2000);
        const after = lintRequests(spy);
        expect(after).toHaveLength(1);
        expect(after[0].blocks).toHaveLength(1);
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

// ── MAR-426: the first pass asks about the window, and the rest follows the scroll ──
//
// jsdom measures no window, so every window below is committed by hand the way
// proofreadWindow.test.ts commits the style pass's. e2e/proofreadWindow drives
// the real measurement and the scroll in a browser, against a stub host.

type Span = { from: number; to: number };

/** Every textblock outside a code block, as [pos, pos + nodeSize). */
function textblocks(doc: ProseNode): Span[] {
    const out: Span[] = [];
    doc.descendants((node, pos) => {
        if (node.type.name === "code_block") { return false; }
        if (!node.isTextblock) { return true; }
        out.push({ from: pos, to: pos + node.nodeSize });
        return false;
    });
    return out;
}

function commitWindow(v: EditorView, window: Span | null): void {
    v.dispatch(
        v.state.tr
            .setMeta(proofreadPluginKey, { type: "window", window })
            .setMeta("addToHistory", false),
    );
}

/** The drawn spelling underlines, as the flagged texts in document order. */
function spellTexts(v: EditorView): string[] {
    const state = proofreadPluginKey.getState(v.state)!;
    return state.lintSet.find().map((d) => v.state.doc.textBetween(d.from, d.to));
}

/** The whole block text of each asked block. */
const askedTexts = (requests: LintRequest[]): string[] => requests.flatMap((r) => r.blocks.map((b) => b.text));

/**
 * Answer the way a host that finds something does: one spelling finding on the
 * first word of every block it was asked about, so a drawn underline names the
 * block it belongs to.
 */
function answerFlagged(request: LintRequest): void {
    applyLintResults(request.id, request.blocks.map((b) => ({
        key: b.key,
        lints: [{
            start: 0,
            end: b.text.indexOf(" ") > 0 ? b.text.indexOf(" ") : b.text.length,
            kind: "Spelling",
            message: "stub",
            suggestions: [],
        }],
    })));
}

/** Distinct paragraphs of about `chars` characters each, so slices are forced. */
function longNote(paragraphs: number, chars: number): string {
    let out = "# Long note\n\n";
    for (let i = 1; i <= paragraphs; i++) {
        const sentence = `Paragraph ${i} keeps going about the ${i}th thing in plain words. `;
        out += sentence.repeat(Math.ceil(chars / sentence.length)).trim() + "\n\n";
    }
    return out;
}

describe("the first lint request covers the window, and the rest follows the scroll", () => {
    let editor: Editor;
    let spy: ReturnType<typeof vi.fn>;

    async function open(doc: string): Promise<EditorView> {
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, doc, vi.fn());
        return view(editor);
    }

    beforeEach(() => {
        vi.clearAllMocks();
        clearLintCache();
        document.body.innerHTML = "";
        // Lints only: the style half is windowed by MAR-425 and pinned by
        // proofreadWindow.test.ts, and a style hit here would make the tab
        // question below answer for the wrong reason.
        (window as unknown as { __i18n: unknown }).__i18n = {
            translations: {},
            proofread: { styleCheck: false },
        };
        vi.useFakeTimers();
        spy = postMessageSpy();
    });

    afterEach(async () => {
        vi.useRealTimers();
        delete (window as unknown as { __i18n?: unknown }).__i18n;
        await editor.destroy();
    });

    it("a window committed before the first pass should make the first request the window's blocks and nothing else", async () => {
        // Arrange — the window over the first two paragraphs, before the idle arm
        const v = await open(DOC);
        const [, p1, p2] = textblocks(v.state.doc);
        commitWindow(v, { from: p1.from, to: p2.to });

        // Act — the first pass
        await vi.advanceTimersByTimeAsync(2000);

        // Assert — two of eight blocks, the window's own; the control is the
        // whole-document case above, which asks about all eight
        const requests = lintRequests(spy);
        expect(requests).toHaveLength(1);
        expect(askedTexts(requests)).toEqual([
            "Alpha paragraph about the first thing entirely.",
            "Beta paragraph about the second thing entirely.",
        ]);
        expect(textblocks(v.state.doc).length).toBe(8);
    });

    it("a window commit after the first pass should draw the known blocks on the frame and ask about the unknown ones after the delay", async () => {
        // Arrange — first pass over p1..p2, answered with a finding per block
        const v = await open(DOC);
        const [, p1, p2, p3, p4] = textblocks(v.state.doc);
        commitWindow(v, { from: p1.from, to: p2.to });
        await vi.advanceTimersByTimeAsync(2000);
        answerFlagged(lintRequests(spy)[0]);
        expect(spellTexts(v)).toEqual(["Alpha", "Beta"]);
        spy.mockClear();
        const announced = vi.fn();
        window.addEventListener(PROOFREAD_FINDINGS_CHANGED, announced);

        try {
            // Act — the window moves onto p2..p4; no timers
            commitWindow(v, { from: p2.from, to: p4.to });

            // Assert — the frame the window moved: p2 is drawn from what is
            // known, p1 is out, p3 and p4 are not yet known; nothing announced,
            // because no finding changed, and nothing asked yet
            expect(spellTexts(v)).toEqual(["Beta"]);
            expect(announced).not.toHaveBeenCalled();
            expect(lintRequests(spy)).toHaveLength(0);

            // Act — the coalescing delay elapses
            await vi.advanceTimersByTimeAsync(400);

            // Assert — one request, for the two blocks that arrived unknown
            const requests = lintRequests(spy);
            expect(requests).toHaveLength(1);
            expect(askedTexts(requests)).toEqual([
                "Gamma paragraph about the third thing entirely.",
                "Delta paragraph about the fourth thing entirely.",
            ]);

            // Act — the answer lands
            answerFlagged(requests[0]);

            // Assert — the window is complete, and the sidebar is told
            expect(spellTexts(v)).toEqual(["Beta", "Gamma", "Delta"]);
            expect(announced).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener(PROOFREAD_FINDINGS_CHANGED, announced);
        }
    });

    it("a flick through several windows should ask once, for the window it lands on", async () => {
        // Arrange — first pass over p1..p2, answered
        const v = await open(DOC);
        const [, p1, p2, p3, p4, p5, p6, p7] = textblocks(v.state.doc);
        commitWindow(v, { from: p1.from, to: p2.to });
        await vi.advanceTimersByTimeAsync(2000);
        answer(lintRequests(spy)[0]);
        spy.mockClear();

        // Act — three commits inside the delay, then the delay
        commitWindow(v, { from: p3.from, to: p4.to });
        await vi.advanceTimersByTimeAsync(50);
        commitWindow(v, { from: p5.from, to: p6.to });
        await vi.advanceTimersByTimeAsync(50);
        commitWindow(v, { from: p6.from, to: p7.to });
        await vi.advanceTimersByTimeAsync(400);

        // Assert — one question, about where the reader stopped
        const requests = lintRequests(spy);
        expect(requests).toHaveLength(1);
        expect(askedTexts(requests)).toEqual([
            "Zeta paragraph about the sixth thing entirely.",
            "Eta paragraph about the seventh thing entirely.",
        ]);
    });

    it("an evicted window request's blocks should be asked about again when their window returns", async () => {
        // Arrange — three windows asked about, none answered, so the first is
        // evicted by the bound on open requests
        const v = await open(DOC);
        const [, p1, p2, p3, p4, p5, p6] = textblocks(v.state.doc);
        commitWindow(v, { from: p1.from, to: p2.to });
        await vi.advanceTimersByTimeAsync(2000);
        commitWindow(v, { from: p3.from, to: p4.to });
        await vi.advanceTimersByTimeAsync(400);
        commitWindow(v, { from: p5.from, to: p6.to });
        await vi.advanceTimersByTimeAsync(400);
        const open3 = lintRequests(spy);
        expect(open3).toHaveLength(3);

        // Act — the evicted reply arrives, then the reader scrolls back
        answerFlagged(open3[0]);
        spy.mockClear();
        commitWindow(v, { from: p1.from, to: p2.to });
        await vi.advanceTimersByTimeAsync(400);

        // Assert — nothing was remembered from the evicted reply, nothing was
        // drawn from it, and the window is asked about again: the cost of the
        // bound is a repeated question
        expect(lookupLints("Alpha paragraph about the first thing entirely.")).toBeUndefined();
        expect(spellTexts(v)).toEqual([]);
        const again = lintRequests(spy);
        expect(again).toHaveLength(1);
        expect(askedTexts(again)).toEqual([
            "Alpha paragraph about the first thing entirely.",
            "Beta paragraph about the second thing entirely.",
        ]);
    });

    it("a rescan behind an edit should ask about the edited block, not the window, and the edit should not read as a window commit", async () => {
        // Arrange — window p1..p3, first pass answered
        const v = await open(DOC);
        const [, p1, , p3] = textblocks(v.state.doc);
        commitWindow(v, { from: p1.from, to: p3.to });
        await vi.advanceTimersByTimeAsync(2000);
        answer(lintRequests(spy)[0]);
        spy.mockClear();
        // Every `lint-request` stamp, captured at the call: a window ask that
        // rode the edit would find the window known and post nothing, so the
        // posts alone cannot see it, but it would still stamp a counter.
        const stamps: number[] = [];
        const original = performance.mark;
        performance.mark = ((name: string, options?: { detail?: { blocks?: number } }) => {
            if (name.endsWith("lint-request")) { stamps.push(options?.detail?.blocks ?? -1); }
            return original?.call(performance, name);
        }) as typeof performance.mark;

        try {
            // Act — one character into p1, then the debounce and the window delay
            v.dispatch(v.state.tr.insertText("x", p1.from + 3));
            await vi.advanceTimersByTimeAsync(2000);
        } finally {
            performance.mark = original;
        }

        // Assert — one block, asked once: the window moved with the edit (a
        // new object), which is not a commit, so no second question was asked
        const requests = lintRequests(spy);
        expect(requests).toHaveLength(1);
        expect(requests[0].blocks).toHaveLength(1);
        expect(stamps).toEqual([1]);
    });

    it("listing the document should ask for what nothing has asked about, in slices, one in flight, until every block is known", async () => {
        // Arrange — a note whose remainder is well over one slice, window on
        // the first paragraph only, first pass answered
        const v = await open(longNote(30, 400));
        const all = textblocks(v.state.doc);
        expect(all.length).toBe(31);
        commitWindow(v, all[1]);
        await vi.advanceTimersByTimeAsync(2000);
        const first = lintRequests(spy);
        expect(first).toHaveLength(1);
        expect(first[0].blocks).toHaveLength(1);
        answerFlagged(first[0]);
        spy.mockClear();

        // Act — the review list is read, twice: the second read must not send a
        // second slice while the first is unanswered
        const partial = listProofreadFindings(v);
        listProofreadFindings(v);

        // Assert — what was known is listed, and one slice is out
        expect(partial.map((f) => f.text)).toEqual(["Paragraph"]);
        let requests = lintRequests(spy);
        expect(requests).toHaveLength(1);
        const chars = (r: LintRequest) => r.blocks.reduce((n, b) => n + b.text.length, 0);
        expect(chars(requests[0])).toBeLessThanOrEqual(8000);
        expect(requests[0].blocks.length).toBeLessThan(30); // not the whole remainder

        // Act — answer slices as they come, until the page stops asking
        let rounds = 0;
        while (lintRequests(spy).length > rounds) {
            answerFlagged(lintRequests(spy)[rounds]);
            rounds++;
        }
        requests = lintRequests(spy);

        // Assert — more than one slice, each within budget, together exactly
        // the rest of the document, each block once
        expect(requests.length).toBeGreaterThan(1);
        for (const r of requests) { expect(chars(r)).toBeLessThanOrEqual(8000); }
        const askedNow = askedTexts(requests);
        const everyText = all.map((b) => v.state.doc.nodeAt(b.from)!.textContent);
        expect([...askedTexts(first), ...askedNow].sort()).toEqual([...everyText].sort());
        expect(new Set(askedNow).size).toBe(askedNow.length);

        // And the list now holds a finding per block, with the drawn set still
        // the window's one paragraph
        expect(listProofreadFindings(v)).toHaveLength(31);
        expect(spellTexts(v)).toEqual(["Paragraph"]);
        expect(lintRequests(spy)).toHaveLength(rounds); // nothing left to ask
    });

    it("the tab question should say yes while blocks outside the window are unasked, and no once they are answered clean", async () => {
        // Arrange — window on p1, first pass, answered with nothing
        const v = await open(DOC);
        const [, p1] = textblocks(v.state.doc);
        commitWindow(v, p1);
        await vi.advanceTimersByTimeAsync(2000);

        // Assert — p1 is in flight INSIDE the window and does not count; the
        // six paragraphs outside it do
        expect(hasProofreadFindings(v)).toBe(true);
        answer(lintRequests(spy)[0]);
        expect(hasProofreadFindings(v)).toBe(true);

        // Act — the review asks for the rest, and the host finds nothing
        listProofreadFindings(v);
        for (const r of lintRequests(spy)) { answer(r); }

        // Assert — nothing known, nothing pending: no tab
        expect(hasProofreadFindings(v)).toBe(false);
        expect(listProofreadFindings(v)).toEqual([]);
    });

    it("sliceByChars should cut at the budget and never split a block", () => {
        const b = (n: number) => ({ key: n, text: "x".repeat(n) });
        expect(sliceByChars([b(3), b(3), b(3)], 6).map((s) => s.map((x) => x.key))).toEqual([[3, 3], [3]]);
        expect(sliceByChars([b(10), b(1)], 6).map((s) => s.map((x) => x.key))).toEqual([[10], [1]]);
        expect(sliceByChars([], 6)).toEqual([]);
        expect(sliceByChars([b(1), b(1)], 6)).toHaveLength(1);
    });
});
