/**
 * Full webview save-pipeline test, end to end through PRODUCTION code only:
 *
 *   createEditor (webview/editor.ts, the full production plugin stack)
 *     → user edit (view.dispatch)
 *     → milkdown listener markdownUpdated (lodash debounce, 200ms)
 *     → applyMinimalChanges against the saved baseline, with round-trip
 *       protection computed from the loaded file
 *     → editor.ts's own 300ms debounce → onUpdate
 *     → notifyUpdate → postMessage bytes to the Extension.
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
import { editorViewCtx, type Editor } from "@milkdown/core";
import type { EditorView } from "@milkdown/prose/view";
import { createEditor } from "../editor";
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

/** All update-message contents posted through the real messaging layer. */
function postedUpdates(): string[] {
    return mockVscodeApi.postMessage.mock.calls
        .map(([msg]) => msg as { type: string; content?: string })
        .filter((msg) => msg.type === "update")
        .map((msg) => msg.content!);
}

describe("webview save pipeline (edit → markdownUpdated → minimal diff → bytes)", () => {
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
});
