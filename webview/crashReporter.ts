/**
 * crashReporter.ts — the webview's crash boundary (MAR-169).
 *
 * Uncaught errors (`window.onerror`) and unhandled promise rejections are
 * posted to the extension as a structured `crash` message, so a broken webview
 * surfaces in the extension host (console error + a single notification)
 * instead of dying silently inside the iframe.
 *
 * Feedback-loop guards, both load-bearing:
 * - the report body never throws (a crash inside the handler must not recurse
 *   through the very listener that is reporting it);
 * - at most MAX_CRASH_REPORTS_PER_SESSION reports are posted per webview
 *   session, so a render loop that errors per frame cannot flood the message
 *   channel (the extension dedupes notifications on its side too).
 *
 * Decoration only: this module never touches the editor or the content sync
 * protocol, and costs nothing until something actually crashes.
 */
import { notifyCrash } from "./messaging";

/** Post at most this many crash reports per webview session. */
export const MAX_CRASH_REPORTS_PER_SESSION = 5;

let reportsSent = 0;

/** TEST-ONLY: reset the per-session rate-limit counter. */
export function _resetCrashReporterForTests(): void {
    reportsSent = 0;
}

/** Rate-limited, never-throwing report. */
function report(
    source: "error" | "unhandledrejection",
    message: string,
    stack: string | undefined,
): void {
    if (reportsSent >= MAX_CRASH_REPORTS_PER_SESSION) { return; }
    reportsSent++;
    try {
        notifyCrash(message, stack, source);
    } catch {
        // Reporting must never become a second crash (and never recurse
        // through the global handlers below).
    }
}

/** Best-effort message/stack from an arbitrary thrown/rejected value. */
function describe(value: unknown): { message: string; stack?: string } {
    if (value instanceof Error) {
        return { message: value.message || String(value), stack: value.stack };
    }
    try {
        return { message: String(value) };
    } catch {
        return { message: "unknown error" };
    }
}

/**
 * Install the global crash handlers. Called once from webview/index.ts;
 * `target` is injectable for tests.
 */
export function installCrashReporter(target: Window = window): void {
    target.addEventListener("error", (event) => {
        const err = (event as ErrorEvent).error as unknown;
        const fromError = describe(err);
        report(
            "error",
            (event as ErrorEvent).message || fromError.message,
            fromError.stack,
        );
    });
    target.addEventListener("unhandledrejection", (event) => {
        const { message, stack } = describe((event as PromiseRejectionEvent).reason);
        report("unhandledrejection", message, stack);
    });
}
