/**
 * jsdom environment setup: inject the acquireVsCodeApi global before test
 * files load, so messaging.ts can call it during module initialization.
 */
import { vi, afterAll } from "vitest";

// ── Milkdown's ctx Timer leaks a 3s timeout per editor (MAR-298) ────────────
//
// `Editor.create()` starts a `Timer` per plugin timing, and each one arms a
// `setTimeout(…, 3000)` that NOTHING ever clears — not resolving the timer, not
// `editor.destroy()`:
//
//     #waitTimeout = (ifTimeout) => { setTimeout(() => ifTimeout(), 3000) }
//
// When it fires it calls the BARE GLOBAL `removeEventListener`. If this file's
// jsdom environment has been torn down by then, that identifier no longer
// resolves and the callback throws `ReferenceError: removeEventListener is not
// defined`. Vitest counts that as an UNHANDLED error, which exits the run
// non-zero with every test passing and no failing test named — so the gate
// fails at random and the failure describes nothing. Whether the timer lands
// before or after teardown is a race with machine load, which is why it hid on
// an idle laptop, appeared under load, and was reliably fatal on CI.
//
// Tracking every timeout the file schedules and clearing the survivors after
// its last test fixes it, and is exactly the cleanup the library would do
// itself if it kept a handle. Timers are tracked rather than blanket-cleared so
// nothing outside this file's own scheduling is touched.
//
// WHY THIS IS SAFE, precisely: the hook runs after every test AND after every
// hook the test file itself registers, at any nesting depth — but only because
// vitest's `sequence.hooks` default is `"stack"`, which runs after-hooks in
// reverse registration order, and this file is registered FIRST. Under `list`
// or `parallel` it would run before the test file's own `afterAll`, and
// `tightItemSpacing.test.ts` destroys its shared editor there — arming nine
// fresh timers that the already-run clear would miss, reinstating the exact CI
// failure. That is why `vitest.config.ts` now pins `sequence.hooks` instead of
// relying on the default (vitest's own CLI help still advertises `parallel`).
//
// `clearTimeout` is wrapped too, so a cancelled timer leaves the set. Without
// that the set only ever grew — retaining every cancelled timer's closure for
// the file's lifetime, and, worse, making `timerLeakGuard.test.ts` unable to
// notice if Milkdown ever started clearing its own timeouts.
//
// `vi.useFakeTimers()` swaps these wrappers out for its own and
// `useRealTimers()` puts them back, so the two compose; a fake-timer test
// simply isn't tracked, which is correct because its timers never reach the
// real event loop.
const pendingTimeouts = new Set<unknown>();
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;

// `handler` is typed as a function rather than `TimerHandler`: the string form
// is legacy `eval` syntax that Node's `setTimeout` rejects outright, so it
// cannot reach here, and typing it away is cheaper than a branch for it.
globalThis.setTimeout = function trackedSetTimeout(
    handler: (...a: unknown[]) => void,
    timeout?: number,
    ...args: unknown[]
): unknown {
    const id: unknown = (nativeSetTimeout as (...a: unknown[]) => unknown)(
        (...callbackArgs: unknown[]) => {
            pendingTimeouts.delete(id);
            handler(...callbackArgs);
        },
        timeout,
        ...args,
    );
    pendingTimeouts.add(id);
    return id;
} as unknown as typeof globalThis.setTimeout;

globalThis.clearTimeout = function trackedClearTimeout(id?: unknown): void {
    pendingTimeouts.delete(id);
    (nativeClearTimeout as (handle: unknown) => void)(id);
} as unknown as typeof globalThis.clearTimeout;

afterAll(() => {
    // The NATIVE clear, not whatever is installed right now: a file that left
    // fake timers in place would otherwise route these through sinon.
    for (const id of pendingTimeouts) {
        (nativeClearTimeout as (handle: unknown) => void)(id);
    }
    pendingTimeouts.clear();
});

const mockVscodeApi = {
    postMessage: vi.fn(),
    // Matches the real VsCodeApi.getState(): unknown, so tests can mock any state shape
    getState: vi.fn((): unknown => null),
    setState: vi.fn(),
};

Object.defineProperty(globalThis, "acquireVsCodeApi", {
    value: () => mockVscodeApi,
    writable: true,
    configurable: true,
});

// jsdom has no layout: Range lacks getClientRects/getBoundingClientRect,
// which ProseMirror's scrollToSelection path calls after commands that chain
// .scrollIntoView() (the Milkdown wrap/heading commands do). Zero-rects keep
// that path a harmless no-op instead of an unhandled TypeError.
const zeroRect = {
    top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON: () => ({}),
} as DOMRect;
if (typeof Range !== "undefined") {
    Range.prototype.getClientRects ??= () => {
        const list = [zeroRect];
        return Object.assign(list, { item: (i: number) => list[i] ?? null }) as unknown as DOMRectList;
    };
    Range.prototype.getBoundingClientRect ??= () => zeroRect;
}

// jsdom has no ResizeObserver; the floating selection palette constructs one to
// re-anchor on editor reflow. A no-op stub lets it instantiate (real reflow is
// covered by the e2e Chromium harness).
if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    } as unknown as typeof ResizeObserver;
}

// jsdom has no ClipboardEvent (Chromium, and therefore the real webview, does).
// ProseMirror's `view.pasteText` constructs one to carry into handlePaste, so
// the Paste as Plain Text command cannot run at all without this. Subclassing
// Event gives it the only property that path reads — a null clipboardData,
// which is exactly what the real synthetic event carries.
if (typeof globalThis.ClipboardEvent === "undefined") {
    globalThis.ClipboardEvent = class extends Event {
        readonly clipboardData: DataTransfer | null = null;
    } as unknown as typeof ClipboardEvent;
}

/** Exposed for test assertions. */
export { mockVscodeApi };

/** How many timeouts this file has scheduled and not yet run — the survivors
 *  `afterAll` clears. Exposed so `timerLeakGuard.test.ts` can assert the leak
 *  this workaround exists for is still real. */
export const pendingTimeoutCount = (): number => pendingTimeouts.size;
