/**
 * Tests for typewriter mode's caret-scroll band.
 *
 * The band is not asserted against hand-computed numbers, because a number
 * only confirms what the author already believed. What has to hold is a
 * property of ProseMirror's correction step: applying it to a caret outside
 * the band must reach a FIXED POINT, or the viewport alternates between the
 * two corrections and jitters on every keystroke. `settle` below is that
 * correction, transcribed from prosemirror-view's scrollRectIntoView, and the
 * sweep drives it over the geometry a real pane produces.
 */
import { describe, expect, it } from "vitest";
import { computeTypewriterInsets, isTypewriterMode, setTypewriterMode } from "../plugins/typewriterScroll";
import type { CaretScrollBand } from "../plugins/caretScrollMargin";

/**
 * One pass of ProseMirror's scroll correction, in viewport coordinates.
 *
 * scrollRectIntoView compares the caret rect against the viewport inset by
 * `threshold` and, when it violates a side, moves it to sit `margin` in from
 * that side. Threshold and margin are the same object here, as the plugin
 * supplies them. The if/else is load-bearing and is reproduced exactly: a
 * caret violating BOTH sides takes the top correction, which is the asymmetry
 * that lets a too-small band oscillate.
 *
 * Returns the caret's new top, and whether it moved at all.
 */
function settle(
    caretTop: number,
    caretHeight: number,
    viewportHeight: number,
    band: CaretScrollBand,
): { top: number; moved: boolean } {
    const caretBottom = caretTop + caretHeight;
    if (caretTop < band.top) {
        return { top: band.top, moved: true };
    }
    if (caretBottom > viewportHeight - band.bottom) {
        return { top: viewportHeight - band.bottom - caretHeight, moved: true };
    }
    return { top: caretTop, moved: false };
}

/** Pane geometries a real editor produces: short laptop panes to tall displays. */
const VIEWPORT_HEIGHTS = [200, 320, 480, 600, 768, 900, 1080, 1440, 2160];
/**
 * Body text through to an H1. The fractional entries are the point rather than
 * padding: `coordsAtPos` returns subpixel rects, so a band computed from whole
 * numbers is not the band the editor actually gets, and the equality that the
 * correction's two branches meet at is a floating-point one.
 */
const CARET_HEIGHTS = [8, 14, 19, 22, 28, 34, 48, 64, 96, 18.4, 22.75, 28.8, 33.6, 46.08];
/** No topbar (hidden), the 40px default, and a wrapped two-row bar. */
const TOPBAR_BOTTOMS = [0, 40, 88];

describe("computeTypewriterInsets", () => {
    it("a caret anywhere in the viewport should settle to a fixed point in one correction", () => {
        let applicable = 0;
        for (const viewportHeight of VIEWPORT_HEIGHTS) {
            for (const caretHeight of CARET_HEIGHTS) {
                for (const topbarBottom of TOPBAR_BOTTOMS) {
                    const band = computeTypewriterInsets({ viewportHeight, caretHeight, topbarBottom });
                    if (!band) {
                        continue;
                    }
                    applicable++;
                    // Start the caret at every position a scroll could leave it,
                    // including hard against both edges.
                    for (let start = -caretHeight; start <= viewportHeight; start += 7) {
                        const first = settle(start, caretHeight, viewportHeight, band);
                        const second = settle(first.top, caretHeight, viewportHeight, band);
                        expect(second.moved).toBe(false);
                        expect(second.top).toBe(first.top);
                    }
                }
            }
        }
        // A sweep that declined every case would pass every assertion above
        // without testing anything. Most of this grid must be applicable.
        expect(applicable).toBeGreaterThan(
            (VIEWPORT_HEIGHTS.length * CARET_HEIGHTS.length * TOPBAR_BOTTOMS.length) / 2,
        );
    });

    it("a settled caret should sit at the vertical center, within the band's one pixel of slack", () => {
        let checked = 0;
        for (const viewportHeight of VIEWPORT_HEIGHTS) {
            for (const caretHeight of CARET_HEIGHTS) {
                const band = computeTypewriterInsets({ viewportHeight, caretHeight, topbarBottom: 40 });
                if (!band) {
                    continue;
                }
                checked++;
                const center = (viewportHeight - caretHeight) / 2;
                // Approach from above and from below: both corrections must
                // land on the anchor, not just the one the author had in mind.
                for (const start of [0, viewportHeight - caretHeight]) {
                    const { top } = settle(start, caretHeight, viewportHeight, band);
                    expect(Math.abs(top - center)).toBeLessThanOrEqual(1);
                }
            }
        }
        expect(checked).toBeGreaterThan(0);
    });

    it("a centered caret that would land under the fixed topbar should decline rather than clamp", () => {
        // A 200px pane centers a 20px caret at y=90; a 120px topbar covers it.
        expect(computeTypewriterInsets({ viewportHeight: 200, caretHeight: 20, topbarBottom: 120 })).toBeNull();
        // The same pane with the ordinary 40px bar is fine.
        expect(computeTypewriterInsets({ viewportHeight: 200, caretHeight: 20, topbarBottom: 40 })).not.toBeNull();
    });

    it("degenerate geometry should decline rather than return a band", () => {
        const cases: Array<[string, Parameters<typeof computeTypewriterInsets>[0]]> = [
            ["caret taller than the viewport", { viewportHeight: 40, caretHeight: 80, topbarBottom: 0 }],
            ["caret exactly the viewport", { viewportHeight: 80, caretHeight: 80, topbarBottom: 0 }],
            ["unmeasured viewport", { viewportHeight: 0, caretHeight: 20, topbarBottom: 0 }],
            ["unmeasured caret", { viewportHeight: 800, caretHeight: 0, topbarBottom: 0 }],
            ["NaN viewport", { viewportHeight: Number.NaN, caretHeight: 20, topbarBottom: 0 }],
            ["infinite caret", { viewportHeight: 800, caretHeight: Number.POSITIVE_INFINITY, topbarBottom: 0 }],
        ];
        for (const [label, input] of cases) {
            expect(computeTypewriterInsets(input), label).toBeNull();
        }
        expect(cases.length).toBe(6);
    });

    it("the band should never reserve more than the viewport holds", () => {
        for (const viewportHeight of VIEWPORT_HEIGHTS) {
            for (const caretHeight of CARET_HEIGHTS) {
                const band = computeTypewriterInsets({ viewportHeight, caretHeight, topbarBottom: 0 });
                if (!band) {
                    continue;
                }
                expect(band.top).toBeGreaterThanOrEqual(0);
                expect(band.bottom).toBeGreaterThanOrEqual(0);
                // The remaining window must still admit the caret it was sized for.
                expect(viewportHeight - band.top - band.bottom).toBeGreaterThanOrEqual(caretHeight);
            }
        }
    });
});

describe("typewriter mode flag", () => {
    it("the mode should default to off and round-trip a set", () => {
        expect(isTypewriterMode()).toBe(false);
        setTypewriterMode(true);
        expect(isTypewriterMode()).toBe(true);
        setTypewriterMode(false);
        expect(isTypewriterMode()).toBe(false);
    });
});
