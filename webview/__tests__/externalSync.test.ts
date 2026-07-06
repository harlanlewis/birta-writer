/**
 * Cursor-preserving inbound sync, exercised through PRODUCTION code with a REAL
 * Milkdown editor in jsdom (same harness as savePipeline.test.ts):
 *
 *   createEditor (full plugin stack)
 *     → user places a caret / selection
 *     → syncExternalContent(newMarkdown)  [editor.ts → externalSync.ts]
 *         → parserCtx parse → computeDocDiff → reverse tr.replace → dispatch
 *     → the selection survives an edit made ELSEWHERE, and no save echoes back.
 *
 * These are the guarantees that make externalUpdate better than a full rebuild
 * (revert): the caret is preserved and the extension isn't spammed with an
 * echo of the change it just pushed.
 *
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";

// The full production plugin stack observes layout; jsdom lacks ResizeObserver
// and (without pretendToBeVisual) rAF.
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
import { editorViewCtx, type Editor } from "@milkdown/core";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { createEditor, syncExternalContent } from "../editor";
import { applyExternalSync } from "../externalSync";
import { notifyUpdate } from "../messaging";

const INITIAL = ["First paragraph.", "", "Second paragraph.", ""].join("\n");

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

/** All "update" contents posted through the real messaging layer. */
function postedUpdates(): string[] {
    return mockVscodeApi.postMessage.mock.calls
        .map(([msg]) => msg as { type: string; content?: string })
        .filter((msg) => msg.type === "update")
        .map((msg) => msg.content!);
}

describe("webview external sync (cursor-preserving inbound diff)", () => {
    let editor: Editor;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, INITIAL, (md: string) => notifyUpdate(md));
        // Mark the pipeline as user-interacted so a genuine echo WOULD be sent —
        // this makes the "no echo" assertion meaningful.
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    it("an external edit in another block should apply while the caret stays put and no echo is posted", async () => {
        // Arrange — caret inside the FIRST paragraph (before the edited region)
        const v = view(editor);
        const caret = posAfterText(v, "First paragraph.") - 3; // inside "First paragraph."
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, caret)));
        mockVscodeApi.postMessage.mockClear();

        // Act — the extension pushes an edit to the SECOND paragraph only
        const next = ["First paragraph.", "", "Second paragraph EDITED.", ""].join("\n");
        const ok = syncExternalContent(next);
        await vi.advanceTimersByTimeAsync(600);

        // Assert — applied, caret unchanged, and nothing echoed back to save
        expect(ok).toBe(true);
        const after = view(editor);
        expect(after.state.doc.textContent).toContain("Second paragraph EDITED.");
        expect(after.state.selection.from).toBe(caret);
        expect(postedUpdates()).toEqual([]);
    });

    it("an edit overlapping the caret should clamp to a valid position without throwing", async () => {
        // Arrange — caret INSIDE the paragraph that will be replaced
        const v = view(editor);
        const caret = posAfterText(v, "Second paragraph.") - 2;
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, caret)));
        mockVscodeApi.postMessage.mockClear();

        // Act — replace the whole second paragraph
        const next = ["First paragraph.", "", "Totally different line.", ""].join("\n");
        const ok = syncExternalContent(next);
        await vi.advanceTimersByTimeAsync(600);

        // Assert — applied, selection clamped within bounds, no throw, no echo
        expect(ok).toBe(true);
        const after = view(editor);
        expect(after.state.doc.textContent).toContain("Totally different line.");
        expect(after.state.selection.from).toBeGreaterThanOrEqual(0);
        expect(after.state.selection.from).toBeLessThanOrEqual(after.state.doc.content.size);
        expect(postedUpdates()).toEqual([]);
    });

    it("a diff failure should return false so the caller can fall back to a full rebuild", () => {
        // Arrange — an editor whose action throws stands in for any parse /
        // computeDocDiff / dispatch failure inside applyExternalSync.
        const throwingEditor = {
            action: () => {
                throw new Error("boom");
            },
        } as unknown as Editor;

        // Act
        const ok = applyExternalSync(throwingEditor, "whatever\n");

        // Assert — swallowed, reported as failure (caller rebuilds)
        expect(ok).toBe(false);
    });
});
