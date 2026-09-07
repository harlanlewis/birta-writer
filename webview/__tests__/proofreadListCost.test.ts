/**
 * MAR-437 — what opening the review sidebar's Proofreading tab costs.
 *
 * Two independent costs, and this file pins both.
 *
 * What ONE list build costs. Every read of a finding's text used to go through
 * the root: `doc.textBetween(from, to)` walks the root fragment from child 0
 * until it passes `to`, and `doc.resolve(from)` (which the context label asks
 * for) is the same walk again, so listing every finding cost findings times
 * blocks. The instrument here counts the children the ROOT fragment's own
 * linear walks inspect, which is the quantity that was quadratic; it is a count
 * rather than a duration, so it reads the same on a loaded runner as on an idle
 * one. Two differentials, neither needing a baseline: holding the block count
 * fixed and multiplying the findings must not move it, and doubling the blocks
 * must roughly double it rather than quadruple it.
 *
 * How MANY builds one tab click costs. The document-wide question is asked of
 * the host in slices, and every reply used to redraw, so the sidebar rebuilt its
 * whole list once per slice. A sweep is one question asked in pieces: the slice
 * that drains it draws at once, the ones before it draw on a cadence.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { editorViewCtx, type Editor } from "@milkdown/core";
import { Fragment, type EditorView, type Node as ProseNode } from "../pm";
import { createEditor } from "../editor";
import {
    applyLintResults,
    blockTextReader,
    clearStyleCache,
    listProofreadFindings,
    PROOFREAD_FINDINGS_CHANGED,
    proofreadPluginKey,
} from "../plugins/proofread";
import { initProofreadingList } from "../components/toc/proofreadingList";
import { clearLintCache } from "../proofread/lintCache";
import type { LintBlock } from "../../shared/messages";

// The full Milkdown stack is built per test, and the largest document here is
// several hundred blocks.
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

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

// ── The instrument ────────────────────────────────────────────────────────────

type RootWork = { calls: number; visits: number; children: number };

/**
 * Run `fn` and report how many children the ROOT fragment's linear walks
 * inspected. `Fragment.nodesBetween` advances from child 0 until it passes
 * `to`, and `Fragment.findIndex` (which `Node.resolve` calls at every level)
 * scans the same way, so both are counted at the position they would have
 * reached. Nested fragments are ignored: a read inside one textblock is
 * bounded by that block, which is the whole point.
 */
function rootWork<T>(doc: ProseNode, fn: () => T): { work: RootWork; value: T } {
    const root = doc.content;
    const proto = Fragment.prototype as unknown as {
        nodesBetween: (from: number, to: number, f: unknown, nodeStart?: number, parent?: unknown) => void;
        findIndex: (pos: number) => { index: number; offset: number };
    };
    const originalNodesBetween = proto.nodesBetween;
    const originalFindIndex = proto.findIndex;
    const work: RootWork = { calls: 0, visits: 0, children: root.childCount };
    proto.nodesBetween = function (this: Fragment, from, to, f, nodeStart, parent) {
        if (this === root) {
            work.calls++;
            let i = 0;
            let pos = 0;
            while (pos < to && i < this.childCount) { pos += this.child(i).nodeSize; i++; }
            work.visits += i;
        }
        return originalNodesBetween.call(this, from, to, f, nodeStart, parent);
    };
    proto.findIndex = function (this: Fragment, pos) {
        if (this === root) {
            work.calls++;
            if (pos !== 0 && pos !== this.size) {
                let i = 0;
                let cur = 0;
                while (i < this.childCount) {
                    const end = cur + this.child(i).nodeSize;
                    if (end >= pos) { break; }
                    cur = end;
                    i++;
                }
                work.visits += i + 1;
            }
        }
        return originalFindIndex.call(this, pos);
    };
    try {
        return { work, value: fn() };
    } finally {
        proto.nodesBetween = originalNodesBetween;
        proto.findIndex = originalFindIndex;
    }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * `blocks` paragraphs, each carrying `hits` style findings and one em dash. The
 * em dash is what routes a row through the context label, whose reads were the
 * second half of the same defect and which nothing else here would reach.
 */
function styleNote(blocks: number, hits: number): string {
    const fillers = ["actually", "really", "basically", "very", "just"];
    const out: string[] = [];
    for (let i = 0; i < blocks; i++) {
        const words = fillers.slice(0, hits).join(" and it is ");
        out.push(`Paragraph ${i} is ${words} a plain line — with an aside on the ${i}th thing.`);
    }
    return out.join("\n\n") + "\n";
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

const MIXED = [
    "# A heading of some length here",
    "",
    "A plain paragraph that is actually rather long, so a span inside it is not the whole block.",
    "",
    "- A list item with a filler, really",
    "- Another item, basically fine",
    "",
    "> A quoted line that is very plainly quoted.",
    "",
    "1. An ordered item, just here",
    "1. A second ordered item — with an aside",
    "",
    "| a | b |",
    "| --- | --- |",
    "| a cell that is actually wide | another cell |",
    "",
    "A closing paragraph with `inline code` beside prose.",
].join("\n") + "\n";

/** Every textblock in the document, as its content range. */
function textblockRanges(doc: ProseNode): { start: number; end: number; depth: number }[] {
    const out: { start: number; end: number; depth: number }[] = [];
    doc.descendants((node, pos) => {
        if (!node.isTextblock) { return true; }
        out.push({ start: pos + 1, end: pos + 1 + node.content.size, depth: doc.resolve(pos + 1).depth });
        return false;
    });
    return out;
}

// ── 1. The reader answers exactly what the root reads answered ────────────────

describe("blockTextReader", () => {
    let editor: Editor;

    beforeEach(async () => {
        vi.clearAllMocks();
        clearStyleCache();
        clearLintCache();
        document.body.innerHTML = "";
        (window as unknown as { __i18n: unknown }).__i18n = {
            translations: {},
            proofread: { spellCheck: false, grammarCheck: false },
        };
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, MIXED, vi.fn());
    });

    afterEach(async () => {
        delete (window as unknown as { __i18n?: unknown }).__i18n;
        await editor.destroy();
    });

    it("a span inside a textblock should read exactly what the root read gave, for every block in the document", () => {
        // Arrange
        const v = view(editor);
        const doc = v.state.doc;
        const reader = blockTextReader(doc);
        const blocks = textblockRanges(doc);

        // Act — every block, every span at a coarse stride within it, in both
        // the bare form describeFindings uses and the separator form the
        // context label uses.
        let compared = 0;
        const depths = new Set<number>();
        for (const block of blocks) {
            depths.add(block.depth);
            for (let from = block.start; from <= block.end; from += 3) {
                for (let to = from; to <= block.end; to += 5) {
                    expect(reader.textBetween(from, to)).toBe(doc.textBetween(from, to));
                    expect(reader.textBetween(from, to, " ", " ")).toBe(doc.textBetween(from, to, " ", " "));
                    expect(reader.blockRange(from)).toEqual({ start: block.start, end: block.end });
                    compared++;
                }
            }
        }

        // Assert — the sweep reached a real corpus rather than nothing. A
        // comparison that enumerated no span passes every assertion above.
        expect(blocks.length).toBeGreaterThanOrEqual(9);
        // Blocks nested at several depths, not a flat run of paragraphs: a list
        // item, a quote and a table cell each put a textblock under one more
        // parent, and the index has to place all of them.
        expect(depths.size).toBeGreaterThanOrEqual(3);
        expect(compared).toBeGreaterThan(200);
    });

    it("a span crossing two textblocks should read the whole span, not the first block's part of it", () => {
        // Arrange — the first two paragraph-ish blocks, and a span from inside
        // one to inside the next
        const v = view(editor);
        const doc = v.state.doc;
        const reader = blockTextReader(doc);
        const [first, second] = textblockRanges(doc);
        const from = first.start + 2;
        const to = second.start + 2;

        // Act
        const read = reader.textBetween(from, to, " ", " ");

        // Assert — the root's answer, which carries text from both blocks. The
        // block-local read would have stopped at the first block's end.
        expect(read).toBe(doc.textBetween(from, to, " ", " "));
        expect(read).toContain(doc.textBetween(first.start + 2, first.end));
        expect(read).toContain(doc.textBetween(second.start, second.start + 2));
    });

    it("a position between two blocks should get the range resolve would have given", () => {
        // Arrange — the position after the first top-level block, which no
        // textblock's content holds
        const v = view(editor);
        const doc = v.state.doc;
        const between = doc.child(0).nodeSize;
        expect(doc.resolve(between).parent).toBe(doc);

        // Act, Assert
        const $between = doc.resolve(between);
        expect(blockTextReader(doc).blockRange(between)).toEqual({ start: $between.start(), end: $between.end() });
    });

    it("a second reader for the same document should be the first, and a changed document should get its own", () => {
        // Arrange
        const v = view(editor);
        const first = blockTextReader(v.state.doc);

        // Act, Assert — memoized on the document
        expect(blockTextReader(v.state.doc)).toBe(first);

        // Act — an insertion in the first block
        v.dispatch(v.state.tr.insertText("ZZZ", 3));
        const doc = v.state.doc;
        const next = blockTextReader(doc);

        // Assert — a new reader, and it reads the new text rather than the old
        expect(next).not.toBe(first);
        const block = textblockRanges(doc)[0];
        expect(next.textBetween(block.start, block.end)).toBe(doc.textBetween(block.start, block.end));
        expect(next.textBetween(block.start, block.end)).toContain("ZZZ");
    });
});

// ── 2. One list build's cost ──────────────────────────────────────────────────

describe("one build of the Proofreading list", () => {
    let editor: Editor;

    async function open(doc: string): Promise<EditorView> {
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, doc, vi.fn());
        return view(editor);
    }

    beforeEach(() => {
        vi.clearAllMocks();
        clearStyleCache();
        clearLintCache();
        document.body.innerHTML = "";
        // Style only: the lint half needs a host, and the cost measured here is
        // the text read per finding, which is the same for both.
        (window as unknown as { __i18n: unknown }).__i18n = {
            translations: {},
            proofread: { spellCheck: false, grammarCheck: false },
        };
    });

    afterEach(async () => {
        delete (window as unknown as { __i18n?: unknown }).__i18n;
        await editor.destroy();
    });

    /** Build the tab's rows once, from a cold document, and report the root work. */
    function buildOnce(v: EditorView): { work: RootWork; findings: number } {
        const list = initProofreadingList(() => v);
        const { work } = rootWork(v.state.doc, () => list.refresh(v));
        return { work, findings: listProofreadFindings(v).length };
    }

    it("five times the findings over the same blocks should not move the root work", async () => {
        // Arrange — same block count, one filler per block against five
        const thin = await open(styleNote(120, 1));
        const thinBuild = buildOnce(thin);
        await editor.destroy();
        clearStyleCache();
        const thick = await open(styleNote(120, 5));
        const thickBuild = buildOnce(thick);

        // Assert — the instrument looked, and it looked at a document whose
        // findings really did multiply. Without this the comparison below
        // passes on two documents that both list nothing.
        expect(thinBuild.work.calls).toBeGreaterThan(0);
        expect(thinBuild.findings).toBeGreaterThan(100);
        expect(thickBuild.findings).toBeGreaterThan(thinBuild.findings * 3);
        expect(thickBuild.work.children).toBe(thinBuild.work.children);

        // Assert — the findings multiplied and the walking did not
        expect(thickBuild.work.visits).toBeLessThanOrEqual(thinBuild.work.visits * 1.2);
    });

    it("a build should touch each top-level block a bounded number of times, at either document size", async () => {
        // Arrange, Act — the same shape at one size and at twice it
        const small = await open(styleNote(100, 3));
        const smallBuild = buildOnce(small);
        await editor.destroy();
        clearStyleCache();
        const large = await open(styleNote(200, 3));
        const largeBuild = buildOnce(large);

        // Assert — the instrument reached a document with findings in it
        expect(smallBuild.findings).toBeGreaterThan(100);
        expect(largeBuild.findings).toBeGreaterThan(smallBuild.findings * 1.5);
        expect(smallBuild.work.calls).toBeGreaterThan(0);
        expect(largeBuild.work.calls).toBeGreaterThan(0);

        // Assert — a small multiple of the blocks, not a multiple of the
        // findings. A read per finding puts this in the hundreds per block.
        expect(smallBuild.work.visits).toBeLessThanOrEqual(smallBuild.work.children * 8);
        expect(largeBuild.work.visits).toBeLessThanOrEqual(largeBuild.work.children * 8);
        // And so twice the document is twice the work, never four times it.
        expect(largeBuild.work.visits).toBeLessThanOrEqual(smallBuild.work.visits * 2.5);
    });
});

// ── 3. How many builds one tab click costs ────────────────────────────────────

type LintRequest = { type: string; id: number; blocks: LintBlock[] };

function postMessageSpy(): ReturnType<typeof vi.fn> {
    const api = (globalThis as unknown as {
        acquireVsCodeApi: () => { postMessage: ReturnType<typeof vi.fn> };
    }).acquireVsCodeApi();
    return api.postMessage;
}

function lintRequests(spy: ReturnType<typeof vi.fn>): LintRequest[] {
    return spy.mock.calls
        .map(([msg]) => msg as LintRequest)
        .filter((msg) => msg?.type === "lintBlocks");
}

/** Answer the way a host that finds one thing per block does. */
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

describe("the review sweep's redraws", () => {
    let editor: Editor;
    let spy: ReturnType<typeof vi.fn>;

    async function open(doc: string): Promise<EditorView> {
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, doc, vi.fn());
        return view(editor);
    }

    /** The window on the first paragraph, first pass run and answered. */
    async function settled(v: EditorView): Promise<void> {
        const first = textblockRanges(v.state.doc)[1];
        v.dispatch(v.state.tr
            .setMeta(proofreadPluginKey, { type: "window", window: { from: first.start - 1, to: first.end + 1 } })
            .setMeta("addToHistory", false));
        await vi.advanceTimersByTimeAsync(2000);
        for (const request of lintRequests(spy)) { answerFlagged(request); }
        spy.mockClear();
    }

    beforeEach(() => {
        vi.clearAllMocks();
        clearStyleCache();
        clearLintCache();
        document.body.innerHTML = "";
        // Lints only: the sweep is the lint half's document-wide question.
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

    it("answering every slice back to back should announce once, when the sweep drains", async () => {
        // Arrange
        const v = await open(longNote(40, 800));
        await settled(v);
        const announced = vi.fn();
        window.addEventListener(PROOFREAD_FINDINGS_CHANGED, announced);

        try {
            // Act — the tab is read, which asks; every slice is answered as it
            // arrives, with no time passing in between
            listProofreadFindings(v);
            let answeredSlices = 0;
            while (lintRequests(spy).length > answeredSlices) {
                answerFlagged(lintRequests(spy)[answeredSlices]);
                answeredSlices++;
            }

            // Assert — the sweep really was cut into several slices, which is
            // what makes one announcement a claim about anything
            expect(answeredSlices).toBeGreaterThan(2);
            // ... and the only announcement is the one the last slice made
            expect(announced).toHaveBeenCalledTimes(1);
            expect(listProofreadFindings(v)).toHaveLength(41);
        } finally {
            window.removeEventListener(PROOFREAD_FINDINGS_CHANGED, announced);
        }
    });

    it("a sweep still in flight should announce on its cadence, so the list is not frozen for it", async () => {
        // Arrange
        const v = await open(longNote(40, 800));
        await settled(v);
        const announced = vi.fn();
        window.addEventListener(PROOFREAD_FINDINGS_CHANGED, announced);

        try {
            // Act — one slice answered, more still queued
            listProofreadFindings(v);
            answerFlagged(lintRequests(spy)[0]);

            // Assert — nothing yet: the reply is waiting on the cadence
            expect(lintRequests(spy).length).toBeGreaterThan(1); // another slice is out
            expect(announced).not.toHaveBeenCalled();

            // Act — the cadence elapses
            await vi.advanceTimersByTimeAsync(400);

            // Assert — drawn once, not once per reply
            expect(announced).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener(PROOFREAD_FINDINGS_CHANGED, announced);
        }
    });

    it("an answer to the reader's own window should still be announced at once", async () => {
        // The cadence is the sweep's alone: a window's answer is what the
        // reader is looking at, so it must not wait behind one.
        const v = await open(longNote(40, 800));
        await settled(v);
        const announced = vi.fn();
        window.addEventListener(PROOFREAD_FINDINGS_CHANGED, announced);

        try {
            // Act — a sweep is put in flight, then an edit makes the window's
            // own block unknown and its answer arrives
            listProofreadFindings(v);
            const sweepSlices = lintRequests(spy).length;
            v.dispatch(v.state.tr.insertText("zqx ", textblockRanges(v.state.doc)[1].start));
            await vi.advanceTimersByTimeAsync(2000);
            const windowRequest = lintRequests(spy)[sweepSlices];
            expect(windowRequest.blocks).toHaveLength(1);
            announced.mockClear();
            answerFlagged(windowRequest);

            // Assert — announced on the reply, with no time passing
            expect(announced).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener(PROOFREAD_FINDINGS_CHANGED, announced);
        }
    });
});
