/**
 * components/lineNumbers/layout.ts
 *
 * Turns measured (and unmeasurable) source lines into the y-coordinates the
 * gutter paints — the whole "a source line has no fixed height" problem, in
 * pure arithmetic so it can be tested without a layout engine.
 *
 * Three transforms, in order, each answering a way a rendered document defeats
 * an evenly-spaced ladder:
 *
 * 1. **Monotone clamp.** Measured tops are supposed to increase down the
 *    document, but a measurement can invert: a floated element, a sticky
 *    heading, a stale rect read across a reflow. An inverted number would sit
 *    above the line before it, which reads as a rendering bug, so a top that
 *    goes backwards is pinned to its predecessor.
 * 2. **Interpolation.** A line nothing renders (a blank separator, a closing
 *    fence, a table's delimiter row) has no top of its own, so a RUN of them is
 *    spread evenly through the space between the measured lines that bracket
 *    it. The inter-block flow gap is about one line tall, which is exactly what
 *    a blank source line is, so this lands where a reader expects.
 * 3. **Collision drop.** Interpolation cannot invent space that isn't there: a
 *    tall run inside a short gap, or two source lines the renderer collapsed
 *    onto nearly the same row, would overlap. Numbers are walked top-down and
 *    any one that cannot clear its predecessor is DROPPED. Measured lines are
 *    never dropped in favour of interpolated ones — a real position outranks a
 *    guessed one.
 *
 * The result is a gutter whose spacing is deliberately irregular: it tracks
 * what the renderer actually did rather than pretending every line is 19px.
 */

/** A source line, with the top it measured to (or null when nothing rendered it). */
export interface MeasuredLine {
    line: number;
    /** Top in DOCUMENT coordinates, or null when the line renders nothing. */
    top: number | null;
}

/** A source line placed at a definite document-coordinate top. */
export interface PlacedLine {
    line: number;
    top: number;
}

export interface LayoutOptions {
    /**
     * Minimum vertical distance between two painted numbers. The gutter's own
     * line-height: any closer and the glyphs touch.
     */
    minGap: number;
    /**
     * Fallback spacing for an interpolated run with no measured line on one
     * side — the leading run at the top of the window, or the trailing run at
     * the end of the document. Nominally the content's line height.
     */
    lineHeight: number;
}

/**
 * Place every line, then drop the ones that cannot fit.
 *
 * Input must be ordered by `line` ascending (which `sourceLineIndex`
 * guarantees). Output is ordered by `top` ascending and never has two entries
 * closer than `minGap`.
 */
export function layoutLineNumbers(lines: MeasuredLine[], options: LayoutOptions): PlacedLine[] {
    if (!lines.length) { return []; }
    const { minGap, lineHeight } = options;

    // ── 1. Monotone clamp over the measured tops ───────────────────────────
    const tops: (number | null)[] = lines.map((l) => l.top);
    let ceiling = -Infinity;
    for (let i = 0; i < tops.length; i++) {
        const top = tops[i];
        if (top === null) { continue; }
        ceiling = Math.max(ceiling, top);
        tops[i] = ceiling;
    }

    // ── 2. Interpolate each run of unmeasured lines ────────────────────────
    // `placed` keeps the measured/interpolated distinction, which rule 3 needs
    // to decide who yields to whom.
    const placed: Array<PlacedLine & { measured: boolean }> = [];
    let i = 0;
    while (i < tops.length) {
        const top = tops[i];
        if (top !== null) {
            placed.push({ line: lines[i].line, top, measured: true });
            i++;
            continue;
        }
        // A run of nulls: [i, end). `before`/`after` bracket it.
        let end = i;
        while (end < tops.length && tops[end] === null) { end++; }
        const count = end - i;
        const before = i > 0 ? tops[i - 1] : null;
        const after = end < tops.length ? tops[end] : null;
        for (let k = 0; k < count; k++) {
            let top: number;
            if (before !== null && after !== null) {
                // Interior run: evenly divide the bracket. `count + 1` slots so
                // the run sits BETWEEN its neighbours rather than touching them.
                top = before + ((after - before) * (k + 1)) / (count + 1);
            } else if (before !== null) {
                // Trailing run (end of document): step down by a line each.
                top = before + lineHeight * (k + 1);
            } else if (after !== null) {
                // Leading run (top of the window): step up to reach `after`.
                top = after - lineHeight * (count - k);
            } else {
                // Nothing measured anywhere — a document the index could not
                // verify at all. Placing these would be pure fiction.
                top = Number.NaN;
            }
            placed.push({ line: lines[i + k].line, top, measured: false });
        }
        i = end;
    }

    // ── 3. Drop what cannot clear its predecessor ──────────────────────────
    const kept: Array<PlacedLine & { measured: boolean }> = [];
    const lastTop = (): number => (kept.length ? kept[kept.length - 1].top : -Infinity);
    for (const entry of placed) {
        if (!Number.isFinite(entry.top)) { continue; }
        if (entry.top >= lastTop() + minGap) {
            kept.push(entry);
            continue;
        }
        // Too close. A measured line may evict preceding INTERPOLATED ones —
        // the guess was wrong about where the space was, and a real position
        // outranks a guessed one. Otherwise this entry is the one that yields.
        if (!entry.measured) { continue; }
        while (kept.length && !kept[kept.length - 1].measured && entry.top < lastTop() + minGap) {
            kept.pop();
        }
        if (entry.top >= lastTop() + minGap) { kept.push(entry); }
    }
    return kept.map(({ line, top }) => ({ line, top }));
}
