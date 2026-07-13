/**
 * merge3.ts
 *
 * Line-based three-way merge for reconciling external disk edits into a dirty
 * TextDocument (see the disk-change sync in MarkdownEditorProvider): given the
 * last content both sides agreed on (`base`), the editor's unsaved content
 * (`ours`), and the new disk content (`theirs`), produce a merged text when the
 * two sides changed non-overlapping regions — or report a conflict when they
 * touched the same lines differently, so the caller can surface it instead of
 * guessing.
 *
 * Deliberately conservative, in git's diff3 spirit:
 * - a region changed by both sides merges only when both produced IDENTICAL
 *   lines; anything else is a conflict (never silently pick a winner);
 * - insertions by both sides at the same point conflict (their order would be
 *   a guess);
 * - oversized inputs and pathological diffs bail out as conflicts rather than
 *   burn CPU — a false conflict degrades to VS Code's native save dialog,
 *   a wrong merge would corrupt the document.
 */

export type Merge3Result =
    | { ok: true; merged: string }
    | { ok: false };

/** Total line-count guard: beyond this, report a conflict instead of diffing. */
const MAX_TOTAL_LINES = 300_000;

/**
 * Myers edit-distance budget per two-way diff. Documents whose versions differ
 * by more than this many line edits get a bail-out (conflict) instead of an
 * O(D²) crawl (time AND trace memory are quadratic in D); at that scale the
 * "merge" would be a rewrite anyway.
 */
const MAX_EDIT_DISTANCE = 2_000;

/** One changed region of a two-way line diff (both ranges end-exclusive). */
interface DiffHunk {
    baseStart: number;
    baseEnd: number;
    sideStart: number;
    sideEnd: number;
}

/** A DiffHunk tagged with which side of the merge produced it. */
interface SidedHunk extends DiffHunk {
    side: 0 | 1; // 0 = ours, 1 = theirs
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) { return false; }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) { return false; }
    }
    return true;
}

/**
 * Minimal line diff (Myers O(N·D) greedy) between `a` (base) and `b` (side),
 * returned as sorted, non-overlapping hunks. Null when the edit distance
 * exceeds MAX_EDIT_DISTANCE (caller treats it as a conflict).
 */
export function diffLines(a: readonly string[], b: readonly string[]): DiffHunk[] | null {
    // Trim the common prefix/suffix first: typical edits touch a small region,
    // which turns the Myers run into a tiny problem.
    let start = 0;
    const minLen = Math.min(a.length, b.length);
    while (start < minLen && a[start] === b[start]) { start++; }
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }

    const n = endA - start;
    const m = endB - start;
    if (n === 0 && m === 0) { return []; }
    if (n === 0 || m === 0) {
        return [{ baseStart: start, baseEnd: endA, sideStart: start, sideEnd: endB }];
    }

    // Intern lines as integers so the inner snake loop compares numbers.
    const ids = new Map<string, number>();
    const intern = (line: string): number => {
        let id = ids.get(line);
        if (id === undefined) {
            id = ids.size;
            ids.set(line, id);
        }
        return id;
    };
    const aa = new Int32Array(n);
    const bb = new Int32Array(m);
    for (let i = 0; i < n; i++) { aa[i] = intern(a[start + i]); }
    for (let i = 0; i < m; i++) { bb[i] = intern(b[start + i]); }

    const maxD = Math.min(n + m, MAX_EDIT_DISTANCE);
    const offset = maxD + 1;
    const v = new Int32Array(2 * maxD + 3);
    // trace[d] = V as it stood BEFORE round d, for backtracking — but only the
    // k-window [-(d-1), d-1] that round d-1 could have written (and that the
    // backtrack at depth d can read). Snapshotting the full V every round
    // would cost O(D·maxD) ints; the window keeps it at O(D²) with small
    // constants, which matters near the MAX_EDIT_DISTANCE bail-out boundary.
    const trace: Int32Array[] = [];
    let found = -1;

    outer: for (let d = 0; d <= maxD; d++) {
        trace.push(v.slice(offset - Math.max(0, d - 1), offset + d));
        for (let k = -d; k <= d; k += 2) {
            let x: number;
            if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
                x = v[offset + k + 1];
            } else {
                x = v[offset + k - 1] + 1;
            }
            let y = x - k;
            while (x < n && y < m && aa[x] === bb[y]) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) {
                found = d;
                break outer;
            }
        }
    }
    if (found < 0) { return null; }

    // Backtrack the edit path, coalescing contiguous non-diagonal moves into
    // hunks. Ops come out in reverse order; hunks are assembled back-to-front.
    const hunks: DiffHunk[] = [];
    let x = n;
    let y = m;
    for (let d = found; d > 0; d--) {
        // trace[d] holds ks [-(d-1), d-1]; index i in it maps to k = i - (d-1).
        const prevV = trace[d];
        const prevOffset = d - 1;
        const k = x - y;
        let prevK: number;
        if (k === -d || (k !== d && prevV[prevOffset + k - 1] < prevV[prevOffset + k + 1])) {
            prevK = k + 1; // vertical move: insertion of b[prevY]
        } else {
            prevK = k - 1; // horizontal move: deletion of a[prevX]
        }
        const prevX = prevV[prevOffset + prevK];
        const prevY = prevX - prevK;
        // Position right after the non-diagonal move (before the snake to x,y):
        const moveEndX = prevK === k + 1 ? prevX : prevX + 1;
        const moveEndY = prevK === k + 1 ? prevY + 1 : prevY;

        const last = hunks[hunks.length - 1];
        if (last && last.baseStart === moveEndX && last.sideStart === moveEndY) {
            // Contiguous with the hunk below (no diagonal in between): extend it.
            last.baseStart = prevX;
            last.sideStart = prevY;
        } else {
            hunks.push({
                baseStart: prevX,
                baseEnd: moveEndX,
                sideStart: prevY,
                sideEnd: moveEndY,
            });
        }
        x = prevX;
        y = prevY;
    }

    hunks.reverse();
    for (const h of hunks) {
        h.baseStart += start;
        h.baseEnd += start;
        h.sideStart += start;
        h.sideEnd += start;
    }
    return hunks;
}

/**
 * Three-way merge of `ours` and `theirs` against their common ancestor `base`.
 * Line-based; a region both sides changed merges only when they produced the
 * exact same lines, otherwise the whole merge reports a conflict ({ok:false}).
 */
export function merge3(base: string, ours: string, theirs: string): Merge3Result {
    // Fast paths — also the most common real cases (only one side moved).
    if (ours === theirs) { return { ok: true, merged: ours }; }
    if (base === ours) { return { ok: true, merged: theirs }; }
    if (base === theirs) { return { ok: true, merged: ours }; }

    const baseLines = base.split("\n");
    const oursLines = ours.split("\n");
    const theirsLines = theirs.split("\n");
    if (baseLines.length + oursLines.length + theirsLines.length > MAX_TOTAL_LINES) {
        return { ok: false };
    }

    const oursDiff = diffLines(baseLines, oursLines);
    const theirsDiff = diffLines(baseLines, theirsLines);
    if (!oursDiff || !theirsDiff) { return { ok: false }; }

    const hunks: SidedHunk[] = [
        ...oursDiff.map((h): SidedHunk => ({ ...h, side: 0 })),
        ...theirsDiff.map((h): SidedHunk => ({ ...h, side: 1 })),
    ];
    // Sort by base position; at the same position, pure insertions (zero base
    // width) come first so an insertion at the boundary of the other side's
    // replaced region groups deterministically OUTSIDE that region.
    hunks.sort((h1, h2) =>
        (h1.baseStart - h2.baseStart)
        || ((h1.baseEnd - h1.baseStart) - (h2.baseEnd - h2.baseStart))
        || (h1.side - h2.side),
    );

    const merged: string[] = [];
    let basePos = 0; // next base line not yet emitted
    let offA = 0;    // ours index − base index, valid outside ours-hunks
    let offB = 0;    // theirs index − base index, valid outside theirs-hunks

    let i = 0;
    while (i < hunks.length) {
        // Group hunks whose base ranges overlap. Two zero-width insertions at
        // the SAME point also group (their relative order would be a guess —
        // that's a conflict unless the inserted lines are identical).
        const lo = hunks[i].baseStart;
        let hi = hunks[i].baseEnd;
        const group: SidedHunk[] = [hunks[i]];
        let j = i + 1;
        while (
            j < hunks.length &&
            (hunks[j].baseStart < hi ||
                (hunks[j].baseStart === hi && hunks[j].baseEnd === hi && lo === hi))
        ) {
            hi = Math.max(hi, hunks[j].baseEnd);
            group.push(hunks[j]);
            j++;
        }

        // Emit the stable region before this group verbatim.
        for (let k = basePos; k < lo; k++) { merged.push(baseLines[k]); }

        // Map the group's base range [lo, hi) onto each side. Alignment is
        // linear outside a side's hunks, so the side range is the base range
        // shifted by the running offset, widened by the side's own length
        // delta inside the group.
        let dA = 0;
        let dB = 0;
        for (const h of group) {
            const delta = (h.sideEnd - h.sideStart) - (h.baseEnd - h.baseStart);
            if (h.side === 0) { dA += delta; } else { dB += delta; }
        }
        const aSlice = oursLines.slice(lo + offA, hi + offA + dA);
        const bSlice = theirsLines.slice(lo + offB, hi + offB + dB);
        const baseSlice = baseLines.slice(lo, hi);

        const aChanged = !arraysEqual(aSlice, baseSlice);
        const bChanged = !arraysEqual(bSlice, baseSlice);
        if (aChanged && bChanged) {
            if (!arraysEqual(aSlice, bSlice)) { return { ok: false }; }
            merged.push(...aSlice); // both made the identical change
        } else if (aChanged) {
            merged.push(...aSlice);
        } else {
            merged.push(...bSlice);
        }

        offA += dA;
        offB += dB;
        basePos = hi;
        i = j;
    }

    for (let k = basePos; k < baseLines.length; k++) { merged.push(baseLines[k]); }
    return { ok: true, merged: merged.join("\n") };
}
