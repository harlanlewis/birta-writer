/**
 * Proofreading is deferred off the read-only open path: opening a file to read
 * it must not run the first proofread scan, because a grammar/spell scan posts
 * `lintBlocks` to the extension, which loads Harper's ~18 MB WASM (~380 ms +
 * ~300 MB). The scan is armed on the first user interaction instead. These tests
 * drive the real createEditor (full plugin stack) and assert on the messages
 * that actually cross to the extension via the production messaging layer.
 *
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";

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

describe("proofread scan is deferred until first interaction", () => {
    let editor: Editor;

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    it("opening a file to read it (no interaction) should post no lintBlocks", async () => {
        // Arrange — a fresh editor, NO simulated interaction
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, DOC, vi.fn());
        vi.useFakeTimers();

        // Act — let well past the scan debounce elapse
        await vi.advanceTimersByTimeAsync(2000);

        // Assert — the grammar/spell engine is never triggered on a read-only open
        expect(lintBlockPosts()).toBe(0);
    });

    it("the first user interaction should arm the scan and post lintBlocks", async () => {
        // Arrange
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, DOC, vi.fn());
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(2000);
        expect(lintBlockPosts()).toBe(0); // still nothing before interaction

        // Act — a real interaction (capture-phase document keydown) arms the scan
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
        await vi.advanceTimersByTimeAsync(2000);

        // Assert — proofreading runs normally once the user engages
        expect(lintBlockPosts()).toBeGreaterThan(0);
    });
});
