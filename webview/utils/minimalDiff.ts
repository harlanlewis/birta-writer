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
 * in the file would silently apply them on save. Protection repairs the
 * serializer output back to the saved bytes before the diff; if the user
 * edits the construct itself, the repair no longer matches and the edit
 * applies normally — the existing minimal-diff philosophy, extended from
 * formatting to parsability.
 *
 * The diff/protection/merge ENGINE is format-agnostic and lives in
 * `@birta/minimal-diff` (packages/minimal-diff). This module is markdown's
 * `FormatProfile` — the line classifier, the comparison normalizers, and the
 * blank-line structure predicates — plus the profile-bound public API the
 * rest of the webview consumes. A future second format (the multiformat
 * track, MAR-40/41) supplies its own profile to the same engine.
 */
import {
    applyMinimalChanges as applyMinimalChangesCore,
    computeRoundTripProtection as computeRoundTripProtectionCore,
    type FormatProfile,
    type RoundTripProtection,
} from "@birta/minimal-diff";

export type { RoundTripProtection };

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
// link `[x](y)` vs escaped literal `\[x](y)`) can never false-match. The
// same regex defines "an org cookie" for the whole-document serializer
// post-pass below (unescapeOrgCookies) — one regex, one definition, both
// layers.
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

// ─── Blank-line structure predicates (merge hooks) ──────────────────────────

// A blockquote marker allows at most 3 leading spaces; 4+ is an indented
// code block, where a leading `>` is literal text, not quote structure.
const isQuoteLine = (s: string): boolean => /^ {0,3}>/.test(s);

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
// This is the M1 dual rule (MAR-161).
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

// ─── The markdown FormatProfile, and the profile-bound public API ───────────

const markdownProfile: FormatProfile = {
    keyLines(lines) {
        const classes = classifyLines(lines);
        return lines.map((line, i) =>
            line.trim() === "" ? "" : normLineForCompare(line, classes[i]),
        );
    },
    glueChangesConstruct,
    // A blank line between two quote-context (`>`-prefixed) lines SPLITS the
    // quote block. When the saved spacing would introduce such a split yet
    // the serializer kept the two lines contiguous, the blank was a block
    // separator the edit dissolved (e.g. a block moving between callouts
    // merges two quotes into one) — MAR-122.
    blankSplitsBlock: (prev, next) => isQuoteLine(prev) && isQuoteLine(next),
};

/** `applyMinimalChanges` with markdown's profile bound (see the engine in
 * `@birta/minimal-diff` for the merge contract). */
export function applyMinimalChanges(
    saved: string,
    serialized: string,
    protection?: RoundTripProtection | null,
): string {
    return applyMinimalChangesCore(saved, serialized, markdownProfile, protection);
}

/** `computeRoundTripProtection` with markdown's profile bound. */
export function computeRoundTripProtection(
    saved: string,
    baselineSerialized: string,
): RoundTripProtection | null {
    return computeRoundTripProtectionCore(saved, baselineSerialized, markdownProfile);
}
