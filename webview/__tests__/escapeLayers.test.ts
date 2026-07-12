/**
 * Tests for the Escape-layer stack (ui/escapeLayers.ts): open-order
 * (topmost-first) closing, idempotent unregistration, and reentrancy — a
 * close path calling its own unregister while closeTopmostLayer runs.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerEscapeLayer, closeTopmostLayer } from "../ui/escapeLayers";

describe("escapeLayers", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Drain entries left behind by earlier tests (module-level stack).
        while (closeTopmostLayer()) { /* drain */ }
    });

    it("an empty stack should return false and close nothing", () => {
        expect(closeTopmostLayer()).toBe(false);
    });

    it("layers should close most-recently-opened first", () => {
        const order: string[] = [];
        registerEscapeLayer(() => order.push("first"));
        registerEscapeLayer(() => order.push("second"));
        expect(closeTopmostLayer()).toBe(true);
        expect(order).toEqual(["second"]);
        expect(closeTopmostLayer()).toBe(true);
        expect(order).toEqual(["second", "first"]);
        expect(closeTopmostLayer()).toBe(false);
    });

    it("unregister should remove its layer without invoking close", () => {
        const below = vi.fn();
        const above = vi.fn();
        registerEscapeLayer(below);
        const offAbove = registerEscapeLayer(above);
        offAbove();
        expect(above).not.toHaveBeenCalled();
        expect(closeTopmostLayer()).toBe(true);
        expect(below).toHaveBeenCalledTimes(1);
        expect(above).not.toHaveBeenCalled();
    });

    it("a double unregister should be a no-op, never removing another layer", () => {
        const below = vi.fn();
        const above = vi.fn();
        registerEscapeLayer(below);
        const offAbove = registerEscapeLayer(above);
        offAbove();
        offAbove(); // must NOT remove `below`
        expect(closeTopmostLayer()).toBe(true);
        expect(below).toHaveBeenCalledTimes(1);
    });

    it("the same close fn registered twice should own two distinct entries", () => {
        const close = vi.fn();
        const offA = registerEscapeLayer(close);
        registerEscapeLayer(close);
        offA(); // removes A's entry, not B's
        expect(closeTopmostLayer()).toBe(true);
        expect(close).toHaveBeenCalledTimes(1);
        expect(closeTopmostLayer()).toBe(false);
    });

    it("a close that unregisters itself mid-closeTopmostLayer should not disturb the stack", () => {
        // The real-world shape: every surface's close path calls its own
        // unregister, including when the close came FROM the stack.
        const below = vi.fn();
        registerEscapeLayer(below);
        const off: { fn: (() => void) | null } = { fn: null };
        off.fn = registerEscapeLayer(() => off.fn?.());
        expect(closeTopmostLayer()).toBe(true); // reentrant unregister: no throw
        expect(below).not.toHaveBeenCalled();   // and no extra layer closed
        expect(closeTopmostLayer()).toBe(true);
        expect(below).toHaveBeenCalledTimes(1);
    });
});
