/**
 * The proofread pass is deferred off the mount/paint path and run on idle after
 * the editor is visible: it must not run synchronously during create (it would
 * block the paint), it settles in on its own without needing a user interaction,
 * and — crucially — it does nothing at all when a check is disabled. "Nothing"
 * has two halves, and they fail independently: no `lintBlocks`, so Harper's
 * ~18 MB WASM never loads, and no phrase-regex compile, which is the
 * document-size-independent floor of the first pass (MAR-315; the measurements
 * live on MAX_ALTERNATIVES_PER_REGEX in styleMatcher.ts and are deliberately
 * not copied here). These tests drive the real createEditor and assert on the
 * messages that cross to the extension, plus a pass-through spy on the compile.
 *
 * acquireVsCodeApi is injected globally by setup.ts. jsdom has no
 * requestIdleCallback, so the plugin's idle arm falls back to setTimeout(0),
 * which fake timers advance.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";

// Each test loads the editor's module graph from a fresh registry (see
// freshCreateEditor below), so the first one pays that load inside the test
// rather than in `collect`: measured 1.5 s, the rest 60-180 ms. That is 3x
// headroom against the 5 s default, which is thin under full-suite load, so the
// file keeps a per-file override. The cost is the module-graph load, not the
// wordlist compile — do not re-attribute it without re-measuring.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

// A pass-through spy on the one call whose cost the disabled-state tests below
// are about. Compiling the phrase lists into alternation regexes is the
// document-size-independent floor of the first pass — V8 compiles each
// alternation lazily on `exec`, and the bill is the same whatever document is
// open (MAR-315). "A disabled feature costs nothing" is therefore only true if
// this is never reached. `vi.hoisted` is required: `vi.mock` is hoisted above
// every import, and the factory runs while the import graph is still loading, so
// a plain `const` would still be in its temporal dead zone.
//
// Which line each `compileCalls === 0` assertion pins, verified by reverting it:
// the "only the style check off" case is pinned uniquely by the
// `!config.styleCheck` clause in `computeDecorations` (deleting it fails that
// test and no other). The master-off and every-check-off cases are pinned by the
// CONJUNCTION of that clause and the `anyProofreadEnabled` guard on the idle arm
// — either alone still catches them, so both must be removed to fail them. That
// redundancy is deliberate defense in depth; do not "simplify" one away on the
// strength of a green suite.
const spy = vi.hoisted(() => ({ compileCalls: 0 }));
vi.mock("../utils/styleMatcher", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../utils/styleMatcher")>();
    return {
        ...actual,
        compileStyleMatcher: (...args: Parameters<typeof actual.compileStyleMatcher>) => {
            spy.compileCalls++;
            return actual.compileStyleMatcher(...args);
        },
    };
});

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

import type { Editor } from "@milkdown/core";

const DOC = "# Notes\n\nThis sentence has a mispeling to lint.\n";

/**
 * A fresh module registry per test, then the real editor factory out of it.
 *
 * `vi.resetModules()` is load-bearing, not hygiene: the proofread plugin caches
 * the compiled matcher in a module-level `cachedMatcher`, keyed by the per-check
 * enabled map and the exceptions — and NOT by `styleCheck`, which gates earlier.
 * A statically imported `createEditor` therefore shares that cache across tests,
 * and the "style check off" case below silently passed on a matcher an earlier
 * test had already compiled, still passing when its gate was deleted. Resetting
 * models what the assertion is actually about: a freshly opened webview.
 */
async function freshCreateEditor(): Promise<typeof import("../editor").createEditor> {
    vi.resetModules();
    return (await import("../editor")).createEditor;
}

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
        spy.compileCalls = 0;
        document.body.innerHTML = "";
    });

    afterEach(async () => {
        vi.useRealTimers();
        delete window.__i18n;
        await editor.destroy();
    });

    it("should not run synchronously during create (nothing posted before idle)", async () => {
        // Arrange — fake timers BEFORE create so the idle arm is on the fake clock
        const createEditor = await freshCreateEditor();
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
        const createEditor = await freshCreateEditor();
        vi.useFakeTimers();
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, DOC, vi.fn());

        // Act — let the idle arm + scan debounce elapse; NO interaction
        await vi.advanceTimersByTimeAsync(2000);

        // Assert — annotations settle in on their own
        expect(lintBlockPosts()).toBeGreaterThan(0);
        // Positive control for the three `compileCalls === 0` assertions below:
        // with the default config the compile DOES happen, so a zero there is
        // the gate holding and not the spy silently failing to apply.
        expect(spy.compileCalls).toBeGreaterThan(0);
    });

    it("with every check disabled should never scan or load the grammar engine", async () => {
        // Arrange — a config with style, spell, and grammar all off
        window.__i18n = {
            translations: {},
            proofread: { styleCheck: false, spellCheck: false, grammarCheck: false },
        } as unknown as typeof window.__i18n;
        const createEditor = await freshCreateEditor();
        vi.useFakeTimers();
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, DOC, vi.fn());

        // Act — well past idle + debounce, and even after a real interaction
        await vi.advanceTimersByTimeAsync(2000);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
        await vi.advanceTimersByTimeAsync(2000);

        // Assert — a fully-disabled feature costs nothing: no lintBlocks ⇒ no
        // Harper, and no phrase-regex compile ⇒ none of MAR-315's floor either.
        expect(lintBlockPosts()).toBe(0);
        expect(spy.compileCalls).toBe(0);
    });

    it("with the master switch off should never compile the phrase regexes", async () => {
        // Arrange — the "Turn off proofreading" toggle, with every domain check
        // left on underneath it (the state a user lands in from the toolbar).
        window.__i18n = {
            translations: {},
            proofread: { proofreadingEnabled: false },
        } as unknown as typeof window.__i18n;
        const createEditor = await freshCreateEditor();
        vi.useFakeTimers();
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, DOC, vi.fn());

        // Act
        await vi.advanceTimersByTimeAsync(2000);

        // Assert — the master switch silences both halves at once
        expect(spy.compileCalls).toBe(0);
        expect(lintBlockPosts()).toBe(0);
    });

    it("with only the style check off should still scan, but compile nothing", async () => {
        // Arrange — style off, spelling on. Unlike the two cases above the pass
        // is NOT skipped: the scan really runs, so a zero compile count here is
        // the style gate working, not the whole feature being inert.
        window.__i18n = {
            translations: {},
            proofread: { styleCheck: false, spellCheck: true },
        } as unknown as typeof window.__i18n;
        const createEditor = await freshCreateEditor();
        vi.useFakeTimers();
        const container = document.createElement("div");
        document.body.appendChild(container);
        editor = await createEditor(container, DOC, vi.fn());

        // Act
        await vi.advanceTimersByTimeAsync(2000);

        // Assert — the scan demonstrably happened (it asked Harper) …
        expect(lintBlockPosts()).toBeGreaterThan(0);
        // … and still paid none of the phrase-regex compile floor.
        expect(spy.compileCalls).toBe(0);
    });
});
