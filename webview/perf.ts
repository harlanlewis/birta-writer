/**
 * webview/perf.ts
 *
 * Tiny wrapper over the User Timing API for launch-time profiling. Marks are
 * ~free (sub-microsecond) and ship permanently: they cost nothing at runtime
 * and let anyone profile a slow real document from the webview devtools
 * (Performance panel, or `performance.getEntriesByType("mark")`).
 *
 * All names are prefixed `mdw:` so they are easy to filter. The perf harness
 * (`e2e/perf.mjs`) reads these marks to measure cold-start; the headline number
 * is the `mdw:launch` measure (navigation start → first painted editor frame).
 */

const PREFIX = "mdw:";

/** Record a point-in-time mark, e.g. `mark("ready-posted")`. */
export function mark(name: string): void {
    // `performance` is always present in the webview (Electron) and in the
    // headless-Chromium harness; guard only so jsdom unit tests never throw.
    performance.mark?.(PREFIX + name);
}

/**
 * Record a duration between two marks (or from navigation start when `startMark`
 * is omitted). Never throws if a mark is missing — profiling must not break the
 * editor, so a failed measure is swallowed.
 */
export function measure(name: string, startMark?: string, endMark?: string): void {
    try {
        performance.measure?.(
            PREFIX + name,
            startMark ? PREFIX + startMark : undefined,
            endMark ? PREFIX + endMark : undefined,
        );
    } catch {
        // A missing start/end mark (e.g. an aborted load) must not surface.
    }
}
