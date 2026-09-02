/**
 * Run work in an idle window, off the paint path.
 *
 * Decoration/analysis work (proofreading, word counting) must never block the
 * editor becoming interactive, so it settles in after first paint rather than
 * riding a user interaction. `timeoutMs` bounds the wait: a busy main thread
 * can defer the callback, but never starve it indefinitely.
 *
 * The fallback is load-bearing, not a jsdom convenience. WebKit implements no
 * `requestIdleCallback` at all, so on the surface Birta Writer for Mac renders
 * in it is the ONLY path, and a bare `setTimeout(0)` scheduled during mount
 * fires before the first paint: work this exists to keep off the paint path was
 * running on it. `editor-painted` is marked from a nested pair of animation
 * frames (`webview/index.ts`), so anything meaning to land after it has to clear
 * the same pair and then yield. One frame is not enough and a bare timeout is
 * not close. Asserted by `e2e/perf` and `e2e/gutterWindow`, which compare the
 * marks this schedules against the paint mark.
 *
 * The frame wait is scoped to the MOUNT path, which is the only place it buys
 * anything: once `editor-painted` is stamped there is nothing left to land
 * after, and two timer-backed frames on every later call would be pure latency
 * on paths that run per edit (the word-count reporter, the numbering
 * reconcile). `hasMark("editor-painted")` is the codebase's own statement of
 * "not on the mount path" (webview/perf.ts).
 *
 * A test that drives the mount path needs frames as well as timers: stub
 * `requestAnimationFrame` to run its callback, or the work never arrives.
 */
import { hasMark } from "../perf";

export function requestIdle(cb: () => void, timeoutMs: number): { cancel: () => void } {
    const globals = globalThis as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
        cancelIdleCallback?: (handle: number) => void;
        requestAnimationFrame?: (cb: () => void) => number;
    };
    const ric = globals.requestIdleCallback;
    if (ric) {
        const handle = ric(cb, { timeout: timeoutMs });
        return { cancel: () => globals.cancelIdleCallback?.(handle) };
    }
    const raf = globals.requestAnimationFrame;
    if (!raf || hasMark("editor-painted")) {
        const timer = setTimeout(cb, 0);
        return { cancel: () => clearTimeout(timer) };
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    raf(() => raf(() => {
        if (cancelled) return;
        timer = setTimeout(cb, 0);
    }));
    return { cancel: () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); } };
}
