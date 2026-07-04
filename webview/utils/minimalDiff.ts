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
 * `computeRoundTripProtection`): constructs the parser cannot reproduce are
 * dropped or rewritten by a zero-edit round trip (setext headings become
 * ATX, `* _ [` get escaped, quoted-title link definitions change quote
 * style, ...). Those changes appear in every serialization even though the
 * user never touched the lines, so without protection a keystroke elsewhere
 * in the file would silently apply them on save.
 *
 * Protection is applied by REPAIRING the serializer output before the diff:
 * each region's canonical replacement lines are swapped back for the
 * original saved bytes (and dropped constructs are re-inserted next to
 * their anchors). The repaired text then diffs against the saved file with
 * the plain merge — protected lines become ordinary `keep`s, so ordering
 * and blank-line handling need no special cases. If the user edits the
 * construct itself, its serialized form no longer matches the recorded
 * canonical lines, no repair happens, and the edit applies normally: the
 * canonical form wins on touched lines — the existing minimal-diff
 * philosophy, extended from formatting to parsability.
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
    | { op: "ins"; serial: SigLine };

function sigLines(lines: string[]): SigLine[] {
    return lines.reduce<SigLine[]>((acc, line, i) => {
        if (line.trim() !== "") acc.push({ text: line, lineIdx: i });
        return acc;
    }, []);
}

/**
 * LCS edit script over significant lines (normalized comparison).
 *
 * The common prefix and suffix are peeled off before the DP: a typical edit
 * touches one small region of the document, so this turns the quadratic LCS
 * into a scan plus a DP over just the changed window (a 5000-line document
 * costs milliseconds per keystroke instead of hundreds of them).
 */
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

    // Peel the common prefix / suffix (greedy keep-pairing of equal lines is
    // always LCS-optimal).
    let lo = 0;
    while (lo < n && lo < m && savedNorm[lo] === serialNorm[lo]) lo++;
    let hiS = n - 1;
    let hiT = m - 1;
    while (hiS >= lo && hiT >= lo && savedNorm[hiS] === serialNorm[hiT]) {
        hiS--;
        hiT--;
    }

    const edits: Edit[] = [];
    for (let k = 0; k < lo; k++) {
        edits.push({ op: "keep", saved: savedSig[k], serial: serialSig[k] });
    }

    // LCS dp over the middle window only (Uint16Array bounds memory; typical
    // windows are tiny after trimming)
    const wn = hiS - lo + 1;
    const wm = hiT - lo + 1;
    if (wn > 0 || wm > 0) {
        const dp: Uint16Array[] = Array.from({ length: wn + 1 }, () => new Uint16Array(wm + 1));
        for (let i = 1; i <= wn; i++)
            for (let j = 1; j <= wm; j++)
                dp[i][j] = savedNorm[lo + i - 1] === serialNorm[lo + j - 1]
                    ? dp[i - 1][j - 1] + 1
                    : Math.max(dp[i - 1][j], dp[i][j - 1]);

        const middle: Edit[] = [];
        let i = wn, j = wm;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && savedNorm[lo + i - 1] === serialNorm[lo + j - 1]) {
                middle.unshift({ op: "keep", saved: savedSig[lo + i - 1], serial: serialSig[lo + j - 1] });
                i--; j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                middle.unshift({ op: "ins", serial: serialSig[lo + j - 1] });
                j--;
            } else {
                middle.unshift({ op: "del", saved: savedSig[lo + i - 1] });
                i--;
            }
        }
        edits.push(...middle);
    }

    for (let k = hiS + 1; k < n; k++) {
        const tK = hiT + 1 + (k - hiS - 1);
        edits.push({ op: "keep", saved: savedSig[k], serial: serialSig[tK] });
    }

    return { edits, savedLines, serialLines };
}

// ─── Round-trip protection ──────────────────────────────────────────────────

/**
 * One construct a ZERO-EDIT round trip cannot reproduce.
 *
 * `savedSpanLines` are the construct's original raw lines (from the first to
 * the last changed saved line, internal blanks included). `insNorms` are the
 * normalized canonical lines the serializer emits in its place — the repair
 * pass finds them in later serializations and swaps the original bytes back
 * in. When `insNorms` is empty the construct is dropped outright, and the
 * anchors (normalized nearest kept lines at baseline) position the
 * re-insertion instead.
 */
interface ProtectedRegion {
    savedSpanLines: string[];
    insNorms: string[];
    anchorPrevNorm: string | null;
    anchorNextNorm: string | null;
}

export interface RoundTripProtection {
    regions: ProtectedRegion[];
}

/**
 * Compare the saved file against its own zero-edit serialization and record
 * every change region. Each region is a construct the editor cannot
 * round-trip faithfully; `applyMinimalChanges` uses the result to repair
 * later serializations back to the saved bytes.
 *
 * Returns null when the file round-trips cleanly (nothing to protect).
 */
export function computeRoundTripProtection(
    saved: string,
    baselineSerialized: string,
): RoundTripProtection | null {
    const { edits, savedLines } = computeEditScript(saved, baselineSerialized);
    if (!edits.some((e) => e.op !== "keep")) return null;

    // Self-check: protection must reproduce the saved bytes exactly when the
    // serializer output is the baseline itself. The per-construct split
    // pairs del/ins adjacency groups positionally, which can mis-pair exotic
    // runs (e.g. a dropped construct sharing a run with a construct whose
    // canonical form has a different line count) — repairing with wrong
    // bytes is worse than canonicalization, so fall back to the fused
    // region, and if even that cannot reproduce the baseline, ship no
    // protection at all.
    for (const allowSplit of [true, false]) {
        const regions = buildProtectedRegions(edits, savedLines, allowSplit);
        if (regions.length === 0) return null;
        const protection = { regions };
        if (applyMinimalChanges(saved, baselineSerialized, protection) === saved) {
            return protection;
        }
    }
    return null;
}

/** Build protected regions from a baseline edit script. */
function buildProtectedRegions(
    edits: Edit[],
    savedLines: string[],
    allowSplit: boolean,
): ProtectedRegion[] {
    const regions: ProtectedRegion[] = [];

    // Collect contiguous non-keep runs together with their surrounding keeps.
    let k = 0;
    while (k < edits.length) {
        if (edits[k].op === "keep") { k++; continue; }
        const start = k;
        while (k < edits.length && edits[k].op !== "keep") k++;
        const run = edits.slice(start, k);
        const dels = run.filter((e): e is Extract<Edit, { op: "del" }> => e.op === "del");
        const inses = run.filter((e): e is Extract<Edit, { op: "ins" }> => e.op === "ins");
        if (dels.length === 0) continue; // pure insertion at baseline: nothing to preserve

        const prevKeep = start > 0 ? (edits[start - 1] as Extract<Edit, { op: "keep" }>) : null;
        const nextKeep = k < edits.length ? (edits[k] as Extract<Edit, { op: "keep" }>) : null;
        const anchorPrevNorm = prevKeep ? normLineForCompare(prevKeep.saved.text) : null;
        const anchorNextNorm = nextKeep ? normLineForCompare(nextKeep.saved.text) : null;

        // Split the run into per-construct sub-regions when both sides break
        // into the same number of adjacency groups (consecutive line numbers
        // = one construct). Two setext headings changed in one run otherwise
        // become an all-or-nothing region: editing one would unprotect both.
        const delGroups = groupByAdjacency(dels.map((d) => d.saved));
        const insGroups = inses.length > 0 ? groupByAdjacency(inses.map((i) => i.serial)) : [];
        const pairable = allowSplit && insGroups.length > 0 && delGroups.length === insGroups.length;
        const subRegions = pairable
            ? delGroups.map((dg, gi) => ({ delSpan: dg, insSpan: insGroups[gi] }))
            : [{ delSpan: dels.map((d) => d.saved), insSpan: inses.map((i) => i.serial) }];

        for (const sub of subRegions) {
            const first = sub.delSpan[0].lineIdx;
            const last = sub.delSpan[sub.delSpan.length - 1].lineIdx;
            regions.push({
                savedSpanLines: savedLines.slice(first, last + 1),
                insNorms: sub.insSpan.map((s) => normLineForCompare(s.text)),
                anchorPrevNorm,
                anchorNextNorm,
            });
        }
    }
    return regions;
}

/** Group significant lines into runs of consecutive lineIdx values. */
function groupByAdjacency(lines: SigLine[]): SigLine[][] {
    const groups: SigLine[][] = [];
    for (const line of lines) {
        const last = groups[groups.length - 1];
        if (last && line.lineIdx === last[last.length - 1].lineIdx + 1) last.push(line);
        else groups.push([line]);
    }
    return groups;
}

/**
 * Swap each protected region's canonical serializer output back for the
 * original saved bytes. Regions whose canonical lines are absent (the user
 * edited or removed the construct) are left alone — the edit applies.
 */
function repairSerialized(serialized: string, protection: RoundTripProtection): string {
    let lines = serialized.split("\n");

    // Matching walks left to right so repeated identical constructs map to
    // their occurrences in document order.
    let cursor = 0;
    for (const region of protection.regions) {
        const sig = sigLines(lines);
        const norms = sig.map((l) => normLineForCompare(l.text));

        if (region.insNorms.length > 0) {
            // Score every candidate occurrence by how well its neighborhood
            // matches the construct's recorded anchors, and require at least
            // one anchor hit. This keeps a canonical-form TWIN elsewhere in
            // the document (e.g. a genuine `# Title` next to a protected
            // setext `Title/====`) from being mistaken for the construct
            // when the construct itself was edited or removed.
            const len = region.insNorms.length;
            let best = -1;
            let bestScore = 0;
            for (
                let at = findContiguous(norms, region.insNorms, cursorSigIndex(sig, cursor));
                at !== -1;
                at = findContiguous(norms, region.insNorms, at + 1)
            ) {
                const prevOk = region.anchorPrevNorm === null
                    ? at === 0
                    : norms[at - 1] === region.anchorPrevNorm;
                const nextOk = region.anchorNextNorm === null
                    ? at + len === norms.length
                    : norms[at + len] === region.anchorNextNorm;
                const score = (prevOk ? 1 : 0) + (nextOk ? 1 : 0);
                if (score > bestScore) { best = at; bestScore = score; }
                if (score === 2) break; // cannot be beaten; first wins ties
            }
            if (best === -1) continue; // construct edited/removed by the user
            const firstRaw = sig[best].lineIdx;
            const lastRaw = sig[best + len - 1].lineIdx;
            lines = [
                ...lines.slice(0, firstRaw),
                ...region.savedSpanLines,
                ...lines.slice(lastRaw + 1),
            ];
            cursor = firstRaw + region.savedSpanLines.length;
        } else {
            // Dropped construct: re-insert next to its anchor. Prefer the
            // anchorPrev occurrence that is directly followed by anchorNext
            // (they were adjacent at baseline), so a duplicate of the anchor
            // line elsewhere cannot attract the construct.
            let rawAt = -1;
            if (region.anchorPrevNorm !== null) {
                let fallback = -1;
                for (
                    let i = norms.indexOf(region.anchorPrevNorm, cursorSigIndex(sig, cursor));
                    i !== -1;
                    i = norms.indexOf(region.anchorPrevNorm, i + 1)
                ) {
                    if (fallback === -1) fallback = i;
                    const nextOk = region.anchorNextNorm === null
                        ? i === norms.length - 1
                        : norms[i + 1] === region.anchorNextNorm;
                    if (nextOk) { fallback = i; break; }
                }
                if (fallback !== -1) rawAt = sig[fallback].lineIdx + 1;
            } else if (region.anchorNextNorm === null) {
                rawAt = 0; // construct was the whole document
            } else {
                // Construct opened the document: insert before anchorNext if
                // it survives (a new first paragraph must stay first).
                const i = norms.indexOf(region.anchorNextNorm, cursorSigIndex(sig, cursor));
                rawAt = i !== -1 ? sig[i].lineIdx : 0;
            }
            if (rawAt === -1 && region.anchorNextNorm !== null) {
                const i = norms.indexOf(region.anchorNextNorm, cursorSigIndex(sig, cursor));
                if (i !== -1) rawAt = sig[i].lineIdx;
            }
            // Both anchors gone (surrounding content rewritten): keep the
            // construct anyway, at the end — data loss is never acceptable.
            if (rawAt === -1) {
                rawAt = lines.length - countTrailingBlanks(lines);
            }
            // Blank-separate the construct from significant neighbors on
            // either side (never at the document edge, never doubled).
            const insertion = [...region.savedSpanLines];
            if (rawAt > 0 && lines[rawAt - 1].trim() !== "") insertion.unshift("");
            if (rawAt < lines.length && lines[rawAt].trim() !== "") insertion.push("");
            lines = [...lines.slice(0, rawAt), ...insertion, ...lines.slice(rawAt)];
            cursor = rawAt + insertion.length;
        }
    }
    return lines.join("\n");
}

/** Index of the first significant line at or after raw line `cursor`. */
function cursorSigIndex(sig: SigLine[], cursor: number): number {
    for (let i = 0; i < sig.length; i++) if (sig[i].lineIdx >= cursor) return i;
    return sig.length;
}

/** First index at or after `from` where `needle` matches contiguously. */
function findContiguous(haystack: string[], needle: string[], from: number): number {
    outer: for (let i = Math.max(0, from); i + needle.length <= haystack.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
}

function countTrailingBlanks(lines: string[]): number {
    let c = 0;
    for (let i = lines.length - 1; i >= 0 && lines[i].trim() === ""; i--) c++;
    return c;
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
 *   round trip produces on its own — rewritten setext headings, escaping
 *   churn, dropped constructs — are repaired back to their saved bytes
 *   before the diff, so they merge as ordinary unchanged lines.
 *
 * Returns `saved` (same reference) when nothing changed.
 */
export function applyMinimalChanges(
    saved: string,
    serialized: string,
    protection?: RoundTripProtection | null,
): string {
    const effective = protection ? repairSerialized(serialized, protection) : serialized;
    const { edits, savedLines, serialLines } = computeEditScript(saved, effective);

    if (!edits.some((e) => e.op !== "keep")) return saved;

    // Rebuild the file. Walk the edit script emitting one significant line at
    // a time, choosing where the blank lines before it come from:
    // - `dirty` false (no structural edit since the last emitted line): copy
    //   the saved file's blank run — preserves the user's spacing exactly.
    // - `dirty` true (an insertion or deletion happened here): copy the
    //   serializer's blank run — canonical spacing for the edited region.
    const out: string[] = [];
    let prevSavedIdx = -1; // saved lineIdx of the last emitted keep/replacement
    let prevSerialIdx = -1; // serialized lineIdx of the last emitted line
    let dirty = false;

    // Both gap slices only ever span blank lines: significant lines are
    // consumed strictly in order on each side, so the region between two
    // consecutively consumed ones contains no significant line.
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
