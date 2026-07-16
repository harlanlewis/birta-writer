/**
 * The proofread pass is deferred off the mount/paint path and run on idle after
 * the editor is visible: it must not run synchronously during create (it would
 * block the paint), it settles in on its own without needing a user interaction,
 * and — crucially — it does nothing at all when every check is disabled (no scan,
 * no `lintBlocks`, so Harper's ~18 MB WASM never loads). These tests drive the
 * real createEditor and assert on the messages that cross to the extension.
 *
 * acquireVsCodeApi is injected globally by setup.ts. jsdom has no
 * requestIdleCallback, so the plugin's idle arm falls back to setTimeout(0),
 * which fake timers advance.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";

// The scan this file exists to test IS the one-time ~2s cost (compiling the
// style wordlists into matchers): ~1.9s measured idle for the test that lets the
// pass actually run, which flaked under full-suite load against the 5s default.
// See the longer note in savePipeline.test.ts. Scoped per-file so ordinary
// webview tests keep the tight 5s default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

import { type Editor } from "@milkdown/core";
import { createEditor } from "../editor";

const DOC = "# Notes\n\nThis sentence has a mispeling to lint.\n";

/** Count of `lintBlocks` messages posted through the real messaging layer. */
function lintBlockPosts(): number {
    return mockVscodeApi.postMessage.mock.calls
        .map(([msg]) => msg as { type: string })
        .filter((msg) => msg.type === "lintBlocks").length;
}

describe("proofread pass is deferred to idle after paint", () => {
    let editor: Editor;

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    afterEach(async () => {
        vi.useRealTimers();
        delete window.__i18n;
        await editor.destroy();
    });

    it("should not run synchronously during create (nothing posted before idle)", async () => {
        // Arrange — fake timers BEFORE create so the idle arm is on the fake clock
        vi.useFakeTimers();
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, DOC, vi.fn());

        // Act — flush microtasks only; the idle arm (a macrotask) has not fired
        await Promise.resolve();

        // Assert — the scan never runs on the paint-critical path
        expect(lintBlockPosts()).toBe(0);
    });

    it("should run proactively on idle with no user interaction", async () => {
        // Arrange
        vi.useFakeTimers();
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, DOC, vi.fn());

        // Act — let the idle arm + scan debounce elapse; NO interaction
        await vi.advanceTimersByTimeAsync(2000);

        // Assert — annotations settle in on their own
        expect(lintBlockPosts()).toBeGreaterThan(0);
    });

    it("with every check disabled should never scan or load the grammar engine", async () => {
        // Arrange — a config with style, spell, and grammar all off
        window.__i18n = {
            translations: {},
            proofread: { styleCheck: false, spellCheck: false, grammarCheck: false },
        } as unknown as typeof window.__i18n;
        vi.useFakeTimers();
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, DOC, vi.fn());

        // Act — well past idle + debounce, and even after a real interaction
        await vi.advanceTimersByTimeAsync(2000);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
        await vi.advanceTimersByTimeAsync(2000);

        // Assert — a fully-disabled feature costs nothing: no lintBlocks ⇒ no Harper
        expect(lintBlockPosts()).toBe(0);
    });
});
