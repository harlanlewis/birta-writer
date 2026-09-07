/**
 * MAR-436: the find bar maps only the matches the reader can see.
 *
 * `domRange` calls `view.domAtPos` twice per match and `domAtPos` walks the
 * top-level view descs from the start, so an unwindowed highlight pass costs
 * two walks per match — tens of thousands of them per keystroke on a large
 * document with a common query.
 *
 * The instrument is a counting `domAtPos` on a fake view. A count is the right
 * assertion rather than a duration: it is deterministic, independent of what
 * else is running on the machine, and it is the quantity the defect is about.
 *
 * `measureVisibleWindow` returns null with no layout engine, and every
 * consumer reads null as "the whole document", so jsdom cannot produce a
 * window on its own. These tests therefore drive the window through the
 * observer's own scroll path, exactly as a scroll would.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { EditorView } from "../pm";
import { Schema, type Node as PmNode } from "../pm";
import { EditorState, type Transaction } from "../pm";
import { createEventManager } from "../eventManager";
import { initFindBar } from "../components/findBar";

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        text: { group: "inline" },
    },
});

/**
 * Pending animation-frame callbacks.
 *
 * The stub must DEFER rather than run inline: `observeVisibleWindow` guards
 * re-entry with `frame === null`, and it assigns the id AFTER
 * `requestAnimationFrame` returns. An inline stub therefore leaves a non-null
 * id behind that no tick ever clears, and every scroll after the first is
 * silently swallowed — which reads in a test exactly like a window that did
 * not change.
 */
let rafQueue: FrameRequestCallback[] = [];

function drainFrames(): void {
    for (let guard = 0; guard < 20 && rafQueue.length; guard++) {
        const due = rafQueue;
        rafQueue = [];
        for (const cb of due) { cb(0); }
    }
}

const p = (text: string) => schema.node("paragraph", null, [schema.text(text)]);
const mkDoc = (...content: PmNode[]) => schema.node("doc", null, content);

/** A document of `blocks` paragraphs, each holding exactly one "foo". */
const fooDoc = (blocks: number) =>
    mkDoc(...Array.from({ length: blocks }, (_, i) => p(`foo block ${i}`)));

interface Harness {
    findBar: ReturnType<typeof initFindBar>;
    calls: () => number;
    reset: () => void;
    /** Publish a scroll window, as `observeVisibleWindow` would on a scroll. */
    setWindow: (win: { from: number; to: number } | null) => void;
}

function setup(doc: PmNode): Harness {
    document.body.innerHTML = "";
    const editor = document.createElement("div");
    editor.id = "editor";
    document.body.appendChild(editor);
    const probeText = document.createTextNode("probe");
    editor.appendChild(probeText);

    let state = EditorState.create({ doc });
    let domAtPosCalls = 0;

    // The window is measured from layout, which jsdom does not have. These
    // three are what `measureVisibleWindow` reads; driving them is what makes
    // it return a real window instead of null.
    // The editor box must be far taller than the viewport plus the observer's
    // two-screen margin on each side, or both probe points fall outside it and
    // `measureVisibleWindow` saturates to the whole document — which is the
    // very case these tests are trying to leave.
    let windowRange: { from: number; to: number } | null = null;
    editor.getBoundingClientRect = () =>
        ({ top: -10000, bottom: 100000, left: 0, right: 800, width: 800, height: 110000 }) as DOMRect;
    Object.defineProperty(editor, "isConnected", { value: true, configurable: true });

    const view = {
        get state() { return state; },
        dispatch(tr: Transaction) { state = state.apply(tr); },
        focus() { /* noop */ },
        domAtPos() {
            domAtPosCalls++;
            return { node: probeText, offset: 0 };
        },
        nodeDOM: () => null,
        posAtCoords: ({ top }: { left: number; top: number }) =>
            windowRange === null
                ? null
                : { pos: top < 0 ? windowRange.from : windowRange.to, inside: -1 },
        get isDestroyed() { return false; },
        dom: editor,
    };

    const eventManager = createEventManager();
    const findBar = initFindBar(
        () => view as unknown as EditorView,
        () => "",
        eventManager,
    );

    return {
        findBar,
        calls: () => domAtPosCalls,
        reset: () => { domAtPosCalls = 0; },
        setWindow: (win) => {
            windowRange = win;
            // A resize is the observer's own "re-measure regardless of the
            // scroll delta" path.
            window.dispatchEvent(new Event("resize"));
            drainFrames();
        },
    };
}

describe("find bar highlight windowing", () => {
    beforeEach(() => {
        window.scrollTo = vi.fn();
        vi.stubGlobal("Highlight", class {
            priority = 0;
            constructor(..._ranges: Range[]) { /* paint-only stub */ }
        });
        vi.stubGlobal("CSS", { highlights: new Map() });
        rafQueue = [];
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
            rafQueue.push(cb);
            return rafQueue.length;
        });
        vi.stubGlobal("cancelAnimationFrame", () => { rafQueue = []; });
        window.innerHeight = 1000;
    });

    it("no measurable window should map every match, as before", () => {
        // The pre-existing contract: with no layout engine the window is null
        // and null means the whole document. This is what keeps every other
        // find-bar test true.
        const { findBar, calls } = setup(fooDoc(100));
        findBar.open("foo");
        // Two `domAtPos` per match to build its range, and `search` paints
        // twice (once through `scrollToMatch`, once itself), plus one call for
        // the current match's scroll target: 4N + 1.
        expect(calls()).toBe(401);
    });

    it("a scroll window should map only the matches inside it", () => {
        const { findBar, calls, reset, setWindow } = setup(fooDoc(100));
        findBar.open("foo");
        // A window over roughly the first tenth of the document. Positions:
        // each paragraph is "foo block N" so ~13-14 tokens; 100 blocks is
        // ~1400. Take the first 140.
        reset();
        setWindow({ from: 0, to: 140 });
        const windowed = calls();

        // It actually painted something: an instrument that mapped nothing
        // would also report a small number.
        expect(windowed).toBeGreaterThan(0);
        // And it is a small fraction of the unwindowed 200.
        expect(windowed).toBeLessThan(60);
    });

    it("a wider window should map strictly more matches than a narrow one", () => {
        // The discriminating check: a predicate that ignored the window, or
        // one that returned a constant, would fail this.
        const narrow = setup(fooDoc(100));
        narrow.findBar.open("foo");
        narrow.reset();
        narrow.setWindow({ from: 0, to: 140 });

        const wide = setup(fooDoc(100));
        wide.findBar.open("foo");
        wide.reset();
        wide.setWindow({ from: 0, to: 700 });

        expect(wide.calls()).toBeGreaterThan(narrow.calls());
    });

    it("cost should scale with the window, not with the document", () => {
        // The invariant the ticket is about. The same window over documents of
        // very different sizes must cost about the same.
        const readings = [100, 200, 400].map((blocks) => {
            const h = setup(fooDoc(blocks));
            h.findBar.open("foo");
            h.reset();
            h.setWindow({ from: 0, to: 140 });
            return h.calls();
        });

        expect(readings.every((c) => c > 0)).toBe(true);
        // Unwindowed these would be 200, 400 and 800. Windowed they are equal.
        expect(new Set(readings).size).toBe(1);
    });

    it("the current match should be mapped even when it is outside the window", () => {
        // Navigation calls updateHighlights BEFORE it scrolls, so the window
        // has not caught up; skipping the current match would leave the match
        // the user just jumped to unpainted.
        const { findBar, calls, reset, setWindow } = setup(fooDoc(100));
        findBar.open("foo");
        setWindow({ from: 0, to: 140 });

        // Step to a match far past the window's end.
        for (let i = 0; i < 60; i++) {
            findBar.findNext();
        }
        reset();
        setWindow({ from: 0, to: 141 });
        const withCurrentOutside = calls();

        // The window holds ~10 matches; the current one is the 61st. If the
        // current match were dropped this would equal the plain windowed
        // count, so assert it is strictly greater.
        const baseline = setup(fooDoc(100));
        baseline.findBar.open("foo");
        baseline.reset();
        baseline.setWindow({ from: 0, to: 141 });

        expect(withCurrentOutside).toBeGreaterThan(baseline.calls());
    });
});
