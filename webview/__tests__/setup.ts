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

/** Exposed for test assertions. */
export { mockVscodeApi };
