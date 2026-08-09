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
    type ReplacementKeys,
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

/**
 * A list-item marker. The groups carry the two facts that decide which LIST an
 * item belongs to — the marker's indent, and its bullet character or ordered
 * delimiter — and are read only by `listMarkerAt`; every other use here is a
 * bare `.test()` or `[0]`.
 */
const LIST_MARKER_RE = /^([ \t]*)(?:([-*+])|\d{1,9}([.)]))(?:[ \t]|$)/;
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
// serializer used to split a strong node into two `**...**` runs when it
// contained a link child; it no longer does (7.22.0 keeps a mark open across
// adjacent nodes), but files saved by older builds still contain the split
// form, which is semantically identical.
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
 * (the serializer post-pass, plugins/serializerPostPass.ts), which also covers table-cell
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
 * the whole serialized string exists (the serializer post-pass);
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
    // The two table normalizers both `trim()`, which would throw away the
    // depth the line above just normalized — and every other branch here keeps
    // it. Restoring it is what stops a row pairing with a row at a DIFFERENT
    // depth (MAR-241): a table's rows are ordinary lines to the diff, and a
    // depth-blind key let the merge call a moved row a `keep` and emit its
    // saved bytes verbatim, carrying the indent of the nesting it just left.
    // Keeping it costs nothing where the depth genuinely has not moved — a tab
    // and the serializer's two spaces normalize to the same string, which is
    // exactly how the outline's own lines stay `keep`s across canonicalization.
    if (SEP_ROW_RE.test(t)) return indentOf(line) + normalizeSepRow(line);
    if (TABLE_ROW_RE.test(t)) return indentOf(line) + normalizeTableDataRow(line);
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
    const fence = FENCE_LINE_RE.exec(t);
    if (fence) {
        // Key a fence marker line by its INFO STRING alone, so `~~~` and ```
        // compare equal and both of a fence's marker lines stay ordinary
        // `keep`s carrying the saved spelling.
        //
        // Keying them apart makes each marker line its own round-trip
        // protection region, and regions are anchored to their neighbouring
        // lines: an edit beside one end invalidates that end's anchors while
        // the other end still repairs, writing a mismatched pair (open ```,
        // close `~~~`). The fence never terminates and the rest of the document
        // is swallowed as code on reopen (MAR-312).
        //
        // Safe where the thematic-break branch above is not: `-` doubles as a
        // setext underline, but a backtick or tilde run is only ever a fence, so
        // no second construct can be repaired into one. Marker LENGTH drops for
        // the same reason — ```` vs ``` is about what the fence can nest, not
        // how the pair is spelled.
        return indentOf(line) + "\x00Q" + t.slice(fence[1].length).trim();
    }
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
 * Whether a baseline pair's leading whitespace is literal user bytes on either
 * side, and so teaches the indent learners below nothing (MAR-325).
 *
 * A verbatim span is reproduced byte for byte, so its two sides always agree —
 * and agreement is what the learners read as evidence. That makes such a line a
 * confident WITNESS to an identity it has no opinion about: three lines of a
 * mermaid diagram indented four spaces reported `"    " → "    "` in
 * `hostile-content.md` beside the outline's real `"    " → "  "`, two renderings
 * for one source, so `baselineIndents` correctly called that depth ambiguous and
 * dropped it. The file did have one spelling at that depth; only a line that was
 * never talking about depth said otherwise. Levels 4 through 8 of an 8-level
 * list flattened on the next save carrying an edit.
 *
 * EITHER side disqualifies the pair, not both: `!==` alone (the shape the
 * marker-role gate in `mergeIndents` uses) catches a disagreement, and the
 * hazard here is two lines that agree about being irrelevant.
 *
 * Deliberately NOT a marker-line test, which is the blunter rule this replaced
 * and which regressed MAR-322: a tab-indented CONTINUATION line inside an item
 * is not a marker line, yet it is exactly the evidence that fix leans on to
 * learn a file's tab spelling. Excluding every non-marker line threw that away
 * and re-spelled whole documents to two spaces. The fence is the thing that
 * lies, so the fence is what gets excluded.
 */
function indentIsLiteral(pair: BaselineLinePair): boolean {
    return pair.savedIndentIsContent || pair.serialIndentIsContent;
}

/**
 * Markdown's `FormatProfile.indentIsContent`: the classes whose leading
 * whitespace belongs to the user's bytes rather than to the document's
 * structure.
 *
 * `fence-raw` is a fence opened at column 0 — everything inside it, indentation
 * included, is content by definition. `code` is an indented code block, whose
 * leading whitespace past the four-space opener is likewise the user's own
 * layout, and whose opener is not an outline level either.
 *
 * `fence-nested` is absent, and UNLIKE the two above that choice is currently
 * undefended: adding it changes no test in the fidelity suites (403 cases
 * across the corpus, the move gate, and this file's own unit pins). Say so
 * rather than dress it up — the reasoning is that a fence nested in a list item
 * carries real outline structure in its leading whitespace, which is precisely
 * why the classifier depth-normalizes it (MAR-131), so its round trip witnesses
 * a genuine spelling (`"\t\t" → "    "`) the learners should keep, and dropping
 * that would withdraw a concession rather than grant one. That argument is
 * sound and no fixture currently depends on it, which means a future reader
 * must not treat this line as load-bearing evidence. If you need it to be, add
 * the fixture that reddens when it flips: a tab outline whose ONLY witness to
 * some depth is a nested fence's indent.
 *
 * Note this set is deliberately not `losesOpaqueContent`'s, which asks a
 * different question about the same classes and answers `fence-nested` the
 * other way. Opaque CONTENT and literal INDENTATION are independent: a nested
 * fence's body is code (so losing it is a demotion) while its leading
 * whitespace is outline structure (so it is evidence). One predicate serving
 * both would have to be wrong about one of them.
 */
function indentIsContent(lines: readonly string[]): boolean[] {
    const classes = classifyLines(lines as string[]);
    return classes.map((c) => c === "fence-raw" || c === "code");
}

/** Lines whose CONTENTS are opaque — code, however the file spells it. Both
 *  fence classes and the indented form count, because the question is whether
 *  the text is still code, not which of the two syntaxes carries it: a repair
 *  restoring a file's indented code over a fence the serializer chose is doing
 *  its job, and must not read as a loss. */
function opaqueLineCount(lines: readonly string[]): number {
    let n = 0;
    for (const c of classifyLines(lines as string[])) {
        if (c === "fence-raw" || c === "fence-nested" || c === "code") n++;
    }
    return n;
}

/**
 * Markdown's `FormatProfile.losesOpaqueContent`: did this rewrite leave the
 * document holding less code than it started with?
 *
 * A COUNT, not a positional comparison, because the two texts legitimately
 * differ in length — a protected region exists precisely because the serializer
 * could not reproduce something, so `after` routinely holds lines `before` does
 * not. Counting also makes the test one-directional, which is the point: gaining
 * opaque lines is a repair restoring a construct, and only losing them says code
 * stopped being code.
 *
 * Measured over 285 corpus merges when it shipped: zero firings, against seven
 * for the merge's own role check and thirty-four for the "any role changed"
 * rule this replaced. It is meant to be a rare, specific veto, so a version of
 * it that starts firing broadly is wrong rather than thorough.
 */
function losesOpaqueContent(before: readonly string[], after: readonly string[]): boolean {
    return opaqueLineCount(after) < opaqueLineCount(before);
}

/**
 * The forward half of markdown's `FormatProfile.baselineFacts` (MAR-222):
 * which SOURCE indent this file's serializer renders as which CANONICAL
 * indent, learned from the file's own zero-edit round trip. Stored alongside
 * the family-keyed inversion in `MarkdownBaselineFacts` (see `baselineFactsOf`).
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
        if (indentIsLiteral(pair)) continue;
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
 *   - It exists exactly when it is needed. When this map shipped, a file that
 *     round-tripped cleanly got NO protection object and therefore no baseline
 *     facts at all, yet still broke under a move (`fixtures/logseq/journal.md`:
 *     4 of 22 executable moves, with `computeRoundTripProtection` returning
 *     null); keeps are available on every merge, protected or not. MAR-322
 *     closed that facts gap (a clean file now carries zero-region facts), but
 *     the live map keeps first claim because it cannot be stale.
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
/**
 * An indent spelling is leading whitespace, so a `\x00` value can only be this:
 * a family the evidence saw spelled two ways. It is recorded rather than
 * deleted because a CONSULTED map cannot otherwise tell "this family was never
 * witnessed" from "this family was witnessed as MIXED" — `Map.get` answers
 * `undefined` to both, and the two deserve opposite treatments. Silence may be
 * answered from weaker evidence (the baseline, under MAR-322's fallback);
 * observed ambiguity is direct, current evidence that the file has no single
 * spelling at that depth, and must not be overridden by an older fact.
 */
const AMBIGUOUS = "\x00ambiguous";

/** The spelling this evidence gives `family`, or undefined when it has none —
 * whether unwitnessed or witnessed as mixed. The single reader of the
 * tombstone, so no consumer has to know the encoding. */
function spellingOf(map: Map<string, string>, family: string): string | undefined {
    const source = map.get(family);
    return source === undefined || source === AMBIGUOUS ? undefined : source;
}

function mergeIndents(pairs: readonly BaselineLinePair[]): Map<string, string> {
    const spelling = new Map<string, string>();
    for (const pair of pairs) {
        // A pair whose two sides disagree about being a marker line is not one
        // line in two spellings of the same thing; it teaches nothing safely.
        if (LIST_MARKER_RE.test(pair.saved) !== LIST_MARKER_RE.test(pair.serial)) continue;
        // Nor does one whose indentation is the user's own bytes (MAR-325).
        // Families keep markers and continuations apart, so the fence lines
        // that poisoned `baselineIndents` land in the `c` family here rather
        // than on top of a marker fact — but two verbatim spans sharing a width
        // with a real continuation collide inside that family just the same.
        if (indentIsLiteral(pair)) continue;
        const canonical = indentFamily(pair.serial);
        const prev = spelling.get(canonical);
        if (prev === AMBIGUOUS) continue;
        const source = indentOf(pair.saved);
        if (prev === undefined) {
            spelling.set(canonical, source);
        } else if (prev !== source) {
            spelling.set(canonical, AMBIGUOUS);
        }
    }
    return spelling;
}

/**
 * What markdown's `baselineFacts` hook actually stores (MAR-322): the forward
 * source→canonical map (`baselineIndents`), and the SAME family-keyed
 * distillation the live merge uses (`mergeIndents`), applied to the load-time
 * baseline pairs. The second map exists because the forward map cannot be
 * inverted with roles intact — a tab outline renders both `\t\t` (a depth-2
 * marker) and `\t  ` (a depth-1 continuation) as four spaces, so the role-blind
 * inversion (`sourceSpellingOf`) rightly refuses that width as ambiguous, while
 * under `indentFamily` the two spellings never met. One distiller, both
 * evidence sets: reusing `mergeIndents` is what keeps "how does this file spell
 * that family" a single definition.
 */
interface MarkdownBaselineFacts {
    /** Source indent → canonical rendering; rule 2's grant and the insertion
     * anchor's rendered-equivalence grant read this. */
    rendered: Map<string, string>;
    /** `indentFamily` of the canonical line → source spelling; the insertion
     * hook's fallback vocabulary where this merge's own keeps are silent. */
    spelledByFamily: Map<string, string>;
}

/** Markdown's `FormatProfile.baselineFacts`. Returns `undefined` when the
 * round trip witnessed no spelling DIFFERENCE, which tells the engine such a
 * file has nothing to carry (`computeRoundTripProtection` then stays null —
 * the pre-MAR-322 contract, kept for every file that does not need the new
 * one). All-identity maps are not "small facts", they are no facts: an entry
 * whose source and rendering agree can never change what either consulting
 * rule writes, and carrying them would put a protection object on every clean
 * file in exchange for nothing. When any real difference exists the maps are
 * kept WHOLE, identities included — an identity entry can still vouch for an
 * anchor (`rendered.get(anchor)`), which is evidence, not a rewrite. */
function baselineFactsOf(pairs: readonly BaselineLinePair[]): MarkdownBaselineFacts | undefined {
    const rendered = baselineIndents(pairs);
    const spelledByFamily = mergeIndents(pairs);
    const teaches =
        [...rendered].some(([source, canonical]) => source !== canonical) ||
        [...spelledByFamily].some(
            ([family, source]) => source !== AMBIGUOUS && source !== family.slice(1),
        );
    return teaches ? { rendered, spelledByFamily } : undefined;
}

/** The shape check every consumer of the stored facts goes through — cheap,
 * and what keeps a protection built by some OTHER profile from being read as
 * this one's maps once a second format exists. */
function asBaselineFacts(facts: unknown): MarkdownBaselineFacts | null {
    if (facts === null || typeof facts !== "object") return null;
    const f = facts as Partial<MarkdownBaselineFacts>;
    return f.rendered instanceof Map && f.spelledByFamily instanceof Map
        ? (f as MarkdownBaselineFacts)
        : null;
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
 *     into its parent's paragraph. So the anchor above must be a line spelled
 *     the way this FILE spells indentation, and the anchor advances as the run
 *     is written so it stays consistent with itself as well as the document.
 *     Refusing costs a respelling that would have been made; taking it wrongly
 *     costs the user content.
 *
 * "Spelled the way this file spells indentation" is answered two ways, and
 * either suffices (MAR-297). Both are GRANTS — neither can veto what the other
 * allows — because refusing is the safe direction and every widening here has
 * to earn its keep against that:
 *
 *   - PREFIX-COMPATIBLE with the substitution's own spelling (one indent is a
 *     prefix of the other): the same convention, at some depth. Cheap, local,
 *     and right whenever a file has one indent unit.
 *   - OR THE ANCHOR IS ITSELF A SPELLING THIS MERGE OBSERVED — a value of the
 *     map, i.e. leading whitespace the merge is writing back verbatim from the
 *     saved file at some depth. The prefix test alone reads two ways that are
 *     both false negatives, and both re-nest a moved bullet. It compares
 *     against the wrong ROLE (a run landing under a table row anchors on the
 *     continuation spelling `"\t  "` while its marker resolves to `"\t\t"` —
 *     the same tab convention, neither a prefix of the other), and it cannot
 *     see two spellings of ONE depth (a file writing a level as both `\t` and
 *     four literal spaces, where `baselineIndents` records both rendering to
 *     the same canonical indent). Being a spelling the merge is already
 *     emitting is the direct evidence the prefix test was approximating.
 *
 * THE ANCHOR ADVANCES PAST EVERY LINE, including ones the hook had no opinion
 * about, and that is exactly why the second grant is needed rather than
 * optional. An anchor is only ever the previous WRITTEN line's indent, and a
 * line written through untouched — because the map knows nothing about its
 * width — is not evidence of a convention: its indent may be the serializer's
 * canonical bytes OR the saved file's own, restored underneath us by round-trip
 * protection (`repairSerialized` runs BEFORE the diff, so a repaired line
 * reaches this hook wearing source-convention whitespace in a stream that is
 * otherwise canonical). Under the prefix test alone, ONE such line silently
 * vetoed every substitution below it in the same run — MAR-297's reproduction A
 * exactly, where a protection-repaired `    - four space` blocked the `\t`
 * re-spelling of the `- plain` beneath it and the kept table bullet below then
 * reparsed as that bullet's child. The grants above answer that line on its
 * own terms instead: `    ` is a spelling the baseline renders to the same
 * canonical indent the substitution targets, so it grants rather than blocks.
 *
 * Skipping the advance for opinionless lines was considered and is NOT what
 * shipped: the anchor would then be carried across arbitrary distances, and the
 * self-consistency the anchor exists to enforce (a run must agree with itself,
 * not only with the document) is a property of ADJACENT lines.
 */
function reconcileInsertion(
    lines: readonly InsertedLine[],
    preceding: string | null,
    facts: unknown,
    baseline: unknown,
): readonly string[] {
    const serial = lines.map((l) => l.serial);
    if (!(facts instanceof Map)) return serial;
    const spelling = facts as Map<string, string>;
    // Every source spelling this merge is writing back verbatim — the file's
    // own indentation vocabulary, as observed rather than computed. Tombstoned
    // families contribute nothing: an ambiguity is the absence of a spelling,
    // not one more of them, and it must not vouch for anything.
    const spelled = new Set([...spelling.values()].filter((s) => s !== AMBIGUOUS));
    const baselineFacts = asBaselineFacts(baseline);
    // The load-time baseline, source → canonical. Only ever consulted to GRANT
    // (see below), so its documented staleness can cost a respelling that would
    // have been made, never cause a wrong one.
    const rendered = baselineFacts?.rendered ?? null;
    // The load-time counterpart of `spelling`, consulted only where this
    // merge's own keeps are SILENT — never where they are ambiguous. The
    // distinction needs the tombstone (`AMBIGUOUS`) to exist at all, since a
    // deleted entry and an unwitnessed one are the same `undefined`: a family
    // this merge is watching two spellings of is direct, current evidence that
    // the file has no single answer there, and letting an older fact override
    // it would be the one thing every rule in this file refuses to do — decide
    // from weaker evidence than it holds. They go silent exactly when the
    // moved block itself held the only line witnessing its landing depth: a
    // plain tab outline whose sole `\t\t` bullet is the thing being moved
    // teaches the live map nothing about that family, and the insertion then
    // shipped the serializer's spaces beside kept tabs — a tab is four columns
    // against canonical two, so the untouched neighbours reparsed at different
    // depths and a nested list dissolved, silently, only in the merged bytes.
    // Unlike the live map, a baseline fact is not self-corroborating (the
    // merge is not currently writing that spelling back), so it must be
    // vouched for before it may START a substitution: prefix-compatible with a
    // NON-EMPTY spelling this merge is live-observing. The empty spelling is
    // excluded because it prefixes everything and so witnesses nothing; a file
    // whose live keeps show no indentation convention at all corroborates
    // nothing, and the fallback refuses — the safe direction, costing a
    // respelling that would have been made, never inventing one.
    const baselineSpelling = (family: string): string | undefined => {
        if (spelling.get(family) === AMBIGUOUS) return undefined;
        const witnessed = baselineFacts
            ? spellingOf(baselineFacts.spelledByFamily, family)
            : undefined;
        if (witnessed === undefined) return undefined;
        for (const s of spelled) {
            if (s !== "" && (witnessed.startsWith(s) || s.startsWith(witnessed))) {
                return witnessed;
            }
        }
        return undefined;
    };
    // The substitution in force, carried across verbatim lines and past widths
    // the file has taught nothing about. Null until a line whose indentation is
    // structure has resolved one.
    let carried: { canonical: string; source: string } | null = null;
    // The indent this run must remain consistent with: the line above it, then
    // each line as it is written.
    let anchor = preceding === null ? "" : indentOf(preceding);
    return serial.map((line, i) => {
        if (!lines[i].key.startsWith("\x00")) {
            const family = indentFamily(line);
            const source = spellingOf(spelling, family) ?? baselineSpelling(family);
            if (typeof source === "string") carried = { canonical: indentOf(line), source };
        }
        const sub = carried;
        const written =
            sub &&
            sub.source !== sub.canonical &&
            line.startsWith(sub.canonical) &&
            (sub.source.startsWith(anchor) ||
                anchor.startsWith(sub.source) ||
                spelled.has(anchor) ||
                rendered?.get(anchor) === sub.canonical)
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
//
// That refusal stands. What changed (MAR-299) is what happens INSTEAD of the
// carry: refusing to write the saved bytes is not the same as being obliged to
// write the serializer's, and for a moved list item the file's own spelling of
// the NEW depth is the right third answer. See `respellMovedIndent`.
//
// Rule 3 answers BOTH branches below, for one reason: the serializer's canonical
// indent is never the right answer for a line whose depth moved. The
// identical-body branch reaches it because the whitespace is the edit; the other
// reaches it because rules 1 and 2 have just said the depth moved, and a moved
// depth spelled canonically inside a file that spells it otherwise mixes two
// conventions inside one parent/child relationship — the item below reparses as
// a child, or, past a content column, as prose (MAR-328). A changed body is
// ordinary here: an item whose bullet character the edit also rewrote has a
// depth like any other. `respellMovedIndent`'s four gates are what make it safe
// in either branch, and it hands back the serializer's line whenever they
// refuse.
function carrySavedIndent(
    saved: string,
    serial: string,
    baseline: Map<string, string> | null,
    structural: boolean,
): string {
    const savedWs = indentOf(saved);
    const serialWs = indentOf(serial);
    if (savedWs === serialWs) return serial;
    if (saved.slice(savedWs.length) === serial.slice(serialWs.length)) {
        return respellMovedIndent(saved, savedWs, serial, serialWs, baseline, structural);
    }
    const unmoved =
        normalizeOutlineIndent(savedWs) === normalizeOutlineIndent(serialWs) ||
        (LIST_MARKER_RE.test(saved) &&
            LIST_MARKER_RE.test(serial) &&
            baseline?.get(savedWs) === serialWs);
    if (unmoved) return savedWs + serial.slice(serialWs.length);
    // Rule 3, on one extra condition the identical-body branch does not need:
    // the baseline must have witnessed THIS source indent rendering to
    // something. Without an entry the two indents disagree for a reason nobody
    // has established — an indent the file renders two ways is dropped rather
    // than guessed (MAR-222) — and rule 3's arm 1 would guess anyway, from a
    // prefix of the line's own bytes. With one, the file said this indent means
    // a depth, and the serializer just named a different one, so the depth
    // moved and only its spelling is in question.
    if (baseline?.get(savedWs) === undefined) return serial;
    return respellMovedIndent(saved, savedWs, serial, serialWs, baseline, structural);
}

/**
 * `baselineIndents` READ BACKWARDS: which source indent this file writes for a
 * given canonical one. Same discipline as every other fact here — a canonical
 * indent that two source spellings render to is AMBIGUOUS and is dropped rather
 * than guessed, so a lookup either hands back a spelling the file demonstrably
 * uses at that width or nothing at all.
 *
 * Derived on demand rather than distilled alongside the forward map, because the
 * forward map is what the engine stores on the protection and hands back
 * (`baselineFacts`) — inverting here keeps that stored value one shape with one
 * owner. Memoized per map: `reconcileReplacement` runs once per edited line and
 * the protection object outlives a merge.
 *
 * The roles `indentFamily` keeps apart (`m` marker / `c` continuation) are NOT
 * separated here, because the forward map does not record them. The cost is
 * self-limiting rather than dangerous: an outline whose continuation lines
 * collide with a deeper marker width simply makes that width ambiguous, and
 * ambiguity refuses.
 */
const invertedBaselines = new WeakMap<Map<string, string>, Map<string, string>>();
function sourceSpellingOf(
    baseline: Map<string, string>,
    canonical: string,
): string | undefined {
    let inverted = invertedBaselines.get(baseline);
    if (inverted === undefined) {
        inverted = new Map<string, string>();
        const ambiguous = new Set<string>();
        for (const [source, rendered] of baseline) {
            if (ambiguous.has(rendered)) continue;
            const prev = inverted.get(rendered);
            if (prev === undefined) {
                inverted.set(rendered, source);
            } else if (prev !== source) {
                inverted.delete(rendered);
                ambiguous.add(rendered);
            }
        }
        invertedBaselines.set(baseline, inverted);
    }
    return inverted.get(canonical);
}

/**
 * The prefix of `savedWs` that renders to exactly `serialWs` — the depth the
 * serializer is now naming, spelled in the bytes THIS LINE was already wearing
 * on its way down to it. `\t\t` passes through `\t` on its way to nothing, so an
 * item that outdents one level from `\t\t` is spelled `\t` by its own evidence,
 * with no map consulted and nothing invented.
 *
 * "Renders to" is `normalizeOutlineIndent` and nothing else, deliberately: it is
 * already this profile's definition of "the same depth" (rule 1), and a second
 * definition here would be a second answer to the same question. At most one
 * prefix can match, since it maps each character to one or two and prefix length
 * → rendered length is therefore strictly increasing — which also bounds the
 * scan at `serialWs.length + 1` steps rather than the saved indent's length,
 * however long that is.
 *
 * The full length is excluded by the caller's depth gate, not here: a saved
 * indent that already renders to `serialWs` is a re-spelling, not a move.
 */
function depthPrefixOf(savedWs: string, serialWs: string): string | undefined {
    for (let i = 0; i <= savedWs.length; i++) {
        const prefix = savedWs.slice(0, i);
        const rendered = normalizeOutlineIndent(prefix);
        if (rendered === serialWs) return prefix;
        if (rendered.length > serialWs.length) return undefined;
    }
    return undefined;
}

/**
 * RULE 3 (MAR-299), and the answer to the pair the two rules above refuse.
 *
 * Refusing to CARRY there is right, and stays: if the leading whitespace is the
 * only difference then the whitespace is the edit, and writing the saved bytes
 * back would discard it (MAR-161). But "don't carry the saved indent" was taken
 * to mean "write the serializer's", and those are not the same answer. A moved
 * item lands at a depth the SERIALIZER names canonically and the FILE spells its
 * own way, so the canonical spelling drops two-space bytes into a tab outline —
 * the untouched sibling below is still four columns in, so it reparses as the
 * moved item's CHILD and the document gains a list level nobody made. A plain
 * tab outline (`- alpha` / `\t- beta` / `\t\t- gamma` / `\t- delta`, no mixed
 * units anywhere) loses one of its thirteen executable moves exactly this way.
 *
 * So the depth still comes from the serializer and only the SPELLING is
 * translated. Two arms answer "how does this file spell that depth", mirroring
 * rules 1 and 2 above, and either suffices:
 *
 *   1. THE LINE'S OWN BYTES (`depthPrefixOf`). The prefix of the saved indent
 *      that renders to the serializer's canonical indent — the file's spelling
 *      of that depth as witnessed by this very line, which is current by
 *      construction and needs no facts at all. This is the arm that matters:
 *      when this rule shipped, the documents most exposed to the bug — plain
 *      tab outlines — carried NO baseline facts to consult, because a tab keys
 *      equal to the two spaces it renders as (`normalizeOutlineIndent`), so the
 *      file round-trips under the profile's own keys and
 *      `computeRoundTripProtection` returned null. (MAR-322 has since made a
 *      clean file carry zero-region facts; this arm keeps first claim because
 *      the line's own bytes cannot be stale.) Of the seven losses this rule
 *      closed across the swept shapes, six are this arm's and only one is
 *      arm 2's.
 *   2. THE FILE'S OWN TESTIMONY, read backwards (`sourceSpellingOf`). Rule 1
 *      cannot see a unit the serializer does not use: a four-space outline
 *      writes depth 1 as four spaces where the serializer writes two, and no
 *      prefix of `        ` renders to `  ` except `  ` itself. The baseline
 *      round trip recorded that mapping and inverting it recovers the spelling.
 *
 * Four gates. Each one is the difference between this rule and a data loss:
 *
 *   - BOTH LINES MUST BE STRUCTURAL, i.e. neither key is `\x00`-tagged. This is
 *     the gate the first cut of this rule did not have, and its absence is why
 *     that cut was reverted: the marker test below guesses a line's ROLE from
 *     its bytes, and fence content compares raw, so `- item` inside a ```yaml
 *     fence passed it and a two-column edit came back four. The keys already
 *     hold the classification (see `isStructuralPair`), so the guess is no
 *     longer load-bearing — the reading is.
 *   - BOTH LINES MUST CARRY A LIST MARKER — rule 2's scope rule, for rule 2's
 *     reason: indentation is outline depth here and content everywhere else.
 *     It is also what keeps MAR-161's case out, a Makefile recipe line inside a
 *     top-level fence being no kind of list marker.
 *   - THE DEPTH MUST ACTUALLY HAVE MOVED, i.e. the saved indent must not already
 *     render to the serializer's. This is the whole discrimination the hook was
 *     missing — "the user re-spelled this line's whitespace" against "a move
 *     re-spelled it" — and two bare strings do answer it: a saved indent that
 *     renders to exactly what the serializer emitted is at the serializer's
 *     depth already, so nothing structural moved and the difference is the
 *     user's own bytes. Without this gate a deliberate `\t\t` → `    `
 *     conversion (same four columns, different convention) is reverted on the
 *     next save, which is MAR-161's loss reintroduced through the new door.
 *   - ARM 2'S SPELLING MUST BE PREFIX-COMPATIBLE with this line's saved indent
 *     (one a prefix of the other). `baselineFacts` is distilled once at load and
 *     the saved text moves under it, so a stale fact can name a convention the
 *     file has since abandoned — a tab outline converted to spaces would still
 *     be told a level is written `\t`, and writing one back is four columns
 *     where two were meant. Arm 1 needs no such check: its answer IS this
 *     line's own current bytes.
 *
 * WHAT THIS COST, since the rule shipped once and was backed out: the first cut
 * had only the last three gates and rated the fence exposure narrow. It was not
 * narrow — indenting a list inside a fenced code block is an ordinary gesture,
 * and `\x00`-tagged keys were already sitting in the engine one argument away.
 * The lesson is not about fences: a gate that infers a line's role from its
 * bytes is a guess, and this file already computes the answer once, in context,
 * for exactly this reason (see the classifier header). Prefer the reading.
 *
 * WHAT IS STILL EXPOSED, and what the measurement behind it does NOT cover:
 *
 *   - SETEXT. It is the one class that is both untagged by `normLineForCompare`
 *     (it falls through to the prose path deliberately, so an underline can
 *     never key-match a saved hr — MAR-161 M2) and marker-shaped: a bare `-`
 *     passes LIST_MARKER_RE. Probed, not merely reasoned about — the shapes
 *     tried produced byte-identical output with the gate removed, meaning they
 *     never reached this rule at all, so no arm had an answer. That makes it an
 *     UNVERIFIED residual rather than a known-safe one. The direction to fear is
 *     a re-spelling that writes a tab: four columns turns an underline into
 *     indented code and dissolves the heading.
 *   - A line the CLASSIFIER itself misreads, since the keys approximate the
 *     block parser rather than replicate it. Its known deliberate gap is
 *     indented code nested deep inside a list item classifying as prose.
 *
 * The 2471-move sweep says nothing about either. It drives the MOVE path only,
 * and both residuals live on the EDIT path — the sweep could not have reached
 * them whether or not they are real. What covers the edit path is this file's
 * unit tests, which is a smaller net. Saying otherwise is how the first cut of
 * this rule shipped: it rated its fence exposure narrow on reasoning, and
 * indenting a list inside a fence turned out to be an ordinary gesture.
 */
function respellMovedIndent(
    saved: string,
    savedWs: string,
    serial: string,
    serialWs: string,
    baseline: Map<string, string> | null,
    structural: boolean,
): string {
    if (!structural) return serial;
    if (!LIST_MARKER_RE.test(saved) || !LIST_MARKER_RE.test(serial)) return serial;
    if (normalizeOutlineIndent(savedWs) === serialWs) return serial;
    // An arm that answers with the serializer's own indent has not answered:
    // writing it back is the behaviour this rule exists to change, and letting
    // it stand would stop arm 2 from being consulted at all.
    const spells = (source: string | undefined): source is string =>
        source !== undefined && source !== serialWs;
    const local = depthPrefixOf(savedWs, serialWs);
    if (spells(local)) return local + serial.slice(serialWs.length);
    const witnessed = baseline ? sourceSpellingOf(baseline, serialWs) : undefined;
    if (!spells(witnessed)) return serial;
    if (!witnessed.startsWith(savedWs) && !savedWs.startsWith(witnessed)) return serial;
    return witnessed + serial.slice(serialWs.length);
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

/**
 * Does this replacement pair consist of two lines whose indentation is OUTLINE
 * STRUCTURE, rather than bytes the user authored?
 *
 * `normLineForCompare` tags every verbatim and non-prose class with a `\x00`
 * prefix — fence content (`\x00F`), indented code (`\x00C`), a thematic break
 * (`\x00B`) — so the classification the keys already carry answers this without
 * re-deriving it. That matters because it CANNOT be re-derived from a line in
 * isolation: `- item` is an outline bullet in prose and verbatim content inside
 * a fence, and `- - -` passes `LIST_MARKER_RE` while being a thematic break.
 *
 * Both keys are required to be untagged, not just the saved one. The pair's keys
 * always differ (an equal pair merges as a `keep`), so either side may be the
 * verbatim one — a bullet the user wrapped in a fence arrives as prose→fence,
 * and re-spelling the serializer's fence bytes from the saved line's outline
 * convention corrupts exactly as the reverse does.
 *
 * Refusing is the safe direction here, as it is everywhere else in this file:
 * a false negative leaves an indent canonicalized (cosmetic, and the status quo
 * before rule 3), a false positive writes invented whitespace into bytes the
 * user typed. Measured free: over 2471 executable move pairs across thirteen
 * outline shapes and six corpus fixtures, rule 3 closes the same 5 losses with
 * this gate as without it.
 */
const isStructuralPair = (keys: ReplacementKeys): boolean =>
    !keys.saved.startsWith("\x00") && !keys.serial.startsWith("\x00");

/** Markdown's `FormatProfile.reconcileReplacement`. Pure and total: every
 * branch falls back to the serializer's line, and neither pass can introduce a
 * newline. `facts` arrives typed `unknown` because the engine only stores and
 * returns it, so the shape is checked here rather than asserted — cheap, and it
 * is what keeps a protection built by some OTHER profile from being read as
 * this one's map once a second format exists. */
function reconcileReplacement(
    saved: string,
    serial: string,
    facts: unknown,
    keys: ReplacementKeys,
): string {
    const baseline = asBaselineFacts(facts)?.rendered ?? null;
    return carrySavedTableCells(
        saved,
        carrySavedIndent(saved, serial, baseline, isStructuralPair(keys)),
    );
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

/**
 * The two facts that decide whether a marker line could be the SIBLING of
 * another: the column the marker starts at, and its kind. The kind has to carry
 * the character itself rather than just "bullet vs ordered", because CommonMark
 * starts a new list whenever the bullet character or the ordered delimiter
 * changes — `- a` followed by `* b` is two lists, and a blank between two lists
 * is not either one's spread.
 *
 * Null for a line carrying no marker, and for a thematic break that merely
 * looks like one: `- - -` matches the marker shape but is a block of its own,
 * and a break takes precedence over an item, so it is nobody's sibling.
 */
function listMarkerAt(line: string): { column: number; kind: string } | null {
    if (THEMATIC_BREAK_RE.test(line)) return null;
    const m = LIST_MARKER_RE.exec(line);
    // The bullet characters and the ordered delimiters are disjoint sets, so
    // the raw character identifies the kind on its own.
    return m ? { column: columnWidth(m[1]), kind: m[2] ?? m[3] } : null;
}

/**
 * Are `prev` and `next` consecutive item markers of ONE list — the case where
 * the blank line between them is the list's SPREAD?
 *
 * This is the granularity `joinsAsLazyContinuation` cannot reach (MAR-293). It
 * asks whether gluing changes NEXT's own construct, and it does not: `- beta`
 * is a list item either way, so `isParagraphContinuation` rightly refuses a
 * line carrying a marker. What the blank decides here is a property of the
 * CONTAINER — a loose list wraps every item's content in a paragraph, a tight
 * one does not — so gluing one pair of a loose list changes the shape of both
 * items' content without changing either line's construct.
 */
function areListSiblings(prev: string, next: string): boolean {
    const a = listMarkerAt(prev);
    if (a === null) return false;
    const b = listMarkerAt(next);
    return b !== null && b.column === a.column && b.kind === a.kind;
}

// Would gluing `next` directly under `prev` change next's block-level
// construct — or, in the last arm, its container's? Only then is a
// serializer-emitted separating blank structure rather than style. Four arms
// (all verified against the real parser):
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
//     becomes lazy continuation text (MAR-289 — see the block above);
//   - and the one arm that is NOT about next's own construct: between two
//     sibling item markers the blank is the list's SPREAD, a property of the
//     container that changes both items' content shape (MAR-293 — the
//     reasoning, and why it cannot over-fire, is at the arm itself).
// Lines that delimit their own block (ATX headings, fence lines, `$$` math
// fences, thematic breaks) absorb nothing; legitimate saved files DO glue
// there (a heading directly above a directive), so no arm may fire on
// them: a zero-edit save must keep those bytes verbatim. Solid
// `***`/`___` runs, backtick fences, headings, and list markers all
// interrupt a paragraph, so their attachment never depends on the blank.
// This is the M1 dual rule (MAR-161).
/**
 * A bare list marker: a bullet or ordered marker with NOTHING after it. A task
 * checkbox counts as part of the marker, because an emptied task item is still
 * an empty item — the checkbox is the item's state, not its content.
 */
const BARE_LIST_MARKER_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?[ \t]*$/;

/**
 * Is a saved blank between a BARE list marker and the item's own indented
 * content the difference between the item keeping that content and losing it?
 *
 * An item that begins with a blank line keeps at most that blank: CommonMark
 * orphans everything after it OUT of the list. So when the serializer emits the
 * marker and the content contiguously, the saved blank is not spacing the user
 * chose — it is a claim about the parse the editor has overruled, exactly like
 * the lazy-continuation arm beside it. Keeping it reopens the item empty with
 * its rule or paragraph promoted to a top-level sibling (MAR-313).
 *
 * Narrow in both operands on purpose: `prev` must have nothing after the
 * marker, and `next` must sit at or past the item's content column, so the only
 * blank this can delete is one that provably orphans the line after it. Prose
 * can never be the left operand, which is what keeps it clear of a `---`
 * collapsing onto a paragraph and reparsing as a setext underline — and that
 * direction belongs to `glueChangesConstruct` regardless.
 */
const blankOrphansItemContent = (prev: string, next: string): boolean => {
    const marker = BARE_LIST_MARKER_RE.exec(prev);
    if (!marker) return false;
    return leadingColumns(next) >= columnWidth(marker[1]) + 2;
};

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
    // A serializer-emitted blank between two SIBLING item markers is the list's
    // spread, which is structure (MAR-293). Safe to fire because the serializer
    // does not guess this gap: `listItemGapJoin` (serialization.ts) replays the
    // gap each item recorded from the source at parse time, so for an untouched
    // pair the serializer re-emits exactly the saved bytes and this arm's own
    // precondition — saved glues, serializer separates — never holds. It can
    // only hold where the serializer has no recorded gap to replay, i.e. an
    // item the EDIT created, whose gap is then drawn from the list's spread.
    if (areListSiblings(prev, next)) return true;
    return joinsAsLazyContinuation(prev, next);
};

// ─── Output self-check: real list-nesting depth (MAR-323) ──────────────────
//
// A `keep` line writes the SAVED bytes verbatim (by design — that is what a
// minimal diff means), with no anchor-consistency check at all: the engine's
// keep branch is a straight push, unlike `reconcileInsertion`'s inserted
// lines. That is fine as long as a kept line's SURROUNDINGS have not
// changed — but a MOVE can relocate a block whose internal lines still key
// equal (same content, same `normalizeOutlineIndent`-canonical depth) to
// where they sat in the saved file, while the file's literal tab bytes now
// land at a REAL column (CommonMark tab stop 4) that collides with a
// DIFFERENT container newly adjacent to them. `normalizeOutlineIndent`
// treats one tab as exactly two canonical spaces — the approximation every
// rule in this file already leans on — but the real parser expands a tab to
// the next multiple of 4, and the two only coincide when nothing else in the
// document happens to have a content column sitting in the gap. A moved
// block's new neighbours are exactly where that stops being guaranteed.
//
// Getting the SPELLING right for every such case (extending the `reconcile*`
// machinery to keeps) would mean re-deriving, per line, whether the file's
// evidence for a depth is still safe in a brand new position — the general
// version of what `reconcileInsertion`'s anchor argument already fights hard
// to keep narrow. Cheaper and safer: compute what depth the merge ACTUALLY
// produced and compare it to what the serializer says it should be, the same
// output self-check `lineRoles` already runs for fence pairing (MAR-312/M4).
// A divergence degrades that one save to the serializer's own canonical
// bytes (cosmetic churn, borne once) rather than shipping a doc that
// reparses with an extra list level or a degraded table — the failure this
// exists to prevent is silent content loss, and a churned save is not that.
//
// `blankBefore` rides beside depth in the same role string because a bare
// marker line's hazard is adjacency, not nesting: a vacated item's `-`
// landing directly under a paragraph (no blank between) reads as a SETEXT
// UNDERLINE on reparse, converting that paragraph into a heading — the
// depth number alone is unchanged (the bogus heading is not a list
// construct at all), so the divergence would otherwise slip through.

/** A list marker's lead — bullet/ordinal plus its one required space/tab, or
 * end of line for a bare marker — consumed off the FRONT of already
 * whitespace-stripped text. `listDepths` walks a same-line marker CHAIN one
 * of these at a time: a vacated item whose only content is a nested list
 * collapses both onto one line (the serializer's own `- - foo` for "an item
 * with no text of its own"), opening two nesting levels at once. */
const MARKER_HEAD_RE = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

interface ListFrame {
    /** Real column (tab stop 4) of the marker that opened this level. */
    markerCol: number;
    /** Real column its content — and any sibling marker at this level —
     * must reach. */
    contentCol: number;
}

/**
 * The list/outline nesting DEPTH of every line — how many list items
 * contain it — resolved the way the real parser does: REAL columns
 * (`leadingColumns`, tab stop 4) rather than this file's own canonical
 * approximation, and DEPTH-FIRST (a marker indented deep enough to satisfy
 * the INNERMOST open item nests inside it, even where a shallower list
 * would also have accepted it — CommonMark does not prefer the shallow
 * reading just because one exists).
 *
 * Fence interiors and indented code do not participate in marker chaining —
 * their leading whitespace is user bytes, not structure — but they still
 * pop the stack on a genuine outdent, so depth stays meaningful for
 * whatever follows them.
 */
function listDepths(lines: readonly string[], classes: readonly LineClass[]): number[] {
    const stack: ListFrame[] = [];
    const depths: number[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "") {
            depths.push(stack.length);
            continue;
        }
        const startCol = leadingColumns(line);
        // A spaced thematic break (`- - -`) matches MARKER_HEAD_RE as a
        // chain of bare markers — the chain that opens a level per marker is
        // exactly right for a vacated item's `- - foo` collapse, and exactly
        // wrong for a `-`-style hr, which is one line of styling, not three
        // nested empty items. Verbatim spans skip the chain for the same
        // reason: their leading whitespace is content, not structure.
        if (
            classes[i] === "fence-raw" ||
            classes[i] === "fence-nested" ||
            classes[i] === "code" ||
            THEMATIC_BREAK_RE.test(line)
        ) {
            while (stack.length > 0 && startCol < stack[stack.length - 1].contentCol) stack.pop();
            depths.push(stack.length);
            continue;
        }
        let col = startCol;
        let rest = line.slice(indentOf(line).length);
        for (;;) {
            const m = MARKER_HEAD_RE.exec(rest);
            if (!m) break;
            const width = m[0].length;
            if (stack.length > 0 && col >= stack[stack.length - 1].contentCol) {
                // Deep enough to nest inside whatever is currently open.
                stack.push({ markerCol: col, contentCol: col + width });
            } else {
                while (stack.length > 0 && col < stack[stack.length - 1].markerCol) stack.pop();
                if (stack.length > 0 && col < stack[stack.length - 1].contentCol) {
                    // A sibling at the now-current level.
                    stack[stack.length - 1] = { markerCol: col, contentCol: col + width };
                } else {
                    stack.push({ markerCol: col, contentCol: col + width });
                }
            }
            col += width;
            rest = rest.slice(width);
        }
        while (stack.length > 0 && col < stack[stack.length - 1].contentCol) stack.pop();
        depths.push(stack.length);
    }
    return depths;
}

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
    // The merge's output self-check. Two independent signals, both compared
    // positionally against the serializer's own text (see the engine's
    // `lineRoles` doc) and both cheap to get wrong in the SAFE direction —
    // over-firing only costs a churned save, never a wrong one:
    //   - fence pairing: a ``` run cannot close a `~~~` fence, in the
    //     classifier exactly as in CommonMark, so a mismatched-pair splice
    //     shows up as a verbatim/content flip on the lines after it
    //     (MAR-312/M4). Unconditional — every merge pays this, as before.
    //   - real list-nesting depth (MAR-323, `listDepths`), GATED on
    //     `hadRelocatedContent`: a `keep` line's saved bytes can land at a REAL
    //     column (tab stop 4) the file's own canonical-depth model never
    //     priced in, once a move relocates it beside a different container.
    //     Outside a relocated merge this file's normal indent-carrying rules
    //     (`carrySavedIndent` and friends) can legitimately leave two
    //     conventions beside each other on purpose — MAR-222's "an indent
    //     the file renders two ways is dropped, not guessed" is exactly
    //     that, no move involved — and this profile's real-tab-stop-4 model
    //     disagreeing with its OWN two-canonical-spaces approximation there
    //     is not a bug to report, just two ways of counting columns. Gating
    //     is what keeps this role from re-litigating a settled trade-off.
    //   - ONE exception to blank-insensitivity, scoped as narrowly as the
    //     hazard it answers and gated the same way: a BARE list marker
    //     (`BARE_LIST_MARKER_RE`) is a construct whose MEANING turns on the
    //     blank immediately above it — glued to a paragraph, it is a setext
    //     underline, converting that paragraph into a heading, with the
    //     depth number unchanged (the bogus heading is not a list construct
    //     at all, so depth alone would miss it). Every other line's blank
    //     spacing is styling the merge legitimately preserves from the saved
    //     file even when the serializer would have written it differently.
    lineRoles(lines, hadRelocatedContent) {
        const ls = lines as string[];
        const classes = classifyLines(ls);
        if (!hadRelocatedContent) {
            return classes.map((c) =>
                c === "fence-raw" || c === "fence-nested" ? "verbatim" : "content",
            );
        }
        const depths = listDepths(ls, classes);
        return classes.map((c, i) => {
            if (c === "fence-raw" || c === "fence-nested") return "verbatim";
            if (BARE_LIST_MARKER_RE.test(ls[i])) {
                const blankBefore = i === 0 || ls[i - 1].trim() === "";
                return `content:${depths[i]}:${blankBefore ? "b" : "-"}`;
            }
            return `content:${depths[i]}`;
        });
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
        (isQuoteLine(prev) && isQuoteLine(next)) ||
        joinsAsLazyContinuation(prev, next) ||
        blankOrphansItemContent(prev, next),
    reconcileReplacement,
    baselineFacts: baselineFactsOf,
    indentIsContent,
    losesOpaqueContent,
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
