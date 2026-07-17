/**
 * createEditor lifecycle robustness (MAR-148), against the REAL production
 * editor stack:
 *
 *   • Re-init must not accumulate composition listeners on the stable
 *     container — one composition event runs exactly one handler pair, no
 *     matter how many revert/init/externalUpdate rebuilds preceded it.
 *   • A FAILED createEditor must leave the sync pipeline provably inert:
 *     view access answers null (not a throw on the destroyed predecessor),
 *     external sync asks for a rebuild, and — the data path that matters —
 *     a save flush answers with the NEW document's bytes, never the previous
 *     document's (which would let a Cmd+S after a failed re-init write stale
 *     content back over the file).
 *
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Building the full Milkdown stack is real work — same budget rationale as
// savePipeline.test.ts (one-time proofread wordlist compile can land here).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Controls the mocked grammar loader below: when `fail` is set, a document
// containing a code fence makes createEditor reject partway through — the
// failure mode the inert-pipeline contract is about.
const grammarGate = vi.hoisted(() => ({ fail: false }));
vi.mock("../highlighter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../highlighter")>();
    return {
        ...actual,
        ensureGrammars: async () => {
            if (grammarGate.fail) {
                throw new Error("grammar chunk failed to load");
            }
            return actual.ensureGrammars();
        },
    };
});

// The full production plugin stack observes layout; jsdom has no
// ResizeObserver and (without pretendToBeVisual) no rAF.
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

import {
    createEditor,
    getEditorView,
    flushPendingEdit,
    syncExternalContent,
} from "../editor";

describe("createEditor lifecycle robustness (MAR-148)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        grammarGate.fail = false;
        document.body.innerHTML = "";
    });

    it("after a re-init a composition event should run exactly one listener pair, not one per rebuild", async () => {
        // Arrange — count invocations of the composition handlers editor.ts
        // binds on the container, by wrapping them at registration time.
        const container = document.createElement("div");
        document.body.appendChild(container);
        const fired = { compositionstart: 0, compositionend: 0 };
        const origAdd = container.addEventListener.bind(container);
        vi.spyOn(container, "addEventListener").mockImplementation(
            (type: string, listener, options) => {
                let handler = listener;
                if (
                    (type === "compositionstart" || type === "compositionend") &&
                    typeof listener === "function"
                ) {
                    handler = (ev: Event) => {
                        fired[type]++;
                        listener(ev);
                    };
                }
                origAdd(type, handler as EventListener, options as AddEventListenerOptions);
            },
        );

        // Act — two init cycles, exactly as initEditor performs them (destroy,
        // clear children, recreate on the SAME container), then one composition.
        const first = await createEditor(container, "hello\n", vi.fn());
        await first.destroy();
        container.innerHTML = "";
        const second = await createEditor(container, "hello\n", vi.fn());

        container.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        container.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

        // Assert — the first instance's pair is dead; only the live pair fires.
        expect(fired.compositionstart).toBe(1);
        expect(fired.compositionend).toBe(1);
        await second.destroy();
    });

    it("a failed createEditor should leave an inert pipeline whose save flush returns the NEW document's bytes", async () => {
        // Arrange — a healthy editor over the previous document...
        const container = document.createElement("div");
        document.body.appendChild(container);
        const editor = await createEditor(container, "old content\n", vi.fn());

        // Act — ...then a re-init (destroy, clear, recreate: the revert path)
        // onto fenced content whose grammar load rejects mid-createEditor.
        await editor.destroy();
        container.innerHTML = "";
        grammarGate.fail = true;
        const FENCED = "```js\nconst x = 1;\n```\n";
        await expect(createEditor(container, FENCED, vi.fn())).rejects.toThrow(
            "grammar chunk failed to load",
        );

        // Assert — inert, not wedged on the destroyed predecessor: view access
        // answers null instead of throwing on a torn-down editor...
        expect(getEditorView()).toBeNull();
        // ...an inbound external change reports "rebuild me" (the fallback the
        // externalUpdate handler is built around)...
        expect(syncExternalContent("anything\n")).toBe(false);
        // ...and the save flush answers with the document the extension just
        // sent — NOT "old content\n", which a Cmd+S would write back over the
        // file as a stale save.
        expect(flushPendingEdit()).toBe(FENCED);

        // The failed create's own listener pair is the one window the abort
        // deliberately leaves open (it dies on the NEXT init) — prove it is
        // harmless: a composition event against the dead editor must not wedge
        // the pipeline or change what a flush returns.
        container.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        container.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        expect(flushPendingEdit()).toBe(FENCED);

        // A later successful init recovers the pipeline completely.
        grammarGate.fail = false;
        const recovered = await createEditor(container, "recovered\n", vi.fn());
        expect(getEditorView()).not.toBeNull();
        expect(flushPendingEdit()).toBe("recovered\n");
        await recovered.destroy();
    });
});
