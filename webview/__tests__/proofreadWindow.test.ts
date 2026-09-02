/**
 * MAR-425 — the style pass's scroll window.
 *
 * The style matcher used to walk every textblock in the document on the first
 * pass after paint and again on every debounced rescan behind typing. Style
 * hits are decoration with no off-screen meaning, so the pass now runs over
 * the blocks near the viewport (plugins/visibleRange.ts, the fold gutter's
 * window) and follows the scroll. That is safe only if these hold, and this
 * file pins each:
 *
 *   1. PARITY. For any window, the decorations built inside it are the
 *      whole-document walk's decorations restricted to the blocks that overlap
 *      it, byte for byte. This is the one assertion that can catch a windowed
 *      pass decorating the wrong blocks, so it is a differential enumerated over
 *      every pair of block boundaries and mid-block positions, not a sample.
 *   2. A window committed BEFORE the first pass only records itself; the pass
 *      then builds once, for it. A window committed AFTER it is the build for
 *      the blocks that arrived, synchronously, and announces no findings change
 *      (the findings did not change; which are drawn did).
 *   3. The window rides an edit in document positions, so the rescan after an
 *      insertion above it still decorates the same blocks.
 *   4. Document-wide STATE stays document-wide: the review sidebar's list and
 *      the tab-visibility question are answered for the whole document, not
 *      the window, and a suppression rebuild keeps the window.
 *   5. The `style-scan` work counter reports the blocks the pass visited, which
 *      under a window is the window's count and not the document's.
 *
 * jsdom has no layout, so the observer measures no window here and every
 * window in this file is committed by hand, as the fold-window tests do.
 * The real measurement, and the scroll, are exercised by e2e/proofreadWindow.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, parserCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView, Node as ProseNode } from "../pm";
import type { DecorationSet } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { createEditor } from "../editor";
import {
    clearStyleCache,
    computeDecorations,
    DEFAULT_CONFIG,
    hasProofreadFindings,
    listProofreadFindings,
    PROOFREAD_FINDINGS_CHANGED,
    proofreadPluginKey,
    refreshProofread,
} from "../plugins/proofread";
import { ignoreStyleSession } from "../proofread/engine";
import type { ProofreadConfig } from "../../shared/messages";

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

/** Style only: the lint half needs a host, and is not what is windowed here. */
const CONFIG: ProofreadConfig = { ...DEFAULT_CONFIG, spellCheck: false, grammarCheck: false };

type Span = { from: number; to: number };
type Hit = { from: number; to: number; cls: string; category: string; suggestion: string | null };

function hitsOf(set: DecorationSet): Hit[] {
    return set.find().map((d) => {
        const spec = d.spec as { class: string; style: { category: string; suggestion: string | null } };
        return { from: d.from, to: d.to, cls: spec.class, category: spec.style.category, suggestion: spec.style.suggestion };
    });
}

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

/** The whole-document hits restricted to the blocks that overlap `w`. */
function restrict(all: Hit[], doc: ProseNode, w: Span): Hit[] {
    return all.filter((h) => {
        const $ = doc.resolve(h.from);
        return $.before() < w.to && $.after() > w.from;
    });
}

// ── 1. Parity: a pure-function differential over a real parsed document ────

const PARITY_DOC = [
    "# Windowed style pass, actually",
    "",
    "This paragraph is actually the first one, and it is really plain.",
    "",
    "- An item that is basically fine",
    "- Another item, really",
    "",
    "> A quote that is actually quoted.",
    "",
    "```js",
    "// code is actually never scanned",
    "```",
    "",
    "Inline `code that is really masked` beside prose that is actually scanned.",
    "",
    "Repeated the the word here.",
    "",
    "## Second heading, basically",
    "",
    "Final paragraph, basically.",
    "",
].join("\n");

async function parse(markdown: string): Promise<{ doc: ProseNode; destroy: () => void }> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, "# seed\n\nseed\n");
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    const parser = editor.action((ctx) => ctx.get(parserCtx));
    const doc = parser(markdown);
    if (!doc) { throw new Error("parse failed"); }
    return { doc, destroy: () => { editor.destroy(); root.remove(); } };
}

describe("computeDecorations over a window", () => {
    it("for every window should equal the whole-document walk restricted to the blocks it overlaps", async () => {
        // Arrange — a document whose textblocks sit at several depths, with a
        // code block the walk must skip and inline code it must mask.
        const { doc, destroy } = await parse(PARITY_DOC);
        try {
            const blocks = textblocks(doc);
            const all = hitsOf(computeDecorations(doc, CONFIG, null));
            // The instrument has to have reached something: a document that
            // trips no check would make every window agree on nothing.
            expect(blocks.length).toBeGreaterThanOrEqual(9);
            expect(all.length).toBeGreaterThanOrEqual(9);
            expect(hitsOf(computeDecorations(doc, CONFIG))).toEqual(all); // the default is the whole document

            // Every block boundary and every mid-block position, so a window
            // edge falls inside a block as often as between two.
            const points = new Set<number>([0, doc.content.size]);
            for (const b of blocks) {
                points.add(b.from);
                points.add(b.to);
                points.add(b.from + Math.floor((b.to - b.from) / 2));
            }
            const sorted = [...points].sort((a, b) => a - b);

            // Act + Assert — the differential, over every pair
            let windows = 0;
            let strictSubsets = 0;
            const disagreements: string[] = [];
            for (let i = 0; i < sorted.length; i++) {
                for (let j = i + 1; j < sorted.length; j++) {
                    const w = { from: sorted[i], to: sorted[j] };
                    windows++;
                    const windowed = hitsOf(computeDecorations(doc, CONFIG, w));
                    const expected = restrict(all, doc, w);
                    if (JSON.stringify(windowed) !== JSON.stringify(expected)) {
                        disagreements.push(`${w.from}-${w.to}: got ${JSON.stringify(windowed)}, expected ${JSON.stringify(expected)}`);
                    }
                    if (windowed.length > 0 && windowed.length < all.length) { strictSubsets++; }
                }
            }
            expect(disagreements).toEqual([]);
            // The enumeration's own size, and that it held windows that
            // actually cut the document rather than all-or-nothing ones.
            expect(windows).toBeGreaterThan(100);
            expect(strictSubsets).toBeGreaterThan(20);
        } finally {
            destroy();
        }
    });

    it("a window edge inside a block should still yield that block's hits whole", async () => {
        // Arrange — the first paragraph: "actually" near its start, "really"
        // near its end. A window that ends between them overlaps the block.
        const { doc, destroy } = await parse(PARITY_DOC);
        try {
            const all = hitsOf(computeDecorations(doc, CONFIG, null));
            const paragraph = textblocks(doc)[1];
            const inside = all.filter((h) => h.from >= paragraph.from && h.to <= paragraph.to);
            expect(inside.map((h) => doc.textBetween(h.from, h.to))).toEqual(["actually", "really"]);

            // Act — a window that covers only the block's first few characters
            const w = { from: paragraph.from, to: paragraph.from + 4 };
            const windowed = hitsOf(computeDecorations(doc, CONFIG, w));

            // Assert — both hits, including the one past the window's edge:
            // what a block yields never depends on where the edge fell in it.
            expect(windowed).toEqual(inside);
        } finally {
            destroy();
        }
    });
});

// ── 2 to 5. The plugin, driven through the real editor ────────────────────

const DOC = [
    "# Notes",
    "",
    "This first paragraph is actually here.",
    "",
    "This second paragraph is really here.",
    "",
    "This third paragraph is basically here.",
    "",
].join("\n");

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function commitWindow(v: EditorView, window: Span | null): void {
    v.dispatch(
        v.state.tr
            .setMeta(proofreadPluginKey, { type: "window", window })
            .setMeta("addToHistory", false),
    );
}

function styleTexts(v: EditorView): string[] {
    const state = proofreadPluginKey.getState(v.state)!;
    return state.styleSet.find().map((d) => v.state.doc.textBetween(d.from, d.to));
}

/** The top-level blocks in order: [heading, p1, p2, p3]. */
function blocks(v: EditorView): Span[] {
    return textblocks(v.state.doc);
}

type Counter = { name: string; amounts: Record<string, number> };

/** Capture `countWork` at the call (fake timers replace `performance`; see perKeystrokeWork.test.ts). */
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

describe("the proofread plugin's style window", () => {
    let editor: Editor;

    beforeEach(async () => {
        vi.clearAllMocks();
        // The match cache is module-level and every test opens the same
        // document, so without this the second test's first pass regexes nothing
        // and the counter cases read zero.
        clearStyleCache();
        document.body.innerHTML = "";
        (window as unknown as { __i18n: unknown }).__i18n = {
            translations: {},
            proofread: { spellCheck: false, grammarCheck: false },
        };
        vi.useFakeTimers();
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, DOC, vi.fn());
    });

    afterEach(async () => {
        vi.useRealTimers();
        delete (window as unknown as { __i18n?: unknown }).__i18n;
        await editor.destroy();
    });

    it("a window committed before the first pass should only be recorded, and the pass should build for it", async () => {
        // Arrange — no timers advanced: the idle arm has not fired
        const v = view(editor);
        const [, p1] = blocks(v);

        // Act — the observer commits a window (here, by hand) before the pass
        commitWindow(v, p1);
        const before = proofreadPluginKey.getState(v.state)!;

        // Assert — recorded, not built: nothing is drawn before the pass
        expect(before.window).toEqual(p1);
        expect(before.styleDoc).toBeNull();
        expect(styleTexts(v)).toEqual([]);

        // Act — the first pass
        await vi.advanceTimersByTimeAsync(2000);

        // Assert — built once, for the window: the other two fillers are outside it
        expect(styleTexts(v)).toEqual(["actually"]);
        expect(proofreadPluginKey.getState(v.state)!.styleDoc).toBe(v.state.doc);
    });

    it("a window committed after the first pass should rebuild synchronously and announce no findings change", async () => {
        // Arrange — first pass complete over the whole document (no window)
        await vi.advanceTimersByTimeAsync(2000);
        const v = view(editor);
        expect(styleTexts(v)).toEqual(["actually", "really", "basically"]);
        const [, , p2] = blocks(v);
        const announced = vi.fn();
        window.addEventListener(PROOFREAD_FINDINGS_CHANGED, announced);

        try {
            // Act — the window moves onto the second paragraph; no timers
            commitWindow(v, p2);

            // Assert — the frame the window moved is the frame it is drawn
            expect(styleTexts(v)).toEqual(["really"]);
            // The findings did not change, only which are drawn, so the review
            // sidebar (refreshed SOLELY by this event) is not asked to re-read.
            expect(announced).not.toHaveBeenCalled();

            // Act — back to the whole document
            commitWindow(v, null);
            expect(styleTexts(v)).toEqual(["actually", "really", "basically"]);
            expect(announced).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener(PROOFREAD_FINDINGS_CHANGED, announced);
        }
    });

    it("an edit above the window should carry the window with it, so the rescan decorates the same blocks", async () => {
        // Arrange — first pass, then the window on the third paragraph
        await vi.advanceTimersByTimeAsync(2000);
        const v = view(editor);
        const [, , , p3] = blocks(v);
        commitWindow(v, p3);
        expect(styleTexts(v)).toEqual(["basically"]);

        // Act — insert three characters into the heading, above the window,
        // then let the debounced rescan run
        v.dispatch(v.state.tr.insertText("xyz", 3));
        const mapped = proofreadPluginKey.getState(v.state)!.window;
        await vi.advanceTimersByTimeAsync(2000);

        // Assert — the window moved by the insertion, and the rescan built for
        // the moved window: still the third paragraph, still nothing else
        expect(mapped).toEqual({ from: p3.from + 3, to: p3.to + 3 });
        expect(styleTexts(v)).toEqual(["basically"]);
    });

    it("the review sidebar's list and tab question should be answered for the whole document", async () => {
        // Arrange — first pass, then a window over the heading alone, which
        // holds no hit: the drawn set is empty while the document has three
        await vi.advanceTimersByTimeAsync(2000);
        const v = view(editor);
        const [heading] = blocks(v);
        commitWindow(v, heading);
        expect(styleTexts(v)).toEqual([]);

        // Act + Assert — the surfaces that LIST findings see all three
        expect(listProofreadFindings(v).map((f) => f.text)).toEqual(["actually", "really", "basically"]);
        expect(hasProofreadFindings(v)).toBe(true);
    });

    it("the style-scan counter should report the blocks the matcher ran on: the window's, then only what it had not seen", async () => {
        // Arrange — the window on the second paragraph BEFORE the first pass;
        // the capture is installed after fake timers so it patches the clock's
        // own `performance`
        const v = view(editor);
        const [, , p2] = blocks(v);
        commitWindow(v, p2);
        const capture = captureCounters();
        try {
            // Act — the first pass, windowed; then the whole document
            await vi.advanceTimersByTimeAsync(2000);
            commitWindow(v, null);

            // Assert — exact numbers, the fixture's own shape: the first pass
            // regexes the one paragraph in the window; the whole-document build
            // regexes the heading and the two paragraphs it had not seen, and
            // not the one it had. A counter that read 4 there would be a pass
            // paying for the document again.
            const scans = capture.seen.filter((c) => c.name.endsWith("style-scan"));
            expect(scans.map((c) => c.amounts.blocks)).toEqual([1, 3]);
            expect(scans[0].amounts.chars).toBeLessThan(scans[1].amounts.chars);
        } finally {
            capture.restore();
        }
    });

    it("a rescan behind an edit should run the matcher on the edited block alone", async () => {
        // Arrange — first pass over the whole document, everything cached
        await vi.advanceTimersByTimeAsync(2000);
        const v = view(editor);
        const capture = captureCounters();
        try {
            // Act — one character into the second paragraph, then the debounce
            const [, , p2] = blocks(v);
            v.dispatch(v.state.tr.insertText("x", p2.from + 6));
            await vi.advanceTimersByTimeAsync(2000);

            // Assert — one block regexed: the one whose text is new
            const scans = capture.seen.filter((c) => c.name.endsWith("style-scan"));
            expect(scans.length).toBeGreaterThan(0);
            expect(scans.map((c) => c.amounts.blocks)).toEqual(scans.map(() => 1));
        } finally {
            capture.restore();
        }
    });

    // Last on purpose: a session ignore has no reset, so nothing after this
    // may depend on "actually" being a live hit.
    it("a suppression rebuild should keep the window", async () => {
        // Arrange — first pass, window on the first paragraph
        await vi.advanceTimersByTimeAsync(2000);
        const v = view(editor);
        const [, p1] = blocks(v);
        commitWindow(v, p1);
        expect(styleTexts(v)).toEqual(["actually"]);

        // Act — ignore the one in-window hit, which rebuilds from the popup's path
        ignoreStyleSession("fillers", "actually");
        refreshProofread(v);

        // Assert — the rebuild is still windowed (the other two fillers are not
        // pulled in), and the sidebar's whole-document list dropped the ignored
        // one while keeping the rest
        expect(styleTexts(v)).toEqual([]);
        expect(listProofreadFindings(v).map((f) => f.text)).toEqual(["really", "basically"]);
    });
});
