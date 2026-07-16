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

// ─── Line classification (MAR-161) ──────────────────────────────────────────
//
// The comparison normalizers below are construct-specific: a thematic-break
// key must only ever be produced by a line that PARSES as a thematic break.
// Line bytes alone cannot tell — `***` is an hr in prose, verbatim text
// inside a fence, and a code line when tab-indented; a solid dash run is an
// hr on its own but a setext underline when attached to the paragraph above.
// Feeding all of them through the same normalizers let the diff keep-pair
// lines across constructs (a saved `\t***` code line against a real hr),
// which mis-anchored the edit script badly enough to fail protection's
// self-check — and a null protection means a ZERO-EDIT save rewrites the
// file. So every line is classified once, in context, and each class gets
// only the normalization that is meaning-preserving for it. Non-prose keys
// carry a `\x00`-prefixed tag so no cross-class pair can ever compare equal.
//
// The classifier is an approximation of the block parser, not a replica —
// what matters is that saved and serialized text classify CONSISTENTLY
// (identical neighborhoods yield identical classes) and that no two
// different constructs share a key. A deliberately unhandled case: indented
// code nested deep inside a list item still classifies as prose (list
// context wins for indent-candidates following a list-marker line) — the
// pre-classifier status quo, kept because Logseq outlines (MAR-131) indent
// their entire block tree with tabs and MUST stay depth-normalized.

type LineClass =
    | "prose"
    // Content of a fence opened at column 0: verbatim user bytes, compared
    // raw — a whitespace-only tab↔space edit in a Makefile fence is a real
    // edit and must register as one.
    | "fence-raw"
    // Content of an INDENTED fence (a fence nested in a list/outline): the
    // leading indentation is outline structure the serializer legitimately
    // re-emits as spaces (MAR-131), so it stays depth-normalized. The cost —
    // a whitespace-only tab↔space edit of the leading indent inside such a
    // fence reads as no edit — is confined to nested fences.
    | "fence-nested"
    // An indented code block line: verbatim user bytes, compared raw.
    | "code"
    // A solid dash run attached to the paragraph line above it — a setext
    // underline, NOT a thematic break. Compared as ordinary prose (raw dash
    // bytes), so it can never be "repaired" into a saved hr (the M2 dash
    // residual: same marker char, different construct).
    | "setext";

/** Leading-whitespace width in columns, tabs expanding to the next multiple
 * of 4 (the CommonMark tab stop). */
function leadingColumns(line: string): number {
    let col = 0;
    for (const ch of line) {
        if (ch === " ") col++;
        else if (ch === "\t") col += 4 - (col % 4);
        else break;
    }
    return col;
}

const LIST_MARKER_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const SETEXT_DASH_RE = /^ {0,3}-+[ \t]*$/;
const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const QUOTE_MARKER_RE = /^ {0,3}>/;
/** A code-fence open/close marker run, matched against a trimStart'd line. */
const FENCE_LINE_RE = /^(`{3,}|~{3,})/;

/** Classify every line of a document in one contextual pass. Blank lines are
 * insignificant to the diff and classify as prose. */
function classifyLines(lines: string[]): LineClass[] {
    const classes: LineClass[] = new Array(lines.length);
    let fence: { marker: string; nested: boolean } | null = null;
    let prevNonBlank: { text: string; cls: LineClass } | null = null;
    let blankBefore = true; // document start behaves like after-a-blank
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "") {
            classes[i] = "prose";
            blankBefore = true;
            continue;
        }
        let cls: LineClass = "prose";
        const t = line.trimStart();
        const f = FENCE_LINE_RE.exec(t);
        if (fence) {
            const closes =
                f !== null &&
                f[1][0] === fence.marker[0] &&
                f[1].length >= fence.marker.length &&
                t.slice(f[1].length).trim() === "";
            if (closes) {
                fence = null; // the close line itself compares as prose
            } else {
                cls = fence.nested ? "fence-nested" : "fence-raw";
            }
        } else if (f) {
            fence = { marker: f[1], nested: /^[ \t]/.test(line) };
        } else if (leadingColumns(line) >= 4) {
            // Indented-code candidate. It is code when it opens a block
            // outside a list context — after a blank, at document start, or
            // glued to a line that TERMINATES its own block (a fence line,
            // heading, or hr cannot lazily absorb it) — or continues a code
            // block. Attached to an absorbing line it is a lazy
            // continuation; following a list-marker line or any indented
            // line it is (or plausibly is) list/outline content — both
            // prose (the Logseq outline case, MAR-131).
            if (prevNonBlank === null || prevNonBlank.cls === "code") {
                cls = "code";
            } else if (
                !LIST_MARKER_RE.test(prevNonBlank.text) &&
                leadingColumns(prevNonBlank.text) === 0 &&
                (blankBefore ||
                    ATX_HEADING_RE.test(prevNonBlank.text) ||
                    THEMATIC_BREAK_RE.test(prevNonBlank.text) ||
                    FENCE_LINE_RE.test(prevNonBlank.text.trimStart()))
            ) {
                cls = "code";
            }
        } else if (
            SETEXT_DASH_RE.test(line) &&
            !blankBefore &&
            prevNonBlank !== null &&
            prevNonBlank.cls === "prose" &&
            // The line above must be able to BE a paragraph: after a heading,
            // an hr, a list marker, a quote marker, or a table row, a dash
            // run is not an underline (misclassifying those would spawn
            // needless protection regions, since the serializer
            // blank-separates real hrs).
            !THEMATIC_BREAK_RE.test(prevNonBlank.text) &&
            !ATX_HEADING_RE.test(prevNonBlank.text) &&
            !LIST_MARKER_RE.test(prevNonBlank.text) &&
            !QUOTE_MARKER_RE.test(prevNonBlank.text) &&
            !TABLE_ROW_RE.test(prevNonBlank.text.trim())
        ) {
            cls = "setext";
        }
        classes[i] = cls;
        prevNonBlank = { text: line, cls };
        blankBefore = false;
    }
    return classes;
}

// ─── Comparison normalizers ─────────────────────────────────────────────────

const SEP_ROW_RE = /^\|[\s\-:|]+\|$/;
const TABLE_ROW_RE = /^\|.*\|$/;
// A line that is nothing but a thematic break: three or more of a single
// `*`/`_`/`-` marker, optionally separated by spaces (`***`, `___`, `- - -`,
// `-----`). Source-style preservation (MAR-16) keeps the original marker, but
// this normalizer still collapses breaks that differ only in repetition count
// or spacing so a legacy `- - -` save compares equal to a freshly preserved
// `---` and never churns. The key preserves the marker CHARACTER and is
// tagged (`\x00B`) so it can never collide with raw line bytes: `-` runs are
// also setext underlines, and an untagged `---` key equals a literal `---`
// underline byte-for-byte (MAR-161 M2 and its dash residual). Setext
// underlines themselves classify as "setext" and never reach this branch.
const THEMATIC_BREAK_RE = /^\s{0,3}([*_-])[ \t]*(\1[ \t]*){2,}$/;

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

// Normalize adjacent strong runs: `**a** **b**` → `**a b**`. Milkdown's
// stock serializer split a strong node into two `**...**` runs when it
// contained a link child; the fidelity serializer
// (plugins/fidelitySerializer.ts) no longer does, but files saved by older
// builds still contain the split form, which is semantically identical.
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

// Normalize whole-link emphasis to the emphasis-inside canonical form:
// `**[x](u)**` → `[**x**](u)` (same for `*…*`, `~~…~~`, `***…***`). The
// fidelity serializer opens link marks outermost, so a fully emphasized link
// re-serializes with the emphasis INSIDE the link text — semantically
// identical to the wrapped form saved by older builds or written by hand.
// Applied AFTER normalizeSplitStrong so that legacy split runs like
// `**a** **[l](u)** **b**` first merge into `**a [l](u) b**` (which this
// rewrite then correctly leaves alone: the markers are not flush against
// the link).
function normalizeWrappedLinkEmphasis(line: string): string {
    // Fixpoint: stacked wrappers (`**~~[x](u)~~**`) unwrap one layer per
    // pass until the emphasis-inside form is reached.
    let prev: string;
    do {
        prev = line;
        line = line.replace(
            /(\*{1,3}|~~)\[([^\]]*)\]\(([^)]*)\)\1/g,
            "[$1$2$1]($3)",
        );
    } while (line !== prev);
    return line;
}

// Normalize a table data row: strip cell padding, treat a lone `<br />` as an
// empty cell (older saves wrote empty cells as `<br />`), and canonicalize the
// `<br>` / `<br/>` / `<br />` line-break spellings within cell text (MAR-17) so
// a lost or changed variant attr degrades to no churn instead of a spurious
// diff. `| fruit   |  price  |` → `|fruit|price|`
function normalizeTableDataRow(line: string): string {
    const t = line.trim();
    const cells = t.split("|").slice(1, -1).map((c) => {
        const v = c.trim();
        // Legacy: an empty table cell used to be saved as the exact bytes
        // `<br />`. Kept before canonicalization so it still collapses to "".
        if (v === "<br />") return "";
        return v.replace(/<br\s*\/?>/gi, "<br>");
    });
    return "|" + cells.join("|") + "|";
}

// Normalize a fence opening line: ``` javascript → ```javascript (drop the
// space before the language token).
function normalizeFenceOpen(line: string): string {
    return line.replace(/^(\s*`{3,})\s+/, "$1");
}

// Normalize leading outline indentation: a tab is one nesting level, which
// the serializer re-emits as two spaces (Logseq graphs indent their whole
// block tree with tabs — MAR-131). DEPTH-preserving by construction: `\t\t`
// and four spaces compare equal, but `\t` never equals `\t\t`, so a genuine
// outdent still registers as an edit. Applies to prose and to NESTED-fence
// content ("fence-nested"): inside a Logseq bullet the fence's content lines
// carry the same list indentation, and skipping them would re-open the churn
// this exists to close. The residual cost is confined to nested fences: a
// whitespace-ONLY edit swapping a leading tab for exactly two spaces (or the
// reverse, any per-tab multiple) there reads as no edit and keeps the saved
// bytes. Top-level fence content ("fence-raw") and indented code compare
// raw, so the same edit in a Makefile fence registers (MAR-161).
function normalizeOutlineIndent(line: string): string {
    return line.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, "  "));
}

// Unescape org-mode cookie/timestamp brackets for comparison: the serializer
// backslash-escapes `[` in prose, so a saved `[#A]` / `CLOCK: [2026-…]` /
// `[3/7]` line re-serializes as `\[…]` and would never compare equal to its
// own source (MAR-131). Deliberately shape-anchored — a priority cookie, an
// org timestamp, or a progress cookie — so a REAL construct difference (a
// link `[x](y)` vs escaped literal `\[x](y)`) can never false-match.
// Exported for the serializer's text handler (serialization.ts), which
// applies the same unescape to freshly emitted lines — one regex, one
// definition of "an org cookie", both layers.
export const ORG_COOKIE_ESCAPE_RE = /\\(\[(?:#[A-Z]|\d{4}-\d{2}-\d{2}[^\]\n]*|\d+\/\d+)\])/g;
function normalizeOrgCookieEscape(line: string): string {
    return line.replace(ORG_COOKIE_ESCAPE_RE, "$1");
}

/** CommonMark reference-label matching is case-insensitive with collapsed
 * internal whitespace. */
function normalizeRefLabel(label: string): string {
    return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Serializer post-pass (MAR-131): un-escape org-cookie brackets in a fully
 * serialized document, so an EDITED task line emits `[#A]` / `CLOCK: [ts]` /
 * `[3/7]` rather than `\[…]` (which Logseq renders as literal text,
 * destroying the token). Whole-document deliberately, not per-text-node:
 *
 *   - DEFINITION-AWARE — `[label]` with a matching reference definition
 *     anywhere in the document is a live shortcut reference, so unescaping
 *     would manufacture a link out of literal text (found by adversarial
 *     probe: `\[3/7]` + a `[3/7]: url` definition). Those keep the escape.
 *   - FENCE-AWARE — fenced-code content is verbatim user bytes; a `\[#A]`
 *     inside a fence is never touched. (The definition scan itself does not
 *     skip fences: a fence-shaped "definition" can only make this MORE
 *     conservative — an escape is kept, never wrongly dropped.)
 *
 * Applied at the single point where the whole serialized string exists
 * (fidelitySerializer's returned closure), which also covers table-cell
 * text that per-line compare normalizers never see.
 */
export function unescapeOrgCookies(markdown: string): string {
    if (!markdown.includes("\\[")) {
        return markdown;
    }
    const lines = markdown.split("\n");
    const defs = new Set<string>();
    for (const line of lines) {
        const m = /^ {0,3}\[([^\]]+)\]:/.exec(line);
        if (m) {
            defs.add(normalizeRefLabel(m[1]));
        }
    }
    let fence: string | null = null;
    return lines
        .map((line) => {
            const t = line.trimStart();
            const f = FENCE_LINE_RE.exec(t);
            if (fence) {
                if (
                    f &&
                    f[1][0] === fence[0] &&
                    f[1].length >= fence.length &&
                    t.slice(f[1].length).trim() === ""
                ) {
                    fence = null;
                }
                return line; // fence content (and its closer): verbatim
            }
            if (f) {
                fence = f[1];
                return line;
            }
            return line.replace(ORG_COOKIE_ESCAPE_RE, (whole, bracketed: string) =>
                defs.has(normalizeRefLabel(bracketed.slice(1, -1))) ? whole : bracketed,
            );
        })
        .join("\n");
}

function normLineForCompare(line: string, cls: LineClass): string {
    // Verbatim classes: raw bytes behind a class tag, so no amount of
    // byte coincidence can pair them with a prose-normalized key.
    if (cls === "fence-raw") return "\x00F" + line;
    if (cls === "fence-nested") return "\x00F" + normalizeOutlineIndent(line);
    if (cls === "code") return "\x00C" + line;
    line = normalizeOutlineIndent(line);
    const t = line.trim();
    if (SEP_ROW_RE.test(t)) return normalizeSepRow(line);
    if (TABLE_ROW_RE.test(t)) return normalizeTableDataRow(line);
    if (cls !== "setext" && THEMATIC_BREAK_RE.test(line)) {
        // Preserve the marker CHARACTER: `***` and `---` are interchangeable
        // as thematic breaks, but a `-` run is also a setext-heading
        // underline — two constructs whose meaning depends on the line
        // above. Keying them equal let the merge "repair" a moved setext
        // underline into a saved `***` hr, dissolving the heading
        // (MAR-161 M2). Same-character style runs (`- - -` vs `---`) still
        // compare equal.
        const marker = /^\s{0,3}([*_-])/.exec(line)![1];
        return "\x00B" + marker;
    }
    // A "setext" line falls through: none of the remaining normalizers can
    // touch a dash run, so its key is its raw bytes — an underline only ever
    // matches an identical underline in an identical attachment context.
    if (/^`{3,}/.test(t)) return normalizeFenceOpen(line);
    return normalizeWrappedLinkEmphasis(normalizeSplitStrong(normalizeOrgCookieEscape(line)));
}

// ─── Line diff (shared by the merge and by protection computation) ─────────

interface SigLine {
    text: string;
    lineIdx: number;
    /** Class-aware comparison key (normLineForCompare) — computed once here
     * so every consumer (the LCS, region anchors, repair matching) keys the
     * same line identically. */
    norm: string;
}

type Edit =
    | { op: "keep"; saved: SigLine; serial: SigLine }
    | { op: "del"; saved: SigLine }
    | { op: "ins"; serial: SigLine };

/** Significant (non-blank) lines with their comparison keys. Classification
 * needs the FULL line array (fence state, blank adjacency), so it happens
 * here, before blanks are dropped. */
function analyzeLines(lines: string[]): SigLine[] {
    const classes = classifyLines(lines);
    const sig: SigLine[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() !== "") {
            sig.push({ text: lines[i], lineIdx: i, norm: normLineForCompare(lines[i], classes[i]) });
        }
    }
    return sig;
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
    const savedSig = analyzeLines(savedLines);
    const serialSig = analyzeLines(serialLines);
    const n = savedSig.length;
    const m = serialSig.length;

    const savedNorm = savedSig.map((l) => l.norm);
    const serialNorm = serialSig.map((l) => l.norm);

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
        const anchorPrevNorm = prevKeep ? prevKeep.saved.norm : null;
        const anchorNextNorm = nextKeep ? nextKeep.saved.norm : null;

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
                insNorms: sub.insSpan.map((s) => s.norm),
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
    // Every region is matched against ONE analysis of the pristine
    // serialized text. Repairs swap serializer-canonical lines for saved
    // bytes, which can change the classification context of LATER lines
    // (restoring a `~~~` fence open makes the serializer's following ```
    // close line look like content of an unclosed tilde fence) — so
    // re-analyzing after each splice would invalidate the very norms the
    // regions were recorded under, the later regions would stop matching,
    // and protection's self-check would fail (null protection = the file is
    // rewritten on a zero-edit save). Raw indices found on the pristine text
    // are translated into the output through `offset`; matching walks left
    // to right with a forward-only cursor, so every later match lies beyond
    // every splice already applied.
    const pristine = serialized.split("\n");
    const sig = analyzeLines(pristine);
    const norms = sig.map((l) => l.norm);

    let lines = pristine;
    let cursor = 0; // pristine raw-line index; repeated constructs map in document order
    let offset = 0; // lines.length delta accumulated by applied splices
    for (const region of protection.regions) {

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
                ...lines.slice(0, firstRaw + offset),
                ...region.savedSpanLines,
                ...lines.slice(lastRaw + 1 + offset),
            ];
            offset += region.savedSpanLines.length - (lastRaw + 1 - firstRaw);
            cursor = lastRaw + 1;
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
                rawAt = pristine.length - countTrailingBlanks(pristine);
            }
            // Blank-separate the construct from significant neighbors on
            // either side (never at the document edge, never doubled). The
            // neighbors are read from the pristine text: an already-applied
            // splice only ever swaps a span for the saved bytes, and both
            // span endpoints are significant lines either way, so the
            // blank-or-not answer is the same.
            const insertion = [...region.savedSpanLines];
            if (rawAt > 0 && pristine[rawAt - 1].trim() !== "") insertion.unshift("");
            if (rawAt < pristine.length && pristine[rawAt].trim() !== "") insertion.push("");
            lines = [
                ...lines.slice(0, rawAt + offset),
                ...insertion,
                ...lines.slice(rawAt + offset),
            ];
            offset += insertion.length;
            cursor = rawAt;
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
 * - Formatting-only differences (table dash widths / cell padding, legacy
 *   split strong runs, whole-link emphasis vs emphasis-inside-link,
 *   fence-language spacing) compare as equal and are never applied.
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

    let prevLineText: string | null = null; // last significant line emitted
    // A blockquote marker allows at most 3 leading spaces; 4+ is an indented
    // code block, where a leading `>` is literal text, not quote structure.
    const isQuoteLine = (s: string): boolean => /^ {0,3}>/.test(s);
    const hasBlank = (lines: string[]): boolean => lines.some((l) => l.trim() === "");

    // Would gluing `next` directly under `prev` change next's block-level
    // construct? Only then is a serializer-emitted separating blank structure
    // rather than style. Two arms (both verified against the real parser):
    //   - a `:::` run cannot interrupt a paragraph, so glued to ANY
    //     absorbing line (paragraph, quote content, list-item content) it
    //     becomes a lazy continuation instead of a fence/inert prose;
    //   - a solid dash run becomes a setext underline (setext takes
    //     precedence over hr) — but ONLY under a genuine paragraph line: a
    //     quote line, list-marker line, or table row cannot be underlined
    //     (the run after them parses as an hr either way), and firing there
    //     would churn legitimately glued saved bytes.
    // Lines that terminate their own block (ATX headings, fence lines,
    // thematic breaks) absorb nothing; legitimate saved files DO glue there
    // (a heading directly above a directive), so neither arm may fire on
    // them: a zero-edit save must keep those bytes verbatim. Solid
    // `***`/`___` runs, backtick fences, headings, and list markers all
    // interrupt a paragraph, so their attachment never depends on the blank.
    const glueChangesConstruct = (prev: string, next: string): boolean => {
        if (
            /^ {0,3}(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|:{3,})/.test(prev) ||
            THEMATIC_BREAK_RE.test(prev)
        ) {
            return false;
        }
        if (/^ {0,3}:{3,}/.test(next)) return true;
        return (
            /^ {0,3}-+[ \t]*$/.test(next) &&
            !isQuoteLine(prev) &&
            !LIST_MARKER_RE.test(prev) &&
            !TABLE_ROW_RE.test(prev.trim())
        );
    };

    // The blank-line run to emit before the next significant line. Normally the
    // saved file's spacing wins on unedited lines (`dirty` false) and the
    // serializer's on edited ones — but a blank line between two quote-context
    // (`>`-prefixed) lines SPLITS the quote block. When the saved spacing would
    // introduce such a split yet the serializer kept the two lines contiguous,
    // the blank was a block separator the edit dissolved (e.g. a block moving
    // between callouts merges two quotes into one), so keeping it would reopen
    // the merged block split in two. Defer to the serializer's spacing in that
    // case only — a genuinely separate quote keeps its blank because the
    // serializer emits one too, so this never churns real separators (MAR-122).
    const gapBefore = (savedTo: number, serialTo: number, nextText: string): string[] => {
        if (dirty) {
            return serialGap(serialTo);
        }
        const saved = savedGap(savedTo);
        if (
            prevLineText !== null &&
            isQuoteLine(prevLineText) &&
            isQuoteLine(nextText) &&
            hasBlank(saved)
        ) {
            const serial = serialGap(serialTo);
            if (!hasBlank(serial)) {
                return serial;
            }
        }
        // The dual rule (MAR-161 M1): the serializer SEPARATES the next line
        // with a blank the saved bytes don't have. When gluing would change
        // the next line's construct (raw `:::` fence prose at a directive
        // tail, a dash run below a paragraph), the serializer's separating
        // spacing is structure, not style, so it wins. A genuinely glued
        // saved construct (a setext heading, lazy fence-prose continuation)
        // keeps its bytes because the serializer re-emits it glued too, so
        // this never churns.
        if (
            prevLineText !== null &&
            !hasBlank(saved) &&
            glueChangesConstruct(prevLineText, nextText)
        ) {
            const serial = serialGap(serialTo);
            if (hasBlank(serial)) {
                return serial;
            }
        }
        return saved;
    };

    let e = 0;
    while (e < edits.length) {
        const edit = edits[e];
        const next = edits[e + 1];
        if (edit.op === "keep") {
            out.push(...gapBefore(edit.saved.lineIdx, edit.serial.lineIdx, edit.saved.text));
            out.push(edit.saved.text);
            prevSavedIdx = edit.saved.lineIdx;
            prevSerialIdx = edit.serial.lineIdx;
            prevLineText = edit.saved.text;
            dirty = false;
            e++;
        } else if (edit.op === "del" && next?.op === "ins") {
            // del immediately followed by ins = an in-place replacement: the
            // line changed but its surroundings did not, so the saved spacing
            // around it is kept (modulo the quote-split guard in gapBefore).
            out.push(...gapBefore(edit.saved.lineIdx, next.serial.lineIdx, next.serial.text));
            out.push(next.serial.text);
            prevSavedIdx = edit.saved.lineIdx;
            prevSerialIdx = next.serial.lineIdx;
            prevLineText = next.serial.text;
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
            prevLineText = edit.serial.text;
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
