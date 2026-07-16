/**
 * Run work in an idle window, off the paint path.
 *
 * Decoration/analysis work (proofreading, word counting) must never block the
 * editor becoming interactive, so it settles in after first paint rather than
 * riding a user interaction. `timeoutMs` bounds the wait: a busy main thread
 * can defer the callback, but never starve it indefinitely.
 *
 * jsdom has no `requestIdleCallback`, so the `setTimeout(0)` fallback is also
 * what the unit tests exercise (fake timers advance it).
 */
export function requestIdle(cb: () => void, timeoutMs: number): { cancel: () => void } {
    const globals = globalThis as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
        cancelIdleCallback?: (handle: number) => void;
    };
    const ric = globals.requestIdleCallback;
    if (ric) {
        const handle = ric(cb, { timeout: timeoutMs });
        return { cancel: () => globals.cancelIdleCallback?.(handle) };
    }
    const timer = setTimeout(cb, 0);
    return { cancel: () => clearTimeout(timer) };
}
