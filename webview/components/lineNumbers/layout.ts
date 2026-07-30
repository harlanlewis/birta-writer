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
 *    fence, a table's delimiter row) has no top of its own, so a RUN of them
 *    fills the whitespace between the measured lines that bracket it — one slot
 *    per line, ending flush against the line the run precedes.
 *
 *    That whitespace starts at the preceding line's **bottom**, not its top. A
 *    source line is one line of SOURCE and any number of rendered rows: an
 *    unwrapped paragraph is four rows, a heading two, a video embed three
 *    hundred pixels. Dividing from the previous line's top put the blank
 *    separator that follows a tall block in the MIDDLE of that block — a number
 *    beside the third row of a paragraph, or floating over a video — which
 *    reads as the gutter having lost track of the document.
 *
 *    And the whitespace is often smaller than the number that has to go in it:
 *    the margin between two paragraphs is routinely narrower than the gutter's
 *    own line. So a slot is never thinner than `minGap`, and a run that outgrows
 *    its gap grows UPWARDS out of it rather than thinning until rule 3 deletes
 *    it. A gutter reading 1, 2, 3, 5, 6, 7, 9 has dropped exactly the lines a
 *    reader counts by.
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
    /**
     * Bottom of the rendered extent this line occupies, in the same
     * coordinates — where the space after it begins.
     *
     * Read only as the START of the space an interpolated run divides, so the
     * caller only has to measure it for a line a run of unrendered lines
     * actually follows. Omitted (or null) means "one content line tall", which
     * is what a line whose rendered rows were never measured is worth
     * assuming.
     */
    bottom?: number | null;
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
     * Spacing for an interpolated run with no measured line on one side — the
     * leading run at the top of the window, or the trailing run at the end of
     * the document — and the height assumed for a measured line whose bottom
     * was not supplied. Nominally the content's line height.
     */
    lineHeight: number;
    /**
     * Height of a painted number's own line box. Tops are its TOP edge, so an
     * interpolated line centres itself in its slot by subtracting half of
     * this — otherwise every guessed number hangs half a line low against the
     * measured ones, which are centred on their text.
     *
     * The same measurement as `minGap` at today's call site (both are the
     * gutter's line height), and required rather than defaulted to it so that
     * stays a coincidence: one is a spacing rule and the other is geometry, and
     * a change to either should have to say what it means for the other.
     */
    numberHeight: number;
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
    const { minGap, lineHeight, numberHeight } = options;
    /** Centre a number of `numberHeight` in a slot of `height` starting at `y`. */
    const centred = (y: number, height: number): number => y + (height - numberHeight) / 2;

    // ── 1. Monotone clamp over the measured tops ───────────────────────────
    const tops: (number | null)[] = lines.map((l) => l.top);
    let ceiling = -Infinity;
    for (let i = 0; i < tops.length; i++) {
        const top = tops[i];
        if (top === null) { continue; }
        ceiling = Math.max(ceiling, top);
        tops[i] = ceiling;
    }
    /** Where the space after line `i` begins; never above its own top. */
    const bottomOf = (i: number): number => {
        const top = tops[i] as number;
        const bottom = lines[i].bottom;
        return bottom === null || bottom === undefined ? top + lineHeight : Math.max(bottom, top);
    };

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
        // The space begins where the previous line's rendered extent ENDS —
        // the whitespace a blank source line actually occupies. (The run is
        // maximal, so line i - 1 is always a measured one.)
        const before = i > 0 ? bottomOf(i - 1) : null;
        const after = end < tops.length ? tops[end] : null;
        for (let k = 0; k < count; k++) {
            let top: number;
            if (before !== null && after !== null) {
                // Interior run: one slot per line, never thinner than minGap,
                // and the run always ENDS at `after`. Those two clauses are the
                // same arithmetic where there is room (slots of gap/count laid
                // from `before`) and diverge where there is not, which is the
                // whole point — see rule 2's header.
                const slot = Math.max((after - before) / count, minGap);
                top = centred(after - slot * (count - k), slot);
            } else if (before !== null) {
                // Trailing run (end of document): step down by a line each.
                top = centred(before + lineHeight * k, lineHeight);
            } else if (after !== null) {
                // Leading run (top of the window): step up to reach `after`.
                top = centred(after - lineHeight * (count - k), lineHeight);
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
