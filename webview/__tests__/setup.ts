/**
 * jsdom environment setup: inject the acquireVsCodeApi global before test
 * files load, so messaging.ts can call it during module initialization.
 */
import { vi } from "vitest";

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

/** Exposed for test assertions. */
export { mockVscodeApi };
