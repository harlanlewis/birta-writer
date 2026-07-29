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

import type { EditorView } from "./pm";

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

/**
 * Wrap the view's transaction dispatch so every doc-changing transaction stamps
 * an `mdw:tx-apply` measure: the synchronous main-thread block of applying the
 * transaction and reconciling the view (DOM update + every plugin view's
 * `update`). While typing, that is the dominant — but not the whole —
 * per-keystroke cost: ProseMirror's pre-dispatch input path (DOM-observer
 * read, input-rule scan) and rAF-coalesced followers (TOC refresh, the
 * scheduled serialize) run outside this span (~1/3 of a typing burst's total
 * block, measured on the 300 KB fixture). The typing-perf harness
 * (`e2e/perf-typing.mjs`) reads these measures, and they make a slow real
 * document diagnosable from the webview devtools.
 *
 * **Selection-only transactions stamp `mdw:tx-select` instead**, and they are
 * measured for a reason worth stating, because the original design deliberately
 * left them unwrapped as "not the cost being tracked". That was wrong, and it
 * hid a real bug for as long as it stood: `@milkdown/plugin-prism` ran two
 * whole-document walks ABOVE its own `docChanged` test, so every arrow key and
 * click on a 300 KB document cost 2.4 ms of blocked main thread — and **no
 * harness or CI gate could see it**, because caret moves were the one class of
 * transaction nothing measured (MAR-137). A cost that no instrument reports is
 * a cost that regresses freely. The two spans are named separately so the
 * typing median stays exactly what it was and is never diluted by caret moves.
 */
export function instrumentTransactions(view: EditorView): void {
    // Entries are cleared on a rolling window so a long-lived, heavily edited
    // tab doesn't retain one PerformanceMeasure per keystroke forever (marks
    // and measures have no buffer limit). 1000 comfortably exceeds any harness
    // burst, and a recorded devtools trace keeps its copy regardless. Counted
    // per span so a long caret-only session cannot evict the typing measures.
    let sinceClearApply = 0;
    let sinceClearSelect = 0;
    view.setProps({
        // Mirrors ProseMirror's default dispatch (updateState(state.apply(tr)));
        // no other dispatchTransaction prop exists in this codebase to compose with.
        dispatchTransaction(tr) {
            // Explicit start/end (not a named start mark): a plugin dispatching
            // from inside its own update() re-enters this wrapper, and a nested
            // mark of the same name would silently become the outer measure's
            // start point.
            const docChanged = tr.docChanged;
            const name = docChanged ? "tx-apply" : "tx-select";
            const start = performance.now();
            view.updateState(view.state.apply(tr));
            try {
                if (docChanged) {
                    if (++sinceClearApply > 1000) {
                        performance.clearMeasures?.(PREFIX + "tx-apply");
                        sinceClearApply = 1;
                    }
                } else if (++sinceClearSelect > 1000) {
                    performance.clearMeasures?.(PREFIX + "tx-select");
                    sinceClearSelect = 1;
                }
                performance.measure?.(PREFIX + name, { start, end: performance.now() });
            } catch {
                // Profiling must never break the editor (e.g. a runtime without
                // the options form of measure).
            }
        },
    });
}
