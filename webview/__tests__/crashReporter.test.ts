/**
 * Crash boundary (MAR-169): uncaught errors and unhandled rejections must be
 * posted to the extension as structured `crash` messages, rate-limited per
 * session, and the reporting path itself must never throw (no feedback loop).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";

// Deferred import so acquireVsCodeApi is fully injected by setup.ts first
const { installCrashReporter, MAX_CRASH_REPORTS_PER_SESSION, _resetCrashReporterForTests } =
    await import("../crashReporter");

/** A fake Window recording the installed handlers so tests can fire them directly. */
function makeTarget() {
    const handlers = new Map<string, (event: unknown) => void>();
    const target = {
        addEventListener: (type: string, handler: (event: unknown) => void) => {
            handlers.set(type, handler);
        },
    } as unknown as Window;
    return {
        target,
        fireError: (event: Partial<ErrorEvent>) => handlers.get("error")!(event),
        fireRejection: (reason: unknown) => handlers.get("unhandledrejection")!({ reason }),
    };
}

describe("crashReporter", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _resetCrashReporterForTests();
    });

    it("an uncaught error should post a crash message with message, stack, and source", () => {
        const { target, fireError } = makeTarget();
        installCrashReporter(target);
        const err = new Error("boom");

        fireError({ message: "boom", error: err });

        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "crash",
            message: "boom",
            stack: err.stack,
            source: "error",
        });
    });

    it("an error event without an Error object should still post its message", () => {
        const { target, fireError } = makeTarget();
        installCrashReporter(target);

        fireError({ message: "Script error." });

        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "crash",
            message: "Script error.",
            source: "error",
        });
    });

    it("an unhandled rejection with an Error reason should carry its message and stack", () => {
        const { target, fireRejection } = makeTarget();
        installCrashReporter(target);
        const err = new Error("async boom");

        fireRejection(err);

        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "crash",
            message: "async boom",
            stack: err.stack,
            source: "unhandledrejection",
        });
    });

    it("a non-Error rejection reason should be stringified", () => {
        const { target, fireRejection } = makeTarget();
        installCrashReporter(target);

        fireRejection("plain string reason");

        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "crash",
            message: "plain string reason",
            source: "unhandledrejection",
        });
    });

    it("reports past the per-session limit should be dropped", () => {
        const { target, fireError } = makeTarget();
        installCrashReporter(target);

        for (let i = 0; i < MAX_CRASH_REPORTS_PER_SESSION + 3; i++) {
            fireError({ message: `crash ${i}`, error: new Error(`crash ${i}`) });
        }

        expect(mockVscodeApi.postMessage).toHaveBeenCalledTimes(MAX_CRASH_REPORTS_PER_SESSION);
    });

    it("a throwing postMessage should not propagate out of the handler (no feedback loop)", () => {
        const { target, fireError } = makeTarget();
        installCrashReporter(target);
        mockVscodeApi.postMessage.mockImplementation(() => {
            throw new Error("channel down");
        });

        expect(() => fireError({ message: "boom", error: new Error("boom") })).not.toThrow();
    });
});
