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
    type BaselineLinePair,
    type FormatProfile,
    type InsertedLine,
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
        let f = FENCE_LINE_RE.exec(t);
        // A fence may OPEN on a list-marker line (`- ```js`), which the
        // trimStart'd test above cannot see — the line starts with the marker,
        // not with backticks. Missing the opener is not a small error: the
        // scanner then reads the fence's own CLOSING line as an opener and
        // classifies the entire rest of the document as fence content, so
        // ordinary outline lines below stop being recognized as structure.
        //
        // The shape is legal CommonMark that anyone may hand-write, and since
        // MAR-230 the serializer emits it too (an item whose content is a fence
        // now rides the marker line), which is how it started biting: a fence
        // bullet moved to the top of a tab outline had the lines after it
        // treated as verbatim, so `reconcileInsertion` skipped their indent
        // lookup and wrote the serializer's spaces beside kept tabs — the moved
        // block's neighbour became its child on reopen.
        //
        // Only consulted when no fence is open: inside one, a closing run must
        // be the whole line, so a marker line can never close it.
        //
        // The `nested` flag below is deliberately NOT forced on for this case.
        // Such a fence sits at column 0, so its body indent is the marker's own
        // content column — always spaces, never the outline tabs that flag
        // exists to normalize — and no probe could produce different bytes
        // either way. An unfalsifiable branch is decoration, so there isn't one.
        if (fence === null && f === null) {
            const marker = LIST_MARKER_RE.exec(line);
            if (marker) {
                f = FENCE_LINE_RE.exec(line.slice(marker[0].length).replace(/^ {0,3}/, ""));
            }
        }
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

// Normalize ONE table cell: strip its padding, treat a lone `<br />` as an
// empty cell (older saves wrote empty cells as `<br />`), and canonicalize the
// `<br>` / `<br/>` / `<br />` line-break spellings within its text (MAR-17) so
// a lost or changed variant attr degrades to no churn instead of a spurious
// diff. Per-cell rather than inline in the row normalizer because the merge
// also compares cells one at a time, to salvage the ones an edit elsewhere in
// the row would otherwise rewrite (carrySavedTableCells, MAR-214) — one
// definition of "these two cells say the same thing", used by both.
function normalizeTableCell(cell: string): string {
    const v = cell.trim();
    // Legacy: an empty table cell used to be saved as the exact bytes
    // `<br />`. Kept before canonicalization so it still collapses to "".
    if (v === "<br />") return "";
    return v.replace(/<br\s*\/?>/gi, "<br>");
}

// Normalize a table data row: `| fruit   |  price  |` → `|fruit|price|`
function normalizeTableDataRow(line: string): string {
    const cells = line.trim().split("|").slice(1, -1).map(normalizeTableCell);
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

/**
 * Backslashes inside an angle-bracket autolink, as the serializer prints them
 * (MAR-218). Deliberately shape-anchored — a CommonMark absolute-URI autolink
 * (scheme, `:`, then no whitespace or angle brackets) — so an escaped construct
 * elsewhere can never be false-matched, exactly like `ORG_COOKIE_ESCAPE_RE`.
 *
 * The load-bearing invariant is the EVEN RUN. `mdast-util-to-markdown` escapes
 * every `\` it emits inside an autolink (`escapeBackslashes` in `state.safe`),
 * so a model backslash run of N always prints as 2N — serializer output can
 * only ever contain even-length runs there. An odd run therefore proves the
 * bytes were NOT serializer-produced, and the body pattern (`[^\s<>\\]*` gaps
 * separated by `\\` pairs) makes the whole match fail on one, leaving
 * hand-written text alone. Two lookbehinds carve out the rest:
 *
 *   - `(?<!\\)` — an escaped literal `\<https://…>` is prose, not an autolink.
 *   - `(?<!\]\()` — `[x](<url with space\\>)` is a link DESTINATION, where
 *     CommonMark backslash escapes are live and must keep their doubling.
 *
 * Inside an autolink they are inert per CommonMark, so the parser never
 * unescapes and each save doubled them again: `\` → `\\` → `\\\\` → … without
 * bound once the line had been edited.
 */
const AUTOLINK_BACKSLASH_ESCAPE_RE =
    /(?<!\\)(?<!\]\()<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>\\]*(?:\\\\[^\s<>\\]*)+)>/g;

/**
 * Split a line into segments, flagging the ones inside an inline code span.
 * Code spans are verbatim user bytes, so the autolink pass must not rewrite
 * them — and fence tracking alone doesn't see `` `<file:C:\\path>` ``.
 *
 * A backtick run opens a span that closes at the next run of the SAME length
 * (CommonMark's rule); an unclosed run is treated as code through end of line,
 * which is the conservative direction — it can only ever skip a rewrite.
 */
function splitCodeSpans(line: string): Array<{ text: string; code: boolean }> {
    const out: Array<{ text: string; code: boolean }> = [];
    const runs = /`+/g;
    let at = 0;
    let open: { index: number; length: number } | null = null;
    let match: RegExpExecArray | null;
    while ((match = runs.exec(line))) {
        if (!open) {
            open = { index: match.index, length: match[0].length };
            continue;
        }
        if (match[0].length !== open.length) continue;
        out.push({ text: line.slice(at, open.index), code: false });
        out.push({ text: line.slice(open.index, match.index + match[0].length), code: true });
        at = match.index + match[0].length;
        open = null;
    }
    if (open) {
        out.push({ text: line.slice(at, open.index), code: false });
        out.push({ text: line.slice(open.index), code: true });
    } else {
        out.push({ text: line.slice(at), code: false });
    }
    return out;
}

/**
 * Serializer post-pass (MAR-218): halve the backslash runs the serializer
 * doubled inside `<…>` autolinks, so an edited line settles at a fixed point
 * instead of growing `\` → `\\` → `\\\\` on every open-and-save cycle.
 *
 * Upstream asymmetry: `mdast-util-to-markdown` escapes `\` inside an autolink,
 * but CommonMark says backslash escapes are INERT there, so the parser never
 * unescapes — every round trip doubled what the last one wrote. The zero-edit
 * save was protected by the merge layer, so this only started growing once the
 * line was touched, and then grew forever.
 *
 * Fence-aware and code-span-aware for the same reason `unescapeOrgCookies` is:
 * verbatim user bytes are never rewritten. Applied at the single point where
 * the whole serialized string exists (fidelitySerializer's returned closure);
 * see webview/serialization.ts, which composes the two passes.
 */
export function unescapeAutolinkBackslashes(markdown: string): string {
    // Serializer output always doubles, so a single backslash can't be ours.
    if (!markdown.includes("\\\\")) {
        return markdown;
    }
    let fence: string | null = null;
    return markdown
        .split("\n")
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
            if (!line.includes("\\\\")) return line;
            return splitCodeSpans(line)
                .map(({ text, code }) =>
                    code
                        ? text
                        : text.replace(AUTOLINK_BACKSLASH_ESCAPE_RE, (_whole, body: string) =>
                              "<" + body.replace(/\\\\/g, "\\") + ">",
                          ),
                )
                .join("");
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

// ─── Replacement reconciliation (MAR-213 / MAR-214) ─────────────────────────
//
// An edited line is written from the SERIALIZER's bytes, so every part of it
// the user never touched gets canonicalized in passing — while the untouched
// lines around it keep their saved bytes. That asymmetry is what turns an edit
// destructive rather than merely cosmetic: two indentation conventions mixed
// inside one outline reparent the block tree (a tab is 4 columns, two spaces
// are 2), and re-emitting a whole table row empties the cells the serializer
// cannot round-trip. The reconciler restores the saved bytes for the parts of
// the line that compare EQUAL under the very normalizers the diff keys with —
// it invents no new equivalence, it applies the existing ones below whole-line
// granularity.

const LEADING_WS_RE = /^[ \t]*/;

const indentOf = (line: string): string => LEADING_WS_RE.exec(line)![0];

/**
 * Markdown's `FormatProfile.baselineFacts` (MAR-222): which SOURCE indent this
 * file's serializer renders as which CANONICAL indent, learned from the file's
 * own zero-edit round trip.
 *
 * List depth is not a property of a line. It is the relationship between the
 * line's indent and its ancestors' marker widths, so no rule reading one indent
 * in isolation can decide whether `\t   ` and `    ` mean the same depth —
 * `normalizeOutlineIndent` answers "same column count", which is a different
 * question and coincides only for whole tabs. The baseline round trip is the
 * file answering the real one: whatever the serializer emitted for a line
 * BEFORE any edit is that line's depth, rendered canonically.
 *
 * An indent seen with two different canonical renderings is AMBIGUOUS and is
 * dropped rather than guessed — a tab is one list level in an outline and a
 * literal tab inside a fence, and one file can hold both.
 */
function baselineIndents(pairs: readonly BaselineLinePair[]): Map<string, string> {
    const canonical = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const pair of pairs) {
        const source = indentOf(pair.saved);
        if (ambiguous.has(source)) continue;
        const rendered = indentOf(pair.serial);
        const prev = canonical.get(source);
        if (prev === undefined) {
            canonical.set(source, rendered);
        } else if (prev !== rendered) {
            canonical.delete(source);
            ambiguous.add(source);
        }
    }
    return canonical;
}

/**
 * A line's indent together with the ROLE that indent plays: `m` for a line that
 * opens a list item, `c` for one that continues (or sits outside) one. The two
 * roles are indented to different widths at the same depth — a marker sits at
 * the item's own indent, its continuation lines align past the marker — so they
 * collide at every second depth and must be kept apart. `mergeIndents` files
 * spellings under this, and `reconcileInsertion` looks them up under it.
 */
function indentFamily(line: string): string {
    return (LIST_MARKER_RE.test(line) ? "m" : "c") + indentOf(line);
}

/**
 * Markdown's `FormatProfile.mergeFacts` (MAR-230): how THIS file spells each
 * canonical outline indent, read off the keep pairs of the merge in progress —
 * `baselineIndents` inverted, and re-derived from the live document instead of
 * the load-time baseline.
 *
 * Both directions are needed because the two hooks face opposite ways. An
 * EDITED line arrives with its saved indent in hand and only has to decide
 * whether that indent still means what it meant (source → canonical). An
 * INSERTED line has no saved indent at all: it arrives spelled canonically and
 * has to be told what this file would have written (canonical → source).
 *
 * Two properties make this safe where inverting the BASELINE map would not be:
 *
 *   - It cannot be stale. Every entry comes from a line this merge is writing
 *     back verbatim, so a spelling it hands out is one the output already
 *     contains at that depth. `baselineFacts`' hazard — a fact distilled once
 *     from a document that has since moved on — cannot arise.
 *   - It exists exactly when it is needed. A file that round-trips cleanly gets
 *     NO protection object and therefore no baseline facts at all, yet still
 *     breaks under a move (`fixtures/logseq/journal.md`: 4 of 22 executable
 *     moves, with `computeRoundTripProtection` returning null). Keeps are
 *     available on every merge, protected or not.
 *
 * Entries are filed under `indentFamily`, because a canonical indent width does
 * NOT identify a depth on its own: a marker line and the continuation lines of
 * the item above it meet at the same width and are spelled differently (a tab
 * outline writes `\t\t-` for the one and `\t  ` for the other, both rendered as
 * four spaces). Merging the two families makes every such file ambiguous and
 * the map empty, and nothing is re-based at all. Pinned by "a marker and a
 * continuation at the same width should not cancel out" in
 * `movedBlockIndent.test.ts`, which is the test that reddens if the roles are
 * merged.
 *
 * A canonical indent seen with two different spellings within its own family is
 * genuinely AMBIGUOUS and is dropped rather than guessed — the discipline
 * `baselineIndents` already uses, and the reason a stray fact (a verbatim line
 * whose leading whitespace happens to be content) can only ever cost a
 * respelling that would have been made, never cause a wrong one.
 */
function mergeIndents(pairs: readonly BaselineLinePair[]): Map<string, string> {
    const spelling = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const pair of pairs) {
        // A pair whose two sides disagree about being a marker line is not one
        // line in two spellings of the same thing; it teaches nothing safely.
        if (LIST_MARKER_RE.test(pair.saved) !== LIST_MARKER_RE.test(pair.serial)) continue;
        const canonical = indentFamily(pair.serial);
        if (ambiguous.has(canonical)) continue;
        const source = indentOf(pair.saved);
        const prev = spelling.get(canonical);
        if (prev === undefined) {
            spelling.set(canonical, source);
        } else if (prev !== source) {
            spelling.delete(canonical);
            ambiguous.add(canonical);
        }
    }
    return spelling;
}

/**
 * Markdown's `FormatProfile.reconcileInsertion` (MAR-230): re-base an inserted
 * block of outline lines onto the indentation this file actually uses.
 *
 * A block move is the ordinary way to reach this. The moved lines are
 * insertions — they have no saved counterpart to carry bytes from — so they
 * were written with the serializer's two-space indents while the untouched
 * lines around them kept their tabs. A tab is four columns and two spaces are
 * two, so the file reparses with different nesting than the document on screen:
 * on `fixtures/logseq/page.md`, 49 of 247 executable moves damaged the file
 * before this change and 10 after, with nothing newly broken.
 *
 * Each line is re-based by SUBSTITUTING ITS INDENT AS A PREFIX rather than
 * being rewritten: the canonical indent is looked up, and only exactly that
 * many leading characters are replaced. Everything past the prefix — the extra
 * columns that make a line a child, a fence's content offset, an over-indented
 * code sample — is carried through untouched.
 *
 * VERBATIM LINES DO NOT GET A LOOKUP OF THEIR OWN; they repeat the substitution
 * made for the construct that opened above them. This is the whole reason the
 * hook takes a run, and it is not a refinement — resolving a nested fence's
 * body independently of its opening line moved the fence and left its content
 * behind, so the content reparsed as an indented code block and the fence was
 * lost. Inside a fence the leading whitespace is user bytes: it may only ever
 * ride along with the fence, never be looked up. A run that opens inside
 * verbatim content therefore has nothing to ride on and is left alone, which is
 * the conservative answer as well as the correct one.
 *
 * Two gates on everything else:
 *
 *   - ONLY A SPELLING THIS FILE ALREADY USES IN THAT ROLE AT THAT WIDTH. The
 *     map is a lookup of observed spellings, never a computation. Where it has
 *     no answer the run carries the substitution already in force rather than
 *     inventing one — a block re-based half one way and half the other is torn,
 *     and uniformity within a run matters more than precision on its lines.
 *   - IT MUST AGREE WITH THE LINE THE RUN LANDS UNDER. A file-wide fact says
 *     how this document spells a depth; it cannot say whether the neighbour
 *     directly above is spelled that way, and the two come apart routinely. If
 *     that neighbour is an in-place replacement whose depth genuinely moved,
 *     `carrySavedIndent` correctly lets the serializer's canonical indent win —
 *     and re-basing the insertion beneath it onto the file's tabs then mixes
 *     two conventions inside ONE parent/child relationship. That is not a
 *     missed fix, it is fresh corruption: in a plain five-deep tab outline the
 *     child stopped being a list item and survived only as literal text glued
 *     into its parent's paragraph. So a substitution is taken only when its
 *     spelling is prefix-COMPATIBLE with the anchor above it (one indent is a
 *     prefix of the other — the same convention, at some depth), and the anchor
 *     advances to each line as it is written so the run stays consistent with
 *     itself as well as with the document. Refusing costs a respelling that
 *     would have been made; taking it wrongly costs the user content.
 */
function reconcileInsertion(
    lines: readonly InsertedLine[],
    preceding: string | null,
    facts: unknown,
): readonly string[] {
    const serial = lines.map((l) => l.serial);
    if (!(facts instanceof Map)) return serial;
    const spelling = facts as Map<string, string>;
    // The substitution in force, carried across verbatim lines and past widths
    // the file has taught nothing about. Null until a line whose indentation is
    // structure has resolved one.
    let carried: { canonical: string; source: string } | null = null;
    // The indent this run must remain consistent with: the line above it, then
    // each line as it is written.
    let anchor = preceding === null ? "" : indentOf(preceding);
    return serial.map((line, i) => {
        if (!lines[i].key.startsWith("\x00")) {
            const source = spelling.get(indentFamily(line));
            if (typeof source === "string") carried = { canonical: indentOf(line), source };
        }
        const sub = carried;
        const written =
            sub &&
            sub.source !== sub.canonical &&
            line.startsWith(sub.canonical) &&
            (sub.source.startsWith(anchor) || anchor.startsWith(sub.source))
                ? sub.source + line.slice(sub.canonical.length)
                : line;
        anchor = indentOf(written);
        return written;
    });
}

// Carry the saved line's literal leading whitespace (tabs, widths, and all)
// onto the serializer's line when the user did not re-indent it and only the
// serializer's canonicalization moved. Two independent rules say so, and the
// carry happens if EITHER does:
//
//   1. KEY EQUALITY. `normalizeOutlineIndent` is the profile's own definition
//      of "the same depth"; a genuine outdent normalizes differently, so it
//      stays an honest edit and the serializer's indent wins. Widening THIS
//      rule (say, calling a 3-space indent "the same depth" as the
//      serializer's 2) would invent an equivalence the diff does not have and
//      would swallow real outdents — worse data loss than the bug.
//   2. THE FILE'S OWN TESTIMONY (`baselineIndents`, MAR-222). If the serializer
//      already rendered this source indent exactly this way before any edit,
//      the line's depth has not moved and the difference is canonicalization.
//      Rule 1 cannot see this: it answers "same column count", and a tab plus
//      three spaces is five columns against the serializer's four.
//
// Two constraints on rule 2, both learned the hard way, and both about the same
// weakness — the facts are distilled ONCE from the load-time baseline, but the
// saved text keeps changing under them, so the map is consulted for lines it
// has no evidence about at all:
//
//   - It may only ever GRANT a carry, never veto one. Making it authoritative
//     let a fact learned from an unrelated construct switch OFF rule 1: a file
//     opened as `1. one` + a tab-indented child teaches `\t` → three spaces
//     (an ordered marker is wider), and if the user later appends a BULLET
//     outline, editing inside it wrote the serializer's two spaces while the
//     untouched grandchild kept `\t\t` — landing it 4+ columns in, where it
//     reparses as indented code. That is precisely the MAR-222 damage, caused
//     by the MAR-222 fix, in a document the baseline never saw.
//   - It applies only where indentation means outline DEPTH — both lines must
//     carry a list marker. An outline's fact must never speak for a line whose
//     leading whitespace is content: a fence added after load, holding a
//     `\t   `-indented line, had its indent edit silently swallowed because the
//     outline above it had taught that `\t   ` renders as four spaces. Fence
//     content is verbatim user bytes (MAR-161). The hook is handed two bare
//     strings and cannot classify a line in context, but "does it start with a
//     list marker" is answerable locally and is exactly the scope rule 2 needs.
//
// Both rules are gated on the rest of the line having changed too. If the
// leading whitespace is the ONLY difference then the whitespace IS the edit,
// and carrying the saved bytes back would silently discard it: a whitespace-
// only tab→space edit inside a top-level fence (a Makefile recipe line) is
// exactly such a pair, and dropping it was the MAR-161 data loss — pinned by "a
// whitespace-only tab→space edit inside a top-level fence should register as an
// edit" in minimalDiff.test.ts.
function carrySavedIndent(
    saved: string,
    serial: string,
    baseline: Map<string, string> | null,
): string {
    const savedWs = indentOf(saved);
    const serialWs = indentOf(serial);
    if (savedWs === serialWs) return serial;
    if (saved.slice(savedWs.length) === serial.slice(serialWs.length)) return serial;
    const unmoved =
        normalizeOutlineIndent(savedWs) === normalizeOutlineIndent(serialWs) ||
        (LIST_MARKER_RE.test(saved) &&
            LIST_MARKER_RE.test(serial) &&
            baseline?.get(savedWs) === serialWs);
    return unmoved ? savedWs + serial.slice(serialWs.length) : serial;
}

// Keep the SAVED bytes of every table cell the user did not touch. A row is
// one line, so editing any cell re-emits the entire row from the serializer,
// taking with it whatever the serializer cannot reproduce elsewhere in that
// row — a lone `<br />` cell (keyed equal to an empty cell, so it comes back
// empty: content loss in a cell the user never visited) and the `<br/>` /
// `<br>` spellings. Cells that key equal under normalizeTableCell are
// formatting-only differences, so the saved bytes win — the rule the merge
// already applies to whole lines. At least one cell always differs here: a row
// where none did would have keyed equal and merged as a plain `keep`.
//
// CELL PADDING is deliberately not salvaged: a cell whose bytes differ only in
// surrounding spaces takes the serializer's spacing, exactly as the whole row
// always has. What this carries is the cell CONTENT the serializer cannot
// reproduce, not the column alignment of a row that is being rewritten anyway.
function carrySavedTableCells(saved: string, serial: string): string {
    const s = saved.trim();
    const t = serial.trim();
    if (!TABLE_ROW_RE.test(s) || !TABLE_ROW_RE.test(t)) return serial;
    // A separator row carries column ALIGNMENT, which is real content and is
    // keyed by normalizeSepRow, not by the per-cell normalizer.
    if (SEP_ROW_RE.test(s) || SEP_ROW_RE.test(t)) return serial;
    const savedCells = s.split("|").slice(1, -1);
    const serialCells = t.split("|").slice(1, -1);
    if (savedCells.length !== serialCells.length) return serial;
    const merged = serialCells.map((cell, i) => {
        const savedCell = savedCells[i];
        if (savedCell.trim() === cell.trim()) return cell; // padding only
        return normalizeTableCell(savedCell) === normalizeTableCell(cell) ? savedCell : cell;
    });
    return indentOf(serial) + "|" + merged.join("|") + "|";
}

/** Markdown's `FormatProfile.reconcileReplacement`. Pure and total: every
 * branch falls back to the serializer's line, and neither pass can introduce a
 * newline. `facts` arrives typed `unknown` because the engine only stores and
 * returns it, so the shape is checked here rather than asserted — cheap, and it
 * is what keeps a protection built by some OTHER profile from being read as
 * this one's map once a second format exists. */
function reconcileReplacement(saved: string, serial: string, facts: unknown): string {
    const baseline = facts instanceof Map ? (facts as Map<string, string>) : null;
    return carrySavedTableCells(saved, carrySavedIndent(saved, serial, baseline));
}

// ─── Blank-line structure predicates (merge hooks) ──────────────────────────

// A blockquote marker allows at most 3 leading spaces; 4+ is an indented
// code block, where a leading `>` is literal text, not quote structure.
const isQuoteLine = (s: string): boolean => /^ {0,3}>/.test(s);

// ── Lazy continuation (MAR-289 / MAR-290) ───────────────────────────────────
//
// The general fact the `:::` arm below is one instance of. A non-blank line
// that cannot START a block is paragraph CONTINUATION text: glued under a
// line that leaves a paragraph open, CommonMark absorbs it into that
// paragraph — and laziness reaches through container boundaries, so a plain
// line glued under `- two` joins item two rather than following the list.
//
// That is why "turn the last list item into a paragraph" could not produce a
// paragraph: the serializer emits `- two\n\nthree`, the saved bytes have no
// blank there, and the merge (an in-place replacement, so the saved spacing
// wins) wrote `- two\nthree` — which reparses as ONE list item. The blank the
// serializer emitted is not spacing style, it is the only thing making the
// paragraph a paragraph.
//
// The relation is SYMMETRIC, which is why one predicate (`joinsAsLazyContinuation`)
// answers both of the profile's blank-line hooks. Where it holds, the blank
// between the two lines is the entire difference between one block and two:
// present, `next` is its own paragraph; absent, it is continuation text inside
// `prev`'s. So whichever spacing the serializer emits is the structure the
// document actually has, and the saved bytes' spacing is not a style to
// preserve — it is a claim about the parse that the editor has overruled.
// `glueChangesConstruct` reads that in the additive direction (the serializer
// separates, the saved bytes glue: a paragraph was SPLIT), `blankSplitsBlock`
// in the destructive one (the serializer glues, the saved bytes separate: two
// paragraphs were JOINED).
//
// Both predicates are deliberately CONSERVATIVE: every line they cannot
// classify from its own bytes (indented ≥4, HTML, tables, definitions, math
// fences, anything that might be fence content) answers "no" and the merge
// keeps its existing behaviour. Firing wrongly is expensive in BOTH
// directions now — it inserts a blank into bytes the user never touched, or
// deletes one they wrote — and a zero-edit save must stay byte-identical
// (corpus invariant A), which since MAR-290 is what actually gates these two
// functions: an all-keeps merge no longer short-circuits, so a predicate that
// misjudges a construct rewrites the file on a save that changed nothing.
// That is how `$$` was caught. Deleting is the worse direction; when in
// doubt, answer no.

/** A link reference definition — a block of its own, never paragraph text. */
const DEFINITION_RE = /^ {0,3}\[[^\]]*\]:/;
/** A setext underline, either flavour. */
const SETEXT_RULE_RE = /^ {0,3}(?:-+|=+)[ \t]*$/;
/**
 * A line that delimits a block and is therefore never paragraph text: an ATX
 * heading, a ``` / `~~~` code fence, a `:::` directive run, or a `$$` math
 * fence. Not all of them CLOSE a block — a fence opener starts one — but none
 * of them can be absorbed as continuation text, and none leaves a paragraph
 * open behind it, which is the only thing the two predicates below ask.
 *
 * `$$` is here because leaving it out was a silent lie in both directions
 * (MAR-290). Math flow is fence-like in this editor's dialect (remark-math):
 * it interrupts a paragraph, so `para` + `$$` parses as a paragraph plus a math
 * block and the serializer separates them — reading `$$` as prose made the
 * merge insert a blank the user never wrote. Worse, the empty math block
 * `$$\n\n$$` reads as two prose lines around a blank, so the JOIN rule deleted
 * the blank between the delimiters and destroyed the block. That is the corpus
 * fixture `math-variants.md`, and it is why this set has to name every block
 * delimiter the parser knows, not just CommonMark's.
 *
 * Its arm is the only one anchored to end-of-line, and the asymmetry is real
 * rather than tidiness: a fence or directive opener legitimately carries an
 * info string (```` ```js ````, `:::note`), but `$$` followed by anything is
 * not a delimiter at all — `$$x$$` is INLINE math, so `$$x$$ and more` is
 * ordinary paragraph text that does leave a paragraph open and can be absorbed
 * as continuation. Verified against the real parser, which gives `$$x$$` a
 * `math_inline` node inside a paragraph and keeps `para` + `$$x$$ and more`
 * glued as ONE paragraph. Matching it here would have refused both predicates
 * on a line that is prose — harmless (refusing only ever costs a fix, never
 * bytes) but a lie, and the kind that outlives the person who wrote it.
 */
const BLOCK_DELIMITER_RE = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|:{3,}|\${2,}[ \t]*$)/;

/** Visual width of a whole string, tabs expanding to the CommonMark tab stop. */
function columnWidth(text: string): number {
    let col = 0;
    for (const ch of text) {
        col += ch === "\t" ? 4 - (col % 4) : 1;
    }
    return col;
}

/**
 * The content a line contributes to its innermost container — blockquote
 * markers and at most one list marker stripped off — plus whether any marker
 * was there. The content is what decides whether the container has an open
 * paragraph; the flag says whether the line's indentation is container
 * structure rather than a possible indented-code run.
 *
 * The marker prefixes accept ANY leading whitespace, matching `LIST_MARKER_RE`
 * rather than CommonMark's ` {0,3}`, and for the same reason it does: a
 * 4-space or tab-indented sublist is a nested item in every outline this
 * editor is asked to keep (Logseq indents its whole block tree with tabs —
 * MAR-131), and the classifier already resolves that ambiguity the same way
 * ("list context wins for indent-candidates following a list-marker line").
 * Bounding it at 3 columns instead left every sublist indented 4+ columns
 * reading as indented code, so the lazy-continuation rule below never fired
 * there and MAR-289 stayed broken for exactly the outlines most likely to hit
 * it.
 */
function containerContent(line: string): {
    content: string;
    inContainer: boolean;
    /** Column the content starts at — the container's own content indent. */
    contentColumn: number;
} {
    let s = line;
    let inContainer = false;
    for (;;) {
        const quote = /^[ \t]*> ?/.exec(s);
        if (!quote) break;
        s = s.slice(quote[0].length);
        inContainer = true;
    }
    const marker = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(s);
    if (marker) {
        s = s.slice(marker[0].length);
        inContainer = true;
    }
    return {
        content: s,
        inContainer,
        contentColumn: columnWidth(line.slice(0, line.length - s.length)),
    };
}

/** Does `line` end with a paragraph still open — one a following continuation
 * line would join? True for prose and for the prose content of a list item or
 * blockquote; false for anything whose block the line itself closes, and for
 * every line these regexes cannot judge. Takes the already-split line so the
 * caller, which also needs the content column, parses it once: this runs per
 * blank-line gap on every save. */
function leavesParagraphOpen(
    { content, inContainer }: ReturnType<typeof containerContent>,
): boolean {
    if (content.trim() === "") return false; // bare marker: an empty item
    // Indented code — unless a container marker accounts for the indent, in
    // which case the depth is structure and the content starts at column 0.
    if (!inContainer && leadingColumns(content) >= 4) return false;
    return !(
        BLOCK_DELIMITER_RE.test(content) ||
        THEMATIC_BREAK_RE.test(content) ||
        SETEXT_RULE_RE.test(content) ||
        DEFINITION_RE.test(content) ||
        TABLE_ROW_RE.test(content.trim()) ||
        /^ {0,3}</.test(content)
    );
}

/**
 * Would `line` be swallowed as paragraph continuation text under a paragraph
 * whose content starts at `hostColumn`? True only for plain prose — every
 * construct that CAN interrupt a paragraph, and every line whose construct is
 * not decidable from its bytes, answers false.
 *
 * The indent test is RELATIVE to the host, because indented code is four
 * columns past the enclosing container's content indent, not past column 0.
 * Measuring from 0 read every line of a tab-indented outline as code, so
 * un-bulleting a nested item — which leaves its prose indented to the item's
 * content column — fell straight back into the MAR-289 bug.
 */
function isParagraphContinuation(line: string, hostColumn: number): boolean {
    if (line.trim() === "") return false;
    if (leadingColumns(line) >= hostColumn + 4) return false;
    return !(
        BLOCK_DELIMITER_RE.test(line) ||
        THEMATIC_BREAK_RE.test(line) ||
        SETEXT_RULE_RE.test(line) ||
        DEFINITION_RE.test(line) ||
        QUOTE_MARKER_RE.test(line) ||
        LIST_MARKER_RE.test(line) ||
        TABLE_ROW_RE.test(line.trim()) ||
        /^ {0,3}</.test(line)
    );
}

/**
 * Is the blank run between `prev` and `next` the only thing keeping them two
 * blocks — i.e. would gluing them absorb `next` as lazy continuation text of
 * the paragraph `prev` leaves open?
 *
 * One relation, both directions. The engine asks it twice with opposite
 * expectations (see the MAR-289 / MAR-290 block above): when the serializer
 * separates and the saved bytes glue, a paragraph was split; when the
 * serializer glues and the saved bytes separate, two were joined. Either way
 * the answer here is the same fact about the two lines, and the serializer's
 * spacing is the structure the document has.
 */
function joinsAsLazyContinuation(prev: string, next: string): boolean {
    const host = containerContent(prev);
    return leavesParagraphOpen(host) && isParagraphContinuation(next, host.contentColumn);
}

// Would gluing `next` directly under `prev` change next's block-level
// construct? Only then is a serializer-emitted separating blank structure
// rather than style. Three arms (all verified against the real parser):
//   - a `:::` run cannot interrupt a paragraph, so glued to ANY
//     absorbing line (paragraph, quote content, list-item content) it
//     becomes a lazy continuation instead of a fence/inert prose;
//   - a solid dash run becomes a setext underline (setext takes
//     precedence over hr) — but ONLY under a genuine paragraph line: a
//     quote line, list-marker line, or table row cannot be underlined
//     (the run after them parses as an hr either way), and firing there
//     would churn legitimately glued saved bytes.
//   - the general case the first arm is an instance of: ordinary prose
//     cannot interrupt a paragraph either, so glued under an open one it
//     becomes lazy continuation text (MAR-289 — see the block above).
// Lines that delimit their own block (ATX headings, fence lines, `$$` math
// fences, thematic breaks) absorb nothing; legitimate saved files DO glue
// there (a heading directly above a directive), so no arm may fire on
// them: a zero-edit save must keep those bytes verbatim. Solid
// `***`/`___` runs, backtick fences, headings, and list markers all
// interrupt a paragraph, so their attachment never depends on the blank.
// This is the M1 dual rule (MAR-161).
const glueChangesConstruct = (prev: string, next: string): boolean => {
    if (BLOCK_DELIMITER_RE.test(prev) || THEMATIC_BREAK_RE.test(prev)) {
        return false;
    }
    if (/^ {0,3}:{3,}/.test(next)) return true;
    if (
        /^ {0,3}-+[ \t]*$/.test(next) &&
        !isQuoteLine(prev) &&
        !LIST_MARKER_RE.test(prev) &&
        !TABLE_ROW_RE.test(prev.trim())
    ) {
        return true;
    }
    return joinsAsLazyContinuation(prev, next);
};

// ─── The markdown FormatProfile, and the profile-bound public API ───────────

/** Markdown's `@birta/minimal-diff` profile. Exported for the FormatModule
 * seam (webview/format/markdown) — chrome consumers go through the bound
 * wrappers below or through `formatModule.formatProfile`. */
export const markdownProfile: FormatProfile = {
    keyLines(lines) {
        const classes = classifyLines(lines);
        return lines.map((line, i) =>
            line.trim() === "" ? "" : normLineForCompare(line, classes[i]),
        );
    },
    glueChangesConstruct,
    // Two arms:
    //   - a blank line between two quote-context (`>`-prefixed) lines SPLITS
    //     the quote block. When the saved spacing would introduce such a split
    //     yet the serializer kept the two lines contiguous, the blank was a
    //     block separator the edit dissolved (e.g. a block moving between
    //     callouts merges two quotes into one) — MAR-122.
    //   - the mirror of MAR-289's lazy-continuation arm: a saved blank between
    //     an open paragraph and text that would continue it is what makes them
    //     two paragraphs, so when the serializer emits them glued the user
    //     JOINED them and the blank has to go (MAR-290).
    //
    // The second arm was deliberately left out of MAR-289: no edit reached it
    // then, because a pure join changes no significant line and the merge took
    // an all-keeps early return before ever consulting this hook — it would
    // have been an untestable rule in the destructive direction. Removing that
    // early return is the other half of MAR-290, and is what gives this arm
    // both its failing case and its guard (corpus invariant A).
    blankSplitsBlock: (prev, next) =>
        (isQuoteLine(prev) && isQuoteLine(next)) || joinsAsLazyContinuation(prev, next),
    reconcileReplacement,
    baselineFacts: baselineIndents,
    mergeFacts: mergeIndents,
    reconcileInsertion,
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
