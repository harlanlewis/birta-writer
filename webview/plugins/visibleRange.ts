/**
 * webview/plugins/visibleRange.ts
 *
 * The scroll window: which slice of the document is on screen (plus a
 * generous margin), expressed in ProseMirror document positions.
 *
 * MAR-215. The block gutter chrome is a per-block DECORATION — two per block,
 * more per list item — so on a large document the fold plugin's set holds
 * thousands of decorations that ProseMirror must position-map on every
 * keystroke and diff against the DOM on every redraw. Measured on the 300 KB
 * typing fixture that was 10 ms of `DecorationSet.map` plus roughly twice that
 * again inside the view's redraw, out of a 65 ms per-keystroke dispatch.
 * Chrome the reader cannot see costs exactly as much as chrome they can, so
 * the decoration pass builds only what is (nearly) in view; everything else is
 * emitted the moment it scrolls in. Nothing about the DOCUMENT is windowed —
 * only the affordance chrome drawn over it.
 *
 * Why a plain observer rather than a plugin with its own state: the consumer
 * (headingFold/plugin.ts) needs the window inside its own `apply`, and reading
 * a sibling plugin's state from the half-built `newState` depends on plugin
 * ORDER. The window therefore lives in the consumer's state, updated by a meta
 * this observer dispatches — no cross-plugin ordering to get wrong.
 *
 * Two properties make dropping and re-adding chrome safe:
 *   - it is layout-neutral (`.block-gutter-host` is `position: relative`, the
 *     gutter itself `position: absolute`), so a block entering or leaving the
 *     window never moves anything and can never shift the scroll position;
 *   - widget keys are position-free (gutterBlockPos derives the position at
 *     interaction time), so a re-added widget can never carry a stale one.
 *
 * With no layout engine — jsdom under the unit tests — `measure` returns null,
 * which every consumer reads as "the whole document", so the windowing is
 * invisible to the unit suites.
 */
import type { EditorView } from "../pm";

export interface VisibleWindow {
    readonly from: number;
    readonly to: number;
}

/**
 * How far beyond the viewport, in viewport heights, the window reaches on each
 * side. Two screens of slack means a fast flick lands on decorated content,
 * and — with the recommit threshold below — a scroll rebuild happens at most
 * once per half screen.
 */
const MARGIN_SCREENS = 2;

/**
 * How far (in viewport heights) the page must scroll before the window is
 * recomputed. Recomputing is cheap (the build is windowed too), but a rebuild
 * per scroll frame would still be wasted work; half a screen keeps at least
 * 1.5 screens of decorated margin ahead of the reader at all times.
 */
const RECOMMIT_SCREENS = 0.5;

/**
 * The document range covered by the viewport plus `MARGIN_SCREENS` on each
 * side, or null when coordinates can't be resolved (no layout engine, a
 * detached editor, a zero-height view). Exported for unit testing.
 */
export function measureVisibleWindow(view: EditorView): VisibleWindow | null {
    const dom = view.dom as HTMLElement;
    if (!dom.isConnected || typeof dom.getBoundingClientRect !== "function") {
        return null;
    }
    const rect = dom.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    if (rect.height <= 0 || rect.width <= 0 || !viewportHeight) {
        return null;
    }
    // Probe a column just inside the editor's text, never its margin: the
    // gutter chrome lives in the left margin and `posAtCoords` over empty
    // margin can miss.
    const x = rect.left + Math.min(rect.width / 2, 240);
    const margin = viewportHeight * MARGIN_SCREENS;
    // Clamp the probe points into the editor's own box — outside it
    // `posAtCoords` returns null, and "above the start" / "below the end" are
    // exactly the cases we want saturating to the document's ends.
    const topY = -margin;
    const bottomY = viewportHeight + margin;
    const from = topY <= rect.top ? 0 : posAt(view, x, Math.min(topY, rect.bottom - 1));
    const size = view.state.doc.content.size;
    const to = bottomY >= rect.bottom ? size : posAt(view, x, Math.max(bottomY, rect.top + 1));
    if (from === null || to === null) {
        return null;
    }
    return from < to ? { from, to } : { from: 0, to: size };
}

function posAt(view: EditorView, left: number, top: number): number | null {
    try {
        return view.posAtCoords({ left, top })?.pos ?? null;
    } catch {
        // posAtCoords touches layout APIs a bare DOM implementation may lack.
        return null;
    }
}

function sameWindow(a: VisibleWindow | null, b: VisibleWindow | null): boolean {
    return a === b || (!!a && !!b && a.from === b.from && a.to === b.to);
}

/**
 * Watch the scroll position and call `onChange` whenever the visible window
 * moves far enough to matter.
 *
 * NOTHING happens until `start()` is called — no listeners, no measurement, no
 * `onChange`. That is deliberate and load-bearing (MAR-215): the caller runs on
 * the mount path, and a window arriving before first paint pulls the whole
 * gutter chrome's DOM insertion, layout, and paint in FRONT of the paint mark.
 * Measured on the 96 KB fixture that cost 36 ms of launch even though the
 * measurement itself is 0.4 ms and the rebuild 0.6 ms — the price is the
 * rendering the new decorations force, not the computing. MAR-189 already
 * keeps that DOM off the mount path by deferring the affordance build to an
 * idle callback after first paint; `start()` exists so this observer joins
 * that deferral instead of defeating it.
 *
 * `start()` measures SYNCHRONOUSLY, so the caller's post-paint idle callback
 * gets its window in the same task and builds once, rather than a frame later
 * and twice.
 *
 * The scroll container is the webview's `window` (the editor is not itself a
 * scroller), mirroring plugins/headingSticky.ts.
 */
export function observeVisibleWindow(
    view: EditorView,
    onChange: (next: VisibleWindow | null) => void,
): { start: () => void; refresh: () => void; destroy: () => void } {
    let frame: number | null = null;
    let started = false;
    let committedScrollY = Number.NaN;
    let committedViewportHeight = Number.NaN;
    let committedDocHeight = Number.NaN;
    let committed: VisibleWindow | null = null;
    let destroyed = false;

    const run = (): void => {
        frame = null;
        if (!started || destroyed || view.isDestroyed) {
            return;
        }
        const scrollY = window.scrollY;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const docHeight = (view.dom as HTMLElement).scrollHeight;
        // Hysteresis on the SCROLL POSITION, not on re-measured positions: the
        // test is nearly free, where re-probing coordinates every frame would
        // put `posAtCoords` back on the scroll path.
        //
        // Document height is in the test too, and for a different reason: it
        // is the case scroll position alone misses. Content above the viewport
        // growing — a Mermaid diagram or an image finishing — pushes what is on
        // screen down without moving the scroll position at all, so the window,
        // which is in DOCUMENT coordinates, would quietly point at content that
        // has drifted off screen. The threshold is the same half-screen, so a
        // keystroke's line-height change never recommits but a render does.
        if (
            committed !== null &&
            viewportHeight === committedViewportHeight &&
            Math.abs(scrollY - committedScrollY) < viewportHeight * RECOMMIT_SCREENS &&
            Math.abs(docHeight - committedDocHeight) < viewportHeight * RECOMMIT_SCREENS
        ) {
            return;
        }
        const next = measureVisibleWindow(view);
        committedScrollY = scrollY;
        committedViewportHeight = viewportHeight;
        committedDocHeight = docHeight;
        if (sameWindow(next, committed)) {
            return;
        }
        committed = next;
        onChange(next);
    };

    const schedule = (): void => {
        if (started && frame === null && !destroyed) {
            frame = requestAnimationFrame(run);
        }
    };

    /** Force the next tick to re-measure regardless of scroll delta. */
    const refresh = (): void => {
        committed = null;
        schedule();
    };

    const onResize = (): void => { refresh(); };
    // Reflow inside the editor only SCHEDULES a tick; the height test in
    // `run` decides whether it is big enough to recommit, so a keystroke's
    // reflow costs one comparison rather than a rebuild.
    let resizeObserver: ResizeObserver | null = null;

    const start = (): void => {
        if (started || destroyed || view.isDestroyed) {
            return;
        }
        started = true;
        resizeObserver = typeof ResizeObserver === "function"
            ? new ResizeObserver(() => { schedule(); })
            : null;
        resizeObserver?.observe(view.dom);
        window.addEventListener("scroll", schedule, { passive: true });
        window.addEventListener("resize", onResize);
        // Synchronous, not scheduled: the caller is already in its post-paint
        // idle window and wants to build once, now.
        run();
    };

    return {
        start,
        refresh,
        destroy() {
            destroyed = true;
            if (frame !== null) {
                cancelAnimationFrame(frame);
            }
            resizeObserver?.disconnect();
            window.removeEventListener("scroll", schedule);
            window.removeEventListener("resize", onResize);
        },
    };
}
