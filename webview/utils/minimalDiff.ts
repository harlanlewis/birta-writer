/**
 * Minimal-diff merge between the last saved Markdown text and a fresh full
 * serialization of the editor document.
 *
 * remark-stringify re-serializes the entire document on every edit, which
 * would silently reformat regions the user never touched (table column
 * padding, separator dash widths, blank-line style, ...). Instead of writing
 * the serializer output verbatim, we LCS-diff its significant (non-blank)
 * lines against the saved file and apply only the real content changes.
 *
 * On top of the line diff sits round-trip protection (see
 * `computeRoundTripProtection`): constructs the parser cannot represent are
 * dropped or rewritten by a zero-edit round trip (reference-link definitions
 * vanish, setext headings become ATX, `* _ [` get escaped, ...). Those
 * changes appear in every diff even though the user never touched the lines,
 * so without protection a single keystroke elsewhere in the file would
 * silently destroy them on save.
 */

// ─── Comparison normalizers ─────────────────────────────────────────────────

const SEP_ROW_RE = /^\|[\s\-:|]+\|$/;
const TABLE_ROW_RE = /^\|.*\|$/;

// Normalize a table separator row: collapse dashes and cell padding, keeping
// only the alignment colons. `| :----- | :----: |` → `|:-|:-:|` so that two
// rows differing only in dash width compare as equal.
function normalizeSepRow(line: string): string {
    const t = line.trim();
    const cells = t.split("|").slice(1, -1).map((c) => {
        return c.trim().replace(/(:?)-+(:?)/g, (_: string, a: string, b: string) => (a ?? "") + "-" + (b ?? ""));
    });
    return "|" + cells.join("|") + "|";
}

// Normalize adjacent strong runs: `**a** **b**` → `**a b**`. remark-stringify
// splits a strong node into two `**...**` runs when it contains a link child,
// which is semantically identical content.
function normalizeSplitStrong(line: string): string {
    let prev: string;
    do {
        prev = line;
        line = line.replace(
            /\*\*((?:[^*]|\*(?!\*))*)\*\* \*\*((?:[^*]|\*(?!\*))*)\*\*/g,
            "**$1 $2**",
        );
    } while (line !== prev);
    return line;
}

// Normalize a table data row: strip cell padding, and treat `<br />` as an
// empty cell (older saves wrote empty cells as `<br />`).
// `| fruit   |  price  |` → `|fruit|price|`
function normalizeTableDataRow(line: string): string {
    const t = line.trim();
    const cells = t.split("|").slice(1, -1).map((c) => {
        const v = c.trim();
        return v === "<br />" ? "" : v;
    });
    return "|" + cells.join("|") + "|";
}

// Normalize a fence opening line: ``` javascript → ```javascript (drop the
// space before the language token).
function normalizeFenceOpen(line: string): string {
    return line.replace(/^(\s*`{3,})\s+/, "$1");
}

function normLineForCompare(line: string): string {
    const t = line.trim();
    if (SEP_ROW_RE.test(t)) return normalizeSepRow(line);
    if (TABLE_ROW_RE.test(t)) return normalizeTableDataRow(line);
    if (/^`{3,}/.test(t)) return normalizeFenceOpen(line);
    return normalizeSplitStrong(line);
}

// ─── Line diff (shared by the merge and by protection computation) ─────────

interface SigLine {
    text: string;
    lineIdx: number;
}

type Edit =
    | { op: "keep"; saved: SigLine; serial: SigLine }
    | { op: "del"; saved: SigLine }
    | { op: "ins"; serial: SigLine }
    // A protected del: the saved line is emitted verbatim instead of deleted.
    | { op: "pin"; saved: SigLine }
    // A protected ins: the serializer's replacement line is swallowed (its
    // saved original was pinned). Consumes the serial line without emitting.
    | { op: "skip"; serial: SigLine };

function sigLines(lines: string[]): SigLine[] {
    return lines.reduce<SigLine[]>((acc, line, i) => {
        if (line.trim() !== "") acc.push({ text: line, lineIdx: i });
        return acc;
    }, []);
}

/** LCS edit script over significant lines (normalized comparison). */
function computeEditScript(saved: string, serialized: string): {
    edits: Edit[];
    savedLines: string[];
    serialLines: string[];
} {
    const savedLines = saved.split("\n");
    const serialLines = serialized.split("\n");
    const savedSig = sigLines(savedLines);
    const serialSig = sigLines(serialLines);
    const n = savedSig.length;
    const m = serialSig.length;

    const savedNorm = savedSig.map((l) => normLineForCompare(l.text));
    const serialNorm = serialSig.map((l) => normLineForCompare(l.text));

    // LCS dp (Uint16Array bounds memory; typical md files stay far below
    // 65535 significant lines)
    const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = 1; i <= n; i++)
        for (let j = 1; j <= m; j++)
            dp[i][j] = savedNorm[i - 1] === serialNorm[j - 1]
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);

    const edits: Edit[] = [];
    let i = n, j = m;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && savedNorm[i - 1] === serialNorm[j - 1]) {
            edits.unshift({ op: "keep", saved: savedSig[i - 1], serial: serialSig[j - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            edits.unshift({ op: "ins", serial: serialSig[j - 1] });
            j--;
        } else {
            edits.unshift({ op: "del", saved: savedSig[i - 1] });
            i--;
        }
    }
    return { edits, savedLines, serialLines };
}

// ─── Round-trip protection ──────────────────────────────────────────────────

/**
 * One contiguous run of changes produced by a ZERO-EDIT round trip: the
 * parser/serializer pair rewrote `delNorms` (saved lines) into `insNorms`
 * (serializer lines) — or dropped them outright when `insNorms` is empty —
 * without any user involvement.
 */
interface BaselineRegion {
    delNorms: string[];
    insNorms: string[];
}

export interface RoundTripProtection {
    regions: BaselineRegion[];
}

/**
 * Compare the saved file against its own zero-edit serialization and record
 * every change region. Each region is a construct the editor cannot
 * round-trip faithfully; `applyMinimalChanges` uses the result to pin those
 * regions to their saved bytes on every save.
 *
 * Returns null when the file round-trips cleanly (nothing to protect).
 */
export function computeRoundTripProtection(
    saved: string,
    baselineSerialized: string,
): RoundTripProtection | null {
    const { edits } = computeEditScript(saved, baselineSerialized);
    const regions: BaselineRegion[] = [];
    let current: BaselineRegion | null = null;

    for (const edit of edits) {
        if (edit.op === "keep") {
            current = null;
        } else if (edit.op === "del" || edit.op === "ins") {
            if (!current) {
                current = { delNorms: [], insNorms: [] };
                regions.push(current);
            }
            if (edit.op === "del") current.delNorms.push(normLineForCompare(edit.saved.text));
            else current.insNorms.push(normLineForCompare(edit.serial.text));
        }
    }
    return regions.length > 0 ? { regions } : null;
}

/** Remove one occurrence of each `wanted` value from `pool` (by index into
 * pool; entries already consumed are null). Returns the matched indices, or
 * null if any value is missing. */
function matchSubMultiset(pool: (string | null)[], wanted: string[]): number[] | null {
    const used = new Set<number>();
    const picked: number[] = [];
    for (const w of wanted) {
        let found = -1;
        for (let k = 0; k < pool.length; k++) {
            if (!used.has(k) && pool[k] === w) { found = k; break; }
        }
        if (found === -1) return null;
        used.add(found);
        picked.push(found);
    }
    return picked;
}

/**
 * Rewrite the edit script so that baseline (parser-artifact) changes never
 * reach the file: within each contiguous run of non-keep edits, any baseline
 * region whose dels AND inses are all present is neutralized — its dels
 * become pins (saved text kept verbatim) and its inses become skips
 * (serializer replacement swallowed).
 *
 * A construct the user actually edited no longer matches its baseline region
 * (the serializer output differs), so the edit applies normally and adopts
 * the canonical form — exactly the existing minimal-diff philosophy, extended
 * from formatting to parsability.
 */
function applyProtection(edits: Edit[], protection: RoundTripProtection): Edit[] {
    const out: Edit[] = [];
    const consumed = new Set<BaselineRegion>();

    let runStart = -1;
    const flushRun = (end: number) => {
        if (runStart === -1) return;
        const run = edits.slice(runStart, end);
        const delIdx: number[] = [];
        const insIdx: number[] = [];
        run.forEach((e, k) => {
            if (e.op === "del") delIdx.push(k);
            else if (e.op === "ins") insIdx.push(k);
        });
        const delNorms: (string | null)[] = delIdx.map((k) => normLineForCompare((run[k] as Extract<Edit, { op: "del" }>).saved.text));
        const insNorms: (string | null)[] = insIdx.map((k) => normLineForCompare((run[k] as Extract<Edit, { op: "ins" }>).serial.text));

        for (const region of protection.regions) {
            if (consumed.has(region)) continue;
            const delPick = matchSubMultiset(delNorms, region.delNorms);
            if (!delPick) continue;
            const insPick = matchSubMultiset(insNorms, region.insNorms);
            if (!insPick) continue;
            consumed.add(region);
            for (const p of delPick) {
                const e = run[delIdx[p]] as Extract<Edit, { op: "del" }>;
                run[delIdx[p]] = { op: "pin", saved: e.saved };
                delNorms[p] = null; // consumed - never matches again
            }
            for (const p of insPick) {
                const e = run[insIdx[p]] as Extract<Edit, { op: "ins" }>;
                run[insIdx[p]] = { op: "skip", serial: e.serial };
                insNorms[p] = null;
            }
        }
        out.push(...run);
        runStart = -1;
    };

    for (let k = 0; k < edits.length; k++) {
        if (edits[k].op === "keep") {
            flushRun(k);
            out.push(edits[k]);
        } else if (runStart === -1) {
            runStart = k;
        }
    }
    flushRun(edits.length);
    return out;
}

// ─── Minimal-diff merge ─────────────────────────────────────────────────────

/**
 * Merge `serialized` (the full serializer output) into `saved` (the file as
 * last written), applying only real content changes:
 *
 * - Blank lines never participate in the diff. Between two lines that are
 *   unchanged or edited in place, the saved file's blank lines are kept
 *   verbatim — the user's spacing wins.
 * - Around insertions and deletions the blank lines are taken from the
 *   serializer output — the serializer's canonical spacing wins. This is what
 *   makes a new paragraph arrive together with its blank separator, and a
 *   deleted paragraph take its separator away with it.
 * - Formatting-only differences (table dash widths / cell padding, split
 *   strong runs, fence-language spacing) compare as equal and are never
 *   applied.
 * - With `protection` (from `computeRoundTripProtection`), changes the
 *   round trip produces on its own — dropped reference definitions, setext →
 *   ATX rewrites, escaping churn — are pinned to their saved bytes instead of
 *   being applied.
 *
 * Returns `saved` (same reference) when nothing changed.
 */
export function applyMinimalChanges(
    saved: string,
    serialized: string,
    protection?: RoundTripProtection | null,
): string {
    const { edits: rawEdits, savedLines, serialLines } = computeEditScript(saved, serialized);
    const edits = protection ? applyProtection(rawEdits, protection) : rawEdits;

    if (!edits.some((e) => e.op === "del" || e.op === "ins")) return saved;

    // Rebuild the file. Walk the edit script emitting one significant line at
    // a time, choosing where the blank lines before it come from:
    // - `dirty` false (no structural edit since the last emitted line): copy
    //   the saved file's blank run — preserves the user's spacing exactly.
    // - `dirty` true (an insertion or deletion happened here): copy the
    //   serializer's blank run — canonical spacing for the edited region.
    const out: string[] = [];
    let prevSavedIdx = -1; // saved lineIdx of the last consumed saved line
    let prevSerialIdx = -1; // serialized lineIdx of the last consumed serial line
    let dirty = false;

    // Both gap slices only ever span blank lines: significant lines are
    // consumed strictly in order on each side (dels and pins included), so
    // the region between two consecutively consumed ones contains no
    // significant line.
    const savedGap = (to: number) => savedLines.slice(prevSavedIdx + 1, to);
    const serialGap = (to: number) => serialLines.slice(prevSerialIdx + 1, to);

    let e = 0;
    while (e < edits.length) {
        const edit = edits[e];
        const next = edits[e + 1];
        if (edit.op === "keep") {
            out.push(...(dirty ? serialGap(edit.serial.lineIdx) : savedGap(edit.saved.lineIdx)));
            out.push(edit.saved.text);
            prevSavedIdx = edit.saved.lineIdx;
            prevSerialIdx = edit.serial.lineIdx;
            dirty = false;
            e++;
        } else if (edit.op === "pin") {
            // Protected line: emit the saved bytes with the saved file's own
            // preceding blank run — the construct and its spacing survive
            // exactly as written.
            out.push(...savedGap(edit.saved.lineIdx));
            out.push(edit.saved.text);
            prevSavedIdx = edit.saved.lineIdx;
            e++;
        } else if (edit.op === "skip") {
            // Swallow the serializer's replacement for a pinned construct.
            prevSerialIdx = edit.serial.lineIdx;
            e++;
        } else if (edit.op === "del" && next?.op === "ins") {
            // del immediately followed by ins = an in-place replacement: the
            // line changed but its surroundings did not, so the saved spacing
            // around it is kept.
            out.push(...(dirty ? serialGap(next.serial.lineIdx) : savedGap(edit.saved.lineIdx)));
            out.push(next.serial.text);
            prevSavedIdx = edit.saved.lineIdx;
            prevSerialIdx = next.serial.lineIdx;
            dirty = false;
            e += 2;
        } else if (edit.op === "del") {
            prevSavedIdx = edit.saved.lineIdx;
            dirty = true;
            e++;
        } else {
            // Pure insertion: it has no position in the saved file, so its
            // spacing (before and after) can only come from the serializer.
            out.push(...serialGap(edit.serial.lineIdx));
            out.push(edit.serial.text);
            prevSerialIdx = edit.serial.lineIdx;
            dirty = true;
            e++;
        }
    }

    // Trailing region after the last significant line (blank lines and the
    // final newline — or its absence).
    out.push(...(dirty ? serialLines.slice(prevSerialIdx + 1) : savedLines.slice(prevSavedIdx + 1)));

    const result = out.join("\n");
    return result === saved ? saved : result;
}
