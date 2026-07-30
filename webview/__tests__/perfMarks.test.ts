/**
 * perf.ts — `hasMark`, the launch-milestone gate.
 *
 * A feature that must not run on the mount path needs a way to ask "has the
 * editor painted yet?" without guessing with a timer. `hasMark` is that
 * question, and the line-number gutter's first render depends on it — so the
 * failure mode worth pinning is the one that would make it wedge: a runtime
 * without User Timing must read as "go ahead", not "wait forever".
 */
import { describe, it, expect, afterEach } from "vitest";
import { hasMark, mark } from "../perf";

const original = performance.getEntriesByName;

afterEach(() => {
    performance.getEntriesByName = original;
    performance.clearMarks?.();
});

describe("hasMark", () => {
    it("an unstamped mark should read as absent", () => {
        expect(hasMark("never-stamped-anywhere")).toBe(false);
    });

    it("a stamped mark should read as present, under its mdw: prefix", () => {
        mark("gate-probe");
        expect(hasMark("gate-probe")).toBe(true);
        // The prefix is the module's business, not the caller's: asking for the
        // prefixed name must NOT accidentally work, or callers will start
        // hard-coding it.
        expect(hasMark("mdw:gate-probe")).toBe(false);
    });

    it("a runtime with no User Timing query should read as present, never blocking", () => {
        // The alternative — defaulting to false — turns a missing profiling API
        // into a feature that never starts. Profiling must never be load-bearing
        // for behavior.
        (performance as { getEntriesByName?: unknown }).getEntriesByName = undefined;
        expect(hasMark("anything-at-all")).toBe(true);
    });
});
