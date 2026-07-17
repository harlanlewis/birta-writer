/**
 * The word-count reporter sits on the editor's selection-change handler, which
 * fires on every caret move as well as every edit. Counting the whole document
 * is O(document size), so these tests pin the three things that keep it off the
 * critical path:
 *
 *  - the debounce (bursts coalesce; nothing runs on the keystroke path),
 *  - the doc-identity cache (a caret move must NOT recount the document —
 *    ProseMirror nodes are immutable, so an unchanged doc is the same object),
 *  - the idle deferral (the compute fills a gap between frames, bounded by a
 *    timeout so a busy main thread can't starve it).
 *
 * `countText` is spied on rather than mocked out, so the counts stay real and
 * the assertions are about how OFTEN the expensive work runs.
 *
 * jsdom has no requestIdleCallback; the reporter falls back to setTimeout(0),
 * which fake timers advance. The idle-specific cases install a stub to observe
 * the real arm.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Schema } from "../pm";
import { EditorState, TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { mockVscodeApi } from "./setup";

const countTextSpy = vi.hoisted(() => vi.fn());
vi.mock("../utils/wordCount", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../utils/wordCount")>();
    countTextSpy.mockImplementation(actual.countText);
    return { ...actual, countText: countTextSpy };
});

import { reportWordCount, computeAndPost, resetWordCountReporter } from "../wordCountReporter";

const DEBOUNCE_MS = 250;
const IDLE_TIMEOUT_MS = 1000;

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        text: { group: "inline" },
    },
});

function makeState(text: string): EditorState {
    return EditorState.create({
        doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text(text)])]),
        schema,
    });
}

/** A view stub whose state can be swapped, like the live view's does. */
function makeView(state: EditorState): EditorView & { state: EditorState } {
    return { state } as EditorView & { state: EditorState };
}

/** Move the caret / select a range, producing a new state that reuses the SAME doc node. */
function withSelection(state: EditorState, from: number, to = from): EditorState {
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

/** The payload of every wordCount message posted to the extension so far. */
function posts(): { doc: unknown; selection: unknown }[] {
    return mockVscodeApi.postMessage.mock.calls
        .map(([msg]) => msg as { type: string; doc: unknown; selection: unknown })
        .filter((msg) => msg.type === "wordCount")
        .map(({ doc, selection }) => ({ doc, selection }));
}

/** Advance past the debounce and the setTimeout(0) idle fallback. */
function settle(): void {
    vi.advanceTimersByTime(DEBOUNCE_MS);
    vi.advanceTimersByTime(1);
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetWordCountReporter();
});

afterEach(() => {
    resetWordCountReporter();
    vi.useRealTimers();
});

describe("reportWordCount debounce", () => {
    it("a report that has not reached the debounce should post nothing", () => {
        const view = makeView(makeState("Hello world"));

        reportWordCount(view);
        vi.advanceTimersByTime(DEBOUNCE_MS - 1);

        expect(posts()).toHaveLength(0);
    });

    it("the debounce elapsing should post the counts once", () => {
        const view = makeView(makeState("Hello world"));

        reportWordCount(view);
        settle();

        expect(posts()).toEqual([
            { doc: { words: 2, characters: 10, readingTimeMinutes: 1 }, selection: null },
        ]);
    });

    it("a burst of reports should coalesce into a single post", () => {
        const view = makeView(makeState("Hello world"));

        for (let i = 0; i < 10; i++) {
            reportWordCount(view);
            vi.advanceTimersByTime(10);
        }
        settle();

        expect(posts()).toHaveLength(1);
    });

    it("reports separated by more than the debounce should each post", () => {
        const view = makeView(makeState("Hello world"));

        reportWordCount(view);
        settle();
        view.state = makeState("Hello brave new world");
        reportWordCount(view);
        settle();

        expect(posts()).toHaveLength(2);
    });
});

describe("document vs selection recompute", () => {
    it("a caret move within an unchanged document should not recount the document", () => {
        // Arrange: one settled report, so the document counts are cached.
        const state = makeState("Hello world");
        const view = makeView(state);
        reportWordCount(view);
        settle();
        expect(countTextSpy).toHaveBeenCalledTimes(1);
        countTextSpy.mockClear();

        // Act: move the caret only — same doc node, new selection.
        view.state = withSelection(state, 3);
        reportWordCount(view);
        settle();

        // Assert: the cached doc counts are reused and no counting happens at all.
        expect(countTextSpy).not.toHaveBeenCalled();
        expect(posts()).toHaveLength(2);
        expect(posts()[1]).toEqual({
            doc: { words: 2, characters: 10, readingTimeMinutes: 1 },
            selection: null,
        });
    });

    it("an edit producing a new document should recount the document", () => {
        const view = makeView(makeState("Hello world"));
        reportWordCount(view);
        settle();
        countTextSpy.mockClear();

        view.state = makeState("Hello brave new world");
        reportWordCount(view);
        settle();

        expect(countTextSpy).toHaveBeenCalledTimes(1);
        expect(countTextSpy).toHaveBeenCalledWith("Hello brave new world");
        expect(posts()[1].doc).toEqual({ words: 4, characters: 18, readingTimeMinutes: 1 });
    });

    it("a selection range should be counted while the document counts stay cached", () => {
        const state = makeState("Hello world");
        const view = makeView(state);
        reportWordCount(view);
        settle();
        countTextSpy.mockClear();

        // Select "Hello" (doc positions 1–6), leaving the doc node untouched.
        view.state = withSelection(state, 1, 6);
        reportWordCount(view);
        settle();

        // Only the selection range is counted — one call, on the selected text.
        expect(countTextSpy).toHaveBeenCalledTimes(1);
        expect(countTextSpy).toHaveBeenCalledWith("Hello");
        expect(posts()[1]).toEqual({
            doc: { words: 2, characters: 10, readingTimeMinutes: 1 },
            selection: { words: 1, characters: 5, readingTimeMinutes: 1 },
        });
    });

    it("an empty selection should report a null selection count", () => {
        const view = makeView(withSelection(makeState("Hello world"), 4));

        reportWordCount(view);
        settle();

        expect(posts()[0].selection).toBeNull();
    });

    it("returning to a previously counted document should still recount it", () => {
        // The cache holds only the last doc, so this documents that it is a
        // one-entry identity cache, not a memo table.
        const first = makeState("Hello world");
        const view = makeView(first);
        reportWordCount(view);
        settle();
        view.state = makeState("Something else entirely");
        reportWordCount(view);
        settle();
        countTextSpy.mockClear();

        view.state = first;
        reportWordCount(view);
        settle();

        expect(countTextSpy).toHaveBeenCalledTimes(1);
    });
});

describe("stale-view window", () => {
    it("a report should count the state present when it runs, not when it was scheduled", () => {
        const view = makeView(makeState("Hello world"));

        // Scheduled against the old state, but the document changes before the
        // debounce fires — the posted counts must describe the newer state.
        reportWordCount(view);
        vi.advanceTimersByTime(DEBOUNCE_MS - 1);
        view.state = makeState("Hello brave new world");
        settle();

        expect(posts()).toHaveLength(1);
        expect(posts()[0].doc).toEqual({ words: 4, characters: 18, readingTimeMinutes: 1 });
    });

    it("a superseded report should never post the intermediate counts", () => {
        const view = makeView(makeState("one"));

        reportWordCount(view);
        vi.advanceTimersByTime(100);
        view.state = makeState("one two");
        reportWordCount(view);
        vi.advanceTimersByTime(100);
        view.state = makeState("one two three");
        reportWordCount(view);
        settle();

        expect(posts()).toHaveLength(1);
        expect(posts()[0].doc).toEqual({ words: 3, characters: 11, readingTimeMinutes: 1 });
    });
});

describe("idle deferral", () => {
    let idleCallbacks: { cb: () => void; opts?: { timeout: number } }[];

    beforeEach(() => {
        idleCallbacks = [];
        (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = vi.fn(
            (cb: () => void, opts?: { timeout: number }) => {
                idleCallbacks.push({ cb, opts });
                return idleCallbacks.length;
            },
        );
        (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback = vi.fn();
    });

    afterEach(() => {
        delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
        delete (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback;
    });

    it("the debounce elapsing should arm an idle callback instead of counting inline", () => {
        const view = makeView(makeState("Hello world"));

        reportWordCount(view);
        vi.advanceTimersByTime(DEBOUNCE_MS);

        // The debounce timer must not do the O(doc) work itself.
        expect(idleCallbacks).toHaveLength(1);
        expect(countTextSpy).not.toHaveBeenCalled();
        expect(posts()).toHaveLength(0);
    });

    it("the idle callback running should post the counts", () => {
        const view = makeView(makeState("Hello world"));

        reportWordCount(view);
        vi.advanceTimersByTime(DEBOUNCE_MS);
        idleCallbacks[0].cb();

        expect(posts()).toEqual([
            { doc: { words: 2, characters: 10, readingTimeMinutes: 1 }, selection: null },
        ]);
    });

    it("the idle arm should carry a timeout so a busy main thread cannot starve it", () => {
        const view = makeView(makeState("Hello world"));

        reportWordCount(view);
        vi.advanceTimersByTime(DEBOUNCE_MS);

        expect(idleCallbacks[0].opts).toEqual({ timeout: IDLE_TIMEOUT_MS });
    });

    it("a new report before the idle callback runs should cancel the pending one", () => {
        const view = makeView(makeState("Hello world"));

        reportWordCount(view);
        vi.advanceTimersByTime(DEBOUNCE_MS);
        reportWordCount(view);

        expect(globalThis.cancelIdleCallback).toHaveBeenCalledTimes(1);
    });
});

describe("computeAndPost", () => {
    it("calling it directly should post counts without waiting for the debounce", () => {
        const view = makeView(makeState("Hello world"));

        computeAndPost(view);

        expect(posts()).toEqual([
            { doc: { words: 2, characters: 10, readingTimeMinutes: 1 }, selection: null },
        ]);
    });

    it("an empty document should post zero counts", () => {
        const view = makeView(
            EditorState.create({ doc: schema.node("doc", null, [schema.node("paragraph")]), schema }),
        );

        computeAndPost(view);

        expect(posts()[0].doc).toEqual({ words: 0, characters: 0, readingTimeMinutes: 0 });
    });
});
