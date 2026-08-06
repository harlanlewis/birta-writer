/**
 * Proofread rescan User-Timing measures (MAR-314 part 2).
 *
 * The FIRST completed proofread scan stamps the launch-time `mdw:proofread`
 * measure (MAR-311). Every LATER scan — the 350 ms-debounced whole-document
 * rescan behind typing — must stamp `mdw:proofread-rescan` instead, so the
 * typing harness (e2e/perf-typing.mjs) can attribute rescan cost per burst.
 * Before this change the rescan path stamped nothing: `mdw:proofread` appeared
 * exactly once per page load and the rescan's cost was visible only through the
 * never-gated `block` longtask sum.
 *
 * These tests drive the real createEditor stack and observe `performance.measure`
 * through a spy installed AFTER vi.useFakeTimers(): fake timers replace the
 * `performance` object (AGENTS.md → Mock rules), and jsdom's own User Timing
 * surface is not guaranteed either way, so the spy is both the observation
 * point and the API's existence guarantee.
 *
 * acquireVsCodeApi is injected globally by setup.ts. jsdom has no
 * requestIdleCallback, so the plugin's idle arm falls back to setTimeout, which
 * fake timers advance.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { editorViewCtx, type Editor } from "@milkdown/core";
import type { EditorView } from "../pm";
import { createEditor } from "../editor";

// Building the full Milkdown stack per test plus the one-time deferred-pass
// charge needs headroom over the 5 s default under full-suite load — same
// budget rationale as proofreadDeferred.test.ts.
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

// "actually" gives the style scan a real hit; the content is otherwise inert.
const DOC = "# Notes\n\nThis is actually a plain paragraph.\n";

/** Replace performance.measure with a spy and return it (see file header). */
function installMeasureSpy(): ReturnType<typeof vi.fn> {
    const spy = vi.fn();
    (performance as unknown as { measure: unknown }).measure = spy;
    return spy;
}

/** The measure names the spy has recorded, in call order. */
function measuredNames(spy: ReturnType<typeof vi.fn>): string[] {
    return spy.mock.calls.map(([name]) => name as string);
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

describe("proofread rescans stamp their own User-Timing measure", () => {
    let editor: Editor;
    let spy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        vi.useFakeTimers();
        spy = installMeasureSpy();
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, DOC, vi.fn());
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    it("the first idle pass should stamp mdw:proofread once and no rescan measure", async () => {
        // Act — let the idle arm and the scan run, with no interaction
        await vi.advanceTimersByTimeAsync(2000);

        // Assert — launch attribution only: the first pass is `proofread`, and
        // the rescan span must not dilute it
        const names = measuredNames(spy);
        expect(names.filter((n) => n === "mdw:proofread")).toHaveLength(1);
        expect(names).not.toContain("mdw:proofread-rescan");
    });

    it("each debounced rescan after the first pass should stamp one mdw:proofread-rescan", async () => {
        // Arrange — first pass completed, counters cleared
        await vi.advanceTimersByTimeAsync(2000);
        spy.mockClear();

        // Act — a doc-changing edit, then the 350 ms debounce elapses
        const v = view(editor);
        v.dispatch(v.state.tr.insertText("x", 1));
        await vi.advanceTimersByTimeAsync(2000);

        // Assert — the rescan is measured, and the launch measure stays one-shot
        let names = measuredNames(spy);
        expect(names.filter((n) => n === "mdw:proofread-rescan")).toHaveLength(1);
        expect(names).not.toContain("mdw:proofread");

        // Act again — a second edit produces a second rescan measure (per scan,
        // not one-shot)
        v.dispatch(v.state.tr.insertText("y", 1));
        await vi.advanceTimersByTimeAsync(2000);

        // Assert
        names = measuredNames(spy);
        expect(names.filter((n) => n === "mdw:proofread-rescan")).toHaveLength(2);
    });
});
