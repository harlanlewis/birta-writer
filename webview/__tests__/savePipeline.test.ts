/**
 * Full webview save-pipeline test, end to end through PRODUCTION code only:
 *
 *   createEditor (webview/editor.ts, the full production plugin stack)
 *     → user edit (view.dispatch)
 *     → docChangePlugin reports the change synchronously
 *     → syncScheduler (leading edge → trailing debounce → max-wait)
 *     → applyMinimalChanges against the saved baseline, with round-trip
 *       protection computed from the loaded file
 *     → onUpdate → notifyUpdate → postMessage bytes to the Extension.
 *
 * This is the seam that decides WHAT BYTES land in the user's file, so the
 * assertions are on exact file bytes: an edit must change only its own
 * region, and constructs the parse→serialize round trip cannot reproduce
 * (setext headings, reference links + definitions) must survive verbatim.
 *
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";

// Vitest's 5s default testTimeout is not a fit for a suite that drives the REAL
// production editor. Building the full Milkdown stack is cheap (~90ms/editor);
// the cost is a ONE-TIME ~2s charge that lands on whichever test first advances
// timers far enough to trigger the deferred proofread pass (compiling the style
// wordlists into matchers, plus V8 warmup). It is cached process-wide after
// that, which is why only the FIRST test in this file was ever slow (~2.9s
// measured idle, vs ~15-110ms for every later test).
//
// At 2.9s of a 5s budget there was under 2x headroom, so under full-suite load
// (180 files across parallel workers) this file's first test intermittently blew
// past 5s — a flake in the suite guarding the data-loss path, which trains the
// reader to re-run instead of read. The cost is real, one-time, and inherent to
// exercising the production stack: it cannot be refactored away, only paid
// somewhere. So budget for it honestly rather than trim the stack — dropping
// plugins here to save time would forfeit exactly the production fidelity this
// file exists to assert. Scoped per-file (not project-wide) so a genuine hang in
// an ordinary webview test still trips the 5s default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The full production plugin stack (headingSticky, ...) observes layout;
// jsdom has no ResizeObserver and (without pretendToBeVisual) no rAF.
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
import { editorViewCtx, serializerCtx, type Editor } from "@milkdown/core";
import type { EditorView } from "../pm";
import type { Node as ProseNode } from "../pm";
import { createEditor, syncExternalContent } from "../editor";
import { notifyUpdate } from "../messaging";

/** A file full of constructs a zero-edit round trip would destroy. */
const INITIAL = [
    "Title",
    "=====",
    "",
    "See [ref][1] for details.",
    "",
    "Some paragraph.",
    "",
    "[1]: https://example.com/",
    "",
].join("\n");

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Doc position right after the first text node equal to `text`. */
function posAfterText(v: EditorView, text: string): number {
    let found = -1;
    v.state.doc.descendants((node, pos) => {
        if (found >= 0) return false;
        if (node.isText && node.text === text) {
            found = pos + text.length;
            return false;
        }
        return true;
    });
    if (found < 0) throw new Error(`text not found in doc: ${text}`);
    return found;
}

/**
 * Count whole-doc serializations by wrapping the live serializerCtx. syncNow()
 * reads the serializer at call time (via getMarkdown()), so this sees every
 * sync the pipeline performs. Serialization is the O(document) cost the save
 * path is built to ration — it is the observable that distinguishes "no sync
 * was requested" from "a sync ran and its diff came out empty".
 */
function countSerializations(ed: Editor): () => number {
    let calls = 0;
    ed.action((ctx) => {
        const orig = ctx.get(serializerCtx);
        ctx.set(serializerCtx, ((doc: ProseNode) => {
            calls++;
            return orig(doc);
        }) as ReturnType<typeof ctx.get<typeof serializerCtx>>);
    });
    return () => calls;
}

/**
 * Fake timers WITH `performance` on the same fake timeline, plus the clock wound
 * past the scheduler's idle window.
 *
 * syncScheduler SLEEPS via setTimeout but READS time via performance.now(), and
 * Vitest's default useFakeTimers() fakes the timers and Date but NOT
 * performance. That leaves a fake timer queue driven by a real clock: advancing
 * fake time by 2s moves performance.now() by ~0. Every scheduler window is a
 * `now() - mark` comparison, so under the default those windows can only elapse
 * via real wall-clock time that incidentally passes while the test runs — making
 * any multi-window assertion a race against machine speed. (Measured: a max-wait
 * assertion passed alone on a cold, slow serializer and failed in-file on a warm
 * one — same code, opposite results.) Only tests that need a scheduler WINDOW to
 * elapse need this; the rest are fine on the default, where a large real
 * performance.now() faithfully models a webview that has been alive a while.
 *
 * The wind-forward is load-bearing. Faked performance.now() always starts at 0
 * (sinon measures it from clock start; the `now` option shifts only Date), and
 * reset() parks lastSyncMs at 0 to mean "long ago" — so at t=0 the leading-edge
 * test `now - lastSyncMs >= idleMs` reads `0 - 0 >= 300` and is FALSE. That is
 * an artifact of a clock booted at zero, not a product bug: in a real webview
 * performance.now() is far past idleMs by the time a user can type. Winding past
 * idleMs restores the production posture. mark/measure survive the fake, so
 * webview/perf.ts still works.
 */
async function useFakeClockPastIdle(): Promise<void> {
    // Uninstall beforeEach's clock FIRST. Calling useFakeTimers() while fake
    // timers are already installed does not re-apply `toFake`, so `performance`
    // would silently stay real — which is precisely the failure this helper
    // exists to prevent, and it fails in the direction that looks like a pass
    // (the first test in a file is slow enough for the real clock to cross the
    // max-wait on its own).
    vi.useRealTimers();
    vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    });
    await vi.advanceTimersByTimeAsync(400); // > idleMs (300); no doc change yet, so nothing syncs
}

/** All update-message contents posted through the real messaging layer. */
function postedUpdates(): string[] {
    return mockVscodeApi.postMessage.mock.calls
        .map(([msg]) => msg as { type: string; content?: string })
        .filter((msg) => msg.type === "update")
        .map((msg) => msg.content!);
}

describe("webview save pipeline (edit → doc change → minimal diff → bytes)", () => {
    let editor: Editor;
    let onUpdate: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        const container = document.createElement("div");
        document.body.appendChild(container);
        // The production wiring (webview/index.ts) forwards onUpdate to
        // notifyUpdate; the fn wrapper additionally records the raw calls.
        onUpdate = vi.fn((md: string) => notifyUpdate(md));
        editor = await createEditor(container, INITIAL, onUpdate);
        // Editors mark _hasUserInteracted on real input events; simulate one
        // so the pipeline treats subsequent transactions as user edits.
        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "x", bubbles: true }),
        );
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    it("an edit should reach postMessage as the ORIGINAL file with only the edited region changed", async () => {
        // Arrange
        const v = view(editor);

        // Act — append to "Some paragraph." and let both debounces elapse
        v.dispatch(
            v.state.tr.insertText(" edited", posAfterText(v, "Some paragraph.")),
        );
        await vi.advanceTimersByTimeAsync(600);

        // Assert — exact bytes: the setext heading was NOT rewritten to ATX,
        // the reference link and its definition survived verbatim, and only
        // the edited paragraph changed.
        expect(onUpdate).toHaveBeenCalledTimes(1);
        const saved = postedUpdates();
        expect(saved).toHaveLength(1);
        expect(saved[0]).toBe(
            INITIAL.replace("Some paragraph.", "Some paragraph. edited"),
        );
    });

    it("a second edit should diff against the previous save, keeping protection intact", async () => {
        // Arrange — first edit saved
        const v = view(editor);
        v.dispatch(
            v.state.tr.insertText(" one", posAfterText(v, "Some paragraph.")),
        );
        await vi.advanceTimersByTimeAsync(600);

        // Act — second edit on the same baseline
        v.dispatch(v.state.tr.insertText(" two", posAfterText(v, "Some paragraph. one")));
        await vi.advanceTimersByTimeAsync(600);

        // Assert — cumulative content, still byte-identical elsewhere
        const saved = postedUpdates();
        expect(saved).toHaveLength(2);
        expect(saved[1]).toBe(
            INITIAL.replace("Some paragraph.", "Some paragraph. one two"),
        );
    });

    it("deferred round-trip protection still pins protected regions when the first edit beats the idle precompute", async () => {
        // Round-trip protection is computed LAZILY from a snapshot of the
        // pristine document (deferred off the launch path). This guards that an
        // edit which lands before the idle precompute still forces the
        // computation from the pristine snapshot: the setext heading must not be
        // rewritten to ATX and the reference-link definition ([1]: …) — which a
        // zero-edit round trip would otherwise drop — must survive verbatim,
        // proving protection was derived from the loaded file, not the post-edit
        // doc.
        const v = view(editor);
        v.dispatch(
            v.state.tr.insertText(" later", posAfterText(v, "Some paragraph.")),
        );
        await vi.advanceTimersByTimeAsync(600);

        const saved = postedUpdates();
        expect(saved).toHaveLength(1);
        // Full-file equality: only the edited paragraph changed; the setext
        // "=====" underline and the "[1]: https://example.com/" definition are
        // byte-identical.
        expect(saved[0]).toBe(
            INITIAL.replace("Some paragraph.", "Some paragraph. later"),
        );
        expect(saved[0]).toContain("=====");
        expect(saved[0]).toContain("[1]: https://example.com/");
    });

    it("the first edit after a lull should dirty the document within a frame, not a debounce", async () => {
        // AGENTS.md sync invariant #2: the first edit after a save must be
        // save-capturable "the moment the user perceives it" —
        // onWillSaveTextDocument only fires for a DIRTY document, so an edit
        // that takes ~200ms to reach the extension is an edit a fast Cmd+S
        // silently doesn't write. Regression pin for MAR-145: the trigger used
        // to ride @milkdown/plugin-listener's `updated`, whose unconditional
        // lodash debounce(fn, 200) sat UPSTREAM of syncScheduler and defeated
        // its leading edge. The scheduler arms the leading edge at delay 0
        // (async, so the keypress itself stays free), hence one timer tick.
        const v = view(editor);

        v.dispatch(v.state.tr.insertText(" now", posAfterText(v, "Some paragraph.")));
        await vi.advanceTimersByTimeAsync(1);

        expect(postedUpdates()).toEqual([
            INITIAL.replace("Some paragraph.", "Some paragraph. now"),
        ]);
    });

    it("continuous typing with no pause should keep syncing via the max-wait cap", async () => {
        // AGENTS.md sync invariant #3, at the WIRING level: docChangePlugin must
        // report EVERY doc-changing transaction, not just the first of a burst.
        // The tests around this one pin only the 1st transaction, and
        // syncScheduler.test.ts pins the max-wait POLICY against a hand-driven
        // scheduler — so a regression that stops the 2nd..Nth transaction from
        // reaching request() (exactly MAR-145: a trailing debounce upstream,
        // which resets on every keystroke and therefore never fires during
        // continuous typing) leaves the scheduler never asked, its max-wait never
        // engaged, and the document clean for the whole burst. Cmd+S mid-burst is
        // then a no-op and hot exit backs up stale bytes. That was pinned only by
        // e2e/syncLatency, which is deliberately NOT a CI job — so this hole was
        // CI-invisible.
        //
        // This is the one test here that needs a scheduler WINDOW (the 2000ms
        // max-wait) to actually elapse, so it drives the scheduler's own clock
        // rather than racing the host's — see useFakeClockPastIdle.
        await useFakeClockPastIdle();
        const v = view(editor);
        const pos = posAfterText(v, "Some paragraph.");

        // Act — type every 100ms for 2.5s, never pausing for the 300ms idle
        // window, so ONLY the 2000ms max-wait cap can produce a second sync.
        for (let i = 0; i < 25; i++) {
            v.dispatch(v.state.tr.insertText("a", pos));
            await vi.advanceTimersByTimeAsync(100);
        }

        // Assert — the leading edge, plus at least one max-wait sync WHILE still
        // typing. This count is taken before any pause, so it cannot be
        // satisfied by a trailing sync: a doc-change trigger that fires once per
        // burst yields exactly 1 here, leaving the document stale for 2.5s.
        expect(postedUpdates().length).toBeGreaterThanOrEqual(2);

        // And once typing stops the bytes still land correctly: all 25 chars, with
        // the protected regions (setext underline, reference definition) intact.
        await vi.advanceTimersByTimeAsync(600);
        const updates = postedUpdates();
        expect(updates[updates.length - 1]).toBe(
            INITIAL.replace("Some paragraph.", `Some paragraph.${"a".repeat(25)}`),
        );
    });

    it("an inbound external change should not even REQUEST a sync, let alone echo one", async () => {
        // The content came FROM the file, so a save would be a pointless write.
        // plugin-listener used to skip these for free by ignoring
        // `addToHistory: false`; docChangePlugin reports every doc change, so
        // editor.ts suppresses the request explicitly (_applyingExternal — the
        // span-scoped mechanism MAR-152 settled on after the per-transaction
        // meta capture failed THIS test on a reentrant plugin fix-up). This
        // test also pins the flag's synchronous-dispatch assumption: an async
        // sync path would un-suppress the echo and fail here.
        //
        // Asserting only on posted bytes would pin NOTHING: _applyExternalNow
        // re-baselines _savedMarkdown before the scheduler's (async) leading
        // edge fires, so syncNow()'s `toSave === _savedMarkdown` early-return
        // swallows the echo even with the guard deleted — verified. The guard's
        // real contract is that no sync is requested at all, whose observable is
        // the O(document) serialize that never happens.
        const serializations = countSerializations(editor);

        // Synchronous: dispatches, re-baselines, and recomputes protection
        // (which serializes once). Anything after it is the pipeline reacting.
        expect(syncExternalContent("Title\n=====\n\nExternally rewritten.\n")).toBe(true);
        const afterApply = serializations();
        await vi.advanceTimersByTimeAsync(1000);

        expect(serializations() - afterApply).toBe(0);
        expect(postedUpdates()).toEqual([]);
    });

    it("before any user interaction the pipeline must not post an update", async () => {
        // Arrange — a fresh editor with NO simulated interaction
        await editor.destroy();
        vi.useRealTimers();
        const container = document.createElement("div");
        document.body.appendChild(container);
        const silentUpdate = vi.fn();
        editor = await createEditor(container, "hello\n", silentUpdate);
        vi.useFakeTimers();

        // Act — a programmatic transaction (e.g. some plugin normalization)
        const v = view(editor);
        v.dispatch(v.state.tr.insertText("!", 6));
        await vi.advanceTimersByTimeAsync(1000);

        // Assert — opening a file must never trigger a silent save
        expect(silentUpdate).not.toHaveBeenCalled();
    });

    // _hasUserInteracted is the SOLE gate between a doc change and a dirty
    // TextDocument: while it is down no sync is requested, the document stays
    // clean, onWillSaveTextDocument never fires, and Cmd+S silently writes
    // nothing. So every channel that can enter text WITHOUT a keydown is a
    // data-loss path, not a cosmetic gap. An IME (pinyin/kana) announces itself
    // with `compositionstart`; dictation and soft keyboards go through
    // `beforeinput`. Neither is guaranteed to emit a keydown first. In practice
    // a click focuses the editor before either can happen, which is why this is
    // latent rather than live — these pin it shut.
    //
    // Both events are dispatched on the CONTAINER, not on `document`, because
    // that is where a real one originates (on the contenteditable, bubbling
    // out). It matters: editor.ts has a SECOND compositionstart listener on the
    // container that sets _isComposing, and an event dispatched directly on
    // `document` never reaches it — so a document-dispatched compositionstart
    // would exercise the interaction gate while silently skipping composition
    // itself, testing a state no real IME can produce.
    it("an edit composed through an IME should reach postMessage when the candidate commits", async () => {
        // Arrange — a fresh editor that has NEVER seen a keydown/mousedown
        await editor.destroy();
        vi.useRealTimers();
        const container = document.createElement("div");
        document.body.appendChild(container);
        const update = vi.fn();
        editor = await createEditor(container, "hello\n", update);
        vi.useFakeTimers();

        // Act — composition starts (lifting the interaction gate AND raising
        // _isComposing), and the candidate lands in the doc mid-composition.
        container.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        const v = view(editor);
        v.dispatch(v.state.tr.insertText("!", 6));
        await vi.advanceTimersByTimeAsync(600);

        // Assert — a half-formed candidate is never serialized to the file...
        expect(update).not.toHaveBeenCalled();

        // ...but committing it ships the edit (scheduler.compositionEnded).
        container.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(600);
        expect(update).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith("hello!\n");
    });

    it("an edit whose first interaction is beforeinput should still reach postMessage", async () => {
        // Arrange — a fresh editor that has NEVER seen a keydown/mousedown
        await editor.destroy();
        vi.useRealTimers();
        const container = document.createElement("div");
        document.body.appendChild(container);
        const update = vi.fn();
        editor = await createEditor(container, "hello\n", update);
        vi.useFakeTimers();

        // Act — dictation/soft keyboard: beforeinput precedes the mutation, with
        // no keydown anywhere in the sequence.
        container.dispatchEvent(new InputEvent("beforeinput", { bubbles: true }));
        const v = view(editor);
        v.dispatch(v.state.tr.insertText("!", 6));
        await vi.advanceTimersByTimeAsync(600);

        // Assert — the edit is save-capturable (invariant #2)
        expect(update).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith("hello!\n");
    });
});
