/**
 * Format-agnostic serialize-then-minimal-diff engine.
 *
 * A serializer re-emits the entire document on every edit, which would
 * silently reformat regions the user never touched. Instead of writing the
 * serializer output verbatim, this engine LCS-diffs its significant
 * (non-blank) lines against the saved file and applies only the real content
 * changes (`applyMinimalChanges`).
 *
 * On top of the line diff sits round-trip protection
 * (`computeRoundTripProtection`): constructs the parser cannot reproduce are
 * dropped or rewritten by a zero-edit round trip, so they appear changed in
 * every serialization even though the user never touched them. Protection
 * records those regions at load time and REPAIRS the serializer output before
 * the diff: each region's canonical replacement lines are swapped back for
 * the original saved bytes (dropped constructs are re-inserted next to their
 * anchors, and lines the serializer synthesizes with no saved counterpart —
 * e.g. a close fence for an unclosed one — are deleted). The repaired text
 * then diffs against the saved file with
 * the plain merge — protected lines become ordinary `keep`s. If the user
 * edits the construct itself, its serialized form no longer matches the
 * recorded canonical lines, no repair happens, and the edit applies normally:
 * the canonical form wins on touched lines.
 *
 * Everything format-specific — how lines are keyed for comparison, and which
 * blank lines are structure rather than style — is injected via a
 * `FormatProfile`. Markdown's profile (the first and so far only one) lives
 * with the consumer, in `webview/utils/minimalDiff.ts`.
 */

/**
 * The format-specific half of the engine. A profile must guarantee that
 * saved and serialized text key CONSISTENTLY (identical neighborhoods yield
 * identical keys) and that no two different constructs share a key — the
 * engine pairs lines purely by key equality.
 */
export interface FormatProfile {
    /**
     * Comparison key for every line of a document, computed in one contextual
     * pass (classification may need fence state, blank adjacency, ...).
     * Formatting-only variants of the same construct must key equal; lines of
     * different constructs must never key equal. MUST return exactly one key
     * per input line (enforced): out-of-range lookups would yield `undefined`
     * keys, which pair with each other as `keep`s and silently swallow real
     * edits. Keys returned for blank (whitespace-only) lines are ignored —
     * blanks never participate in the diff. Lines arrive WITHOUT their line
     * ending (see "Line endings" below) — a profile never sees a `\r`.
     */
    keyLines(lines: string[]): string[];
    /**
     * Would gluing `next` directly under `prev` (removing the blank run
     * between them) change next's block-level construct? When true, a
     * serializer-emitted separating blank is structure rather than style, and
     * the merge lets it win over the saved bytes' glued form.
     */
    glueChangesConstruct(prev: string, next: string): boolean;
    /**
     * Would a blank line between `prev` and `next` split what the serializer
     * now emits as ONE block? When true and the serializer keeps the two
     * lines contiguous, a saved blank between them was a block separator the
     * edit dissolved, and the merge drops it.
     */
    blankSplitsBlock(prev: string, next: string): boolean;
    /**
     * An in-place replacement is about to commit the serializer's bytes for a
     * line whose neighbours are unchanged. Return the bytes to write instead —
     * the profile's chance to carry source-only facts (indent unit, untouched
     * sub-line parts) that the serializer canonicalized away. MUST return a
     * single line — no `\n` and no `\r`, since the engine owns line endings and
     * re-attaches the saved line's own; a return containing either is rejected
     * and the serializer's line is used instead. MUST default to `serial`
     * unchanged.
     *
     * This is the philosophy the keys already express — "a difference the
     * profile considers formatting-only is never applied" — extended from
     * whole-line to SUB-LINE granularity. A `keep` writes the saved bytes, but
     * a replacement used to write the serializer's line wholesale, so every
     * formatting-only part of an edited line (its outline indent unit, a table
     * cell the user never touched) was canonicalized as collateral damage
     * while its untouched neighbours kept theirs — leaving two conventions
     * mixed inside one construct (MAR-213 / MAR-214).
     *
     * `facts` is whatever `baselineFacts` distilled for this file, or null when
     * no protection was computed. A profile MUST treat it as untrusted (it
     * round-trips through the caller's cache) and MUST behave correctly without
     * it.
     */
    reconcileReplacement(saved: string, serial: string, facts: unknown): string;
    /**
     * Distill whatever the zero-edit baseline round trip teaches about how THIS
     * file is written, for `reconcileReplacement` to consult on every later
     * save. Each pair is one saved line beside the bytes the serializer emitted
     * for it before any edit, so a profile can learn the file's own conventions
     * (markdown uses it to learn which source indent the serializer renders as
     * which canonical indent — see MAR-222) instead of guessing them from a
     * single line in isolation.
     *
     * Optional, and deliberately whole-file: a convention is only knowable by
     * looking at every line that shares it, including the ones that round-trip
     * cleanly. The returned value is opaque to the engine, which only stores it
     * on the protection and hands it back.
     *
     * STALENESS is the profile's problem, and it is not hypothetical. Like the
     * regions beside it, this is distilled ONCE, from the document as loaded —
     * but where a stale region merely stops matching (it protects nothing, and
     * nothing is harmed), a stale FACT keeps being handed to every later
     * reconcile, including for lines and constructs that did not exist at
     * baseline. So whatever a profile distills here must be safe to apply to a
     * line the pairing never saw: prefer facts that can only ever GRANT a
     * concession the profile would otherwise refuse, and scope them to
     * something checkable on the line in front of you.
     *
     * Only lines the round trip PAIRED appear — unchanged lines, in-place
     * rewrites, and runs it merely re-indented line by line; a construct the
     * serializer drops outright has no counterpart and is omitted, and so does
     * a run it rewrote deeply enough that no correspondence is visible in the
     * bytes (`pairBaselineLines`). Lines arrive as content, without their line
     * endings.
     */
    baselineFacts?(pairs: readonly BaselineLinePair[]): unknown;
    /**
     * Distill what the merge NOW BEING PERFORMED teaches about how this file is
     * written, from its own `keep` pairs — each one a saved line beside the
     * bytes the serializer just emitted for it. Same pair shape as
     * `baselineFacts`, asking the same question, but answered against the file
     * as it stands rather than as it loaded.
     *
     * That difference is the whole point, and it runs the opposite way from
     * `baselineFacts`' staleness warning: these facts cannot go stale, because
     * they are re-derived from the very lines this merge is about to write. A
     * spelling learned here is in the output by construction.
     *
     * Only `keep`s are offered. A kept line's two sides are guaranteed to be one
     * line in two spellings — the merge is writing the saved bytes back
     * precisely because the profile keyed them equal. An in-place replacement
     * would be a weaker witness (the user may have re-indented the line as part
     * of the edit, in which case its saved and serialized indents describe
     * different depths), and the whole value of this hook is that its evidence
     * is beyond doubt.
     *
     * Optional; only consulted when `reconcileInsertion` is also implemented.
     */
    mergeFacts?(pairs: readonly BaselineLinePair[]): unknown;
    /**
     * A RUN of pure insertions — every line the merge is about to write from
     * the serializer's bytes before the next kept or replaced line — is about
     * to be committed. Return the bytes to write instead: the profile's chance
     * to spell them the way THIS file spells them. MUST return exactly one line
     * per input, none containing `\n` or `\r`, and MUST default to the input
     * unchanged; any other return is rejected wholesale and the serializer's
     * lines are used.
     *
     * An insertion has no saved counterpart, which is why its bytes have always
     * come from the serializer verbatim. But it does not land in a vacuum: it
     * lands BETWEEN saved lines, and the serializer emits one canonical
     * convention while the file around it may use another. Where the convention
     * carries meaning, that mismatch is not cosmetic — in markdown an inserted
     * list line indented with the serializer's two spaces, dropped between kept
     * lines indented with tabs, sits at a different depth than the one the user
     * is looking at, and the file reparses into a different tree (MAR-230).
     *
     * The RUN, rather than the line, is the unit on purpose. Inserted lines
     * arrive as a block — a moved list item is its marker line plus everything
     * beneath it — and within that block the indentation is RELATIVE: an
     * over-indented line inside a code fence means something only with respect
     * to the fence that opened above it. Respelling each line by an independent
     * lookup silently rewrites those relationships (it turned nested fence
     * content into an indented code block, losing the fence). Handed the whole
     * run, a profile can re-base it and leave its interior geometry alone.
     *
     * `preceding` is the last significant line the merge actually emitted (its
     * content, without the line ending), or null when the run opens the
     * document. It is not context for its own sake — it is what makes the hook
     * SAFE, and omitting it made this engine lose data. A file-wide fact says
     * how the document spells something; it cannot say whether the specific
     * line this run lands under is spelled that way. In markdown the two come
     * apart whenever the neighbour above is an in-place replacement that
     * legitimately took the serializer's canonical indent: re-basing the
     * insertion onto the file's tabs beneath a parent now written with the
     * serializer's spaces mixes two conventions inside ONE parent/child
     * relationship — the exact damage the hook exists to prevent, and it
     * destroyed list items five levels deep in a plain tab outline. A profile
     * must reconcile the run with this line, not merely with the file.
     *
     * `facts` is whatever `mergeFacts` distilled from this merge's keeps, or
     * null when the profile implements no distiller. Each line's `key` is its
     * own comparison key, exactly as `keyLines` produced it in full document
     * context — so a profile can consult the classification it has already made
     * (which lines are verbatim content rather than structure) instead of
     * re-deriving it from a line in isolation, which it cannot do correctly.
     *
     * `baselineFacts` is `baselineFacts`' opaque result for this file — the same
     * value `reconcileReplacement` receives — or null when the file carries no
     * protection. It is here because `preceding`, and the run's own lines, can
     * arrive wearing bytes the SERIALIZER never wrote: `repairSerialized` runs
     * before the diff, so a protected construct reaches this hook spelled the
     * way the saved file spells it, inside a stream that is otherwise canonical.
     * A profile reasoning about which convention a neighbouring line is in
     * therefore cannot answer from this merge's keeps alone — the baseline round
     * trip is the only record of what the file's own spellings are (MAR-297).
     * Same caveat as everywhere else it is used: it is distilled ONCE at load
     * and the saved text moves under it, so it may only ever GRANT, never veto.
     */
    reconcileInsertion?(
        lines: readonly InsertedLine[],
        preceding: string | null,
        facts: unknown,
        baselineFacts: unknown,
    ): readonly string[];
}

/** One line of an insertion run: the serializer's bytes and its comparison
 *  key — see `reconcileInsertion`. */
export interface InsertedLine {
    serial: string;
    key: string;
}

/** One saved line beside its zero-edit serialization — see `baselineFacts`. */
export interface BaselineLinePair {
    saved: string;
    serial: string;
}

// ─── Line endings ───────────────────────────────────────────────────────────
//
// A line ending is a property of the FILE, not of a line's content, so the
// ENGINE owns it and the profile never sees one. Without that, a CRLF document
// keys every line differently from the serializer's LF output and a zero-edit
// round trip diffs as a whole-file rewrite: round-trip protection — meant for
// constructs the parser cannot reproduce — gets spent entirely on holding the
// `\r`s, and editing anything unprotects its whole region and writes it back
// LF-only, leaving the file with mixed endings (MAR-223).
//
// Three rules, which together preserve invariant A (a zero-edit save is
// byte-identical) even for a file whose endings are ALREADY mixed:
//   • keys and the structure predicates run on ending-stripped lines, so
//     CRLF↔LF is a formatting-only difference the merge never applies and an
//     odd-ending line stays a `keep` instead of becoming a replacement;
//   • every line that comes from the SAVED file — `keep`s, and the saved side
//     of an in-place replacement — keeps its own ending verbatim, so a mixed
//     file is never silently normalized;
//   • only lines the engine invents (insertions and the serializer's blank
//     runs, which have no saved counterpart) need an ending chosen for them,
//     and they get the document's dominant one.
//
// One subtlety runs through all three: a `\n` split's LAST element is not a
// line, it is the text AFTER the final ending, so it has no ending of its own.
// Both directions of getting that wrong are real. Treating a `\r` there as a
// terminator relocates a content CR onto a different line (a classic-Mac file,
// or a stray CR fragment). Treating the segment as terminated is worse: when
// the merge emits anything after it — an append to a CRLF file that has no
// trailing newline — `out.join("\n")` silently gives it an LF, reintroducing
// exactly the mixed-ending file this whole mechanism exists to prevent.

/** A line's own ending (`"\r"` when the split left one). Never call this for a
 *  split's final segment — see the note above; it has no ending. */
function eolOf(line: string): string {
    return line.endsWith("\r") ? "\r" : "";
}

/** Line CONTENT — what the profile is allowed to see. */
function stripEol(line: string): string {
    return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * The ending invented lines should get: whichever the saved file uses for most
 * of its lines, LF on a tie and for a file with no line ending at all. Only
 * invented lines consult this — untouched ones keep their own bytes.
 */
function dominantEol(saved: string): "\n" | "\r\n" {
    let crlf = 0;
    let lf = 0;
    for (let i = saved.indexOf("\n"); i !== -1; i = saved.indexOf("\n", i + 1)) {
        if (i > 0 && saved[i - 1] === "\r") crlf++;
        else lf++;
    }
    return crlf > lf ? "\r\n" : "\n";
}

/**
 * Re-emit the serializer's output (always LF) with `eol`, so every
 * serializer-sourced line is already correct by the time the merge picks lines
 * from it. A no-op for an LF document, which is why this whole mechanism is
 * invisible outside CRLF files.
 */
function matchEol(serialized: string, eol: "\n" | "\r\n"): string {
    return eol === "\r\n" ? serialized.replace(/\r?\n/g, "\r\n") : serialized;
}

/**
 * Call `profile.reconcileReplacement` defensively. The merge's line accounting
 * is one-line-in / one-line-out, so a profile that throws or hands back a
 * multi-line string degrades to the serializer's line (the behaviour before
 * the hook existed) instead of corrupting the output.
 *
 * The profile works on content alone; the SAVED line's own ending is re-attached
 * afterwards, so editing a line never changes which ending that line has.
 * `savedTerminated` is false for the split's final segment, whose trailing `\r`
 * (if any) is content rather than an ending.
 */
function reconcileLine(
    profile: FormatProfile,
    saved: string,
    serial: string,
    savedTerminated: boolean,
    facts: unknown,
): string {
    const eol = savedTerminated ? eolOf(saved) : "";
    const savedContent = savedTerminated ? stripEol(saved) : saved;
    const fallback = stripEol(serial) + eol;
    let out: string;
    try {
        out = profile.reconcileReplacement(savedContent, stripEol(serial), facts);
    } catch {
        return fallback;
    }
    return typeof out === "string" && !/[\n\r]/.test(out) ? out + eol : fallback;
}

/**
 * Call `profile.reconcileInsertion` defensively, on the same terms as
 * `reconcileLine`: the run's line accounting is N in / N out, and any throw,
 * wrong length, or embedded line ending degrades the WHOLE run to the
 * serializer's bytes (the behaviour before the hook existed) rather than
 * corrupting the output. All-or-nothing because the run is re-based as a unit —
 * keeping some of a profile's answer and discarding the rest would produce a
 * block indented two different ways, which is the very damage this exists to
 * prevent.
 *
 * The profile works on content alone. An insertion's ending is the
 * serializer's, already normalized to the document's by `matchEol`, so it is
 * stripped and re-attached rather than consulted. A line is handed over
 * stripped unless it is the serial split's FINAL segment, whose trailing `\r`
 * (if any) is content rather than an ending — the same rule `reconcileLine`
 * applies to the saved side. (One consequence, benign and shared with that
 * function: a content `\r` reaching the profile comes back in the returned
 * string and trips the no-embedded-endings check below, so a run ending in a
 * stray CR degrades to the serializer's bytes instead of being re-based.)
 */
function reconcileInsertedRun(
    profile: FormatProfile,
    run: readonly SigLine[],
    lastSerialIdx: number,
    preceding: string | null,
    facts: unknown,
    baselineFacts: unknown,
): string[] {
    const raw = run.map((l) => l.text);
    if (!profile.reconcileInsertion) return raw;
    const eols = run.map((l) => (l.lineIdx !== lastSerialIdx ? eolOf(l.text) : ""));
    const lines: InsertedLine[] = run.map((l) => ({
        serial: l.lineIdx !== lastSerialIdx ? stripEol(l.text) : l.text,
        key: l.norm,
    }));
    let out: readonly string[];
    try {
        out = profile.reconcileInsertion(lines, preceding, facts, baselineFacts);
    } catch {
        return raw;
    }
    if (!Array.isArray(out) || out.length !== run.length) return raw;
    if (out.some((line) => typeof line !== "string" || /[\n\r]/.test(line))) return raw;
    return out.map((line, i) => line + eols[i]);
}

interface SigLine {
    text: string;
    lineIdx: number;
    /** Profile comparison key — computed once here so every consumer (the
     * LCS, region anchors, repair matching) keys the same line identically. */
    norm: string;
}

type Edit =
    | { op: "keep"; saved: SigLine; serial: SigLine }
    | { op: "del"; saved: SigLine }
    | { op: "ins"; serial: SigLine };

/** Significant (non-blank) lines with their comparison keys. Keying needs the
 * FULL line array (classification context), so it happens here, before blanks
 * are dropped. */
function analyzeLines(lines: string[], profile: FormatProfile): SigLine[] {
    const last = lines.length - 1;
    const keys = profile.keyLines(lines.map((l, i) => (i === last ? l : stripEol(l))));
    if (keys.length !== lines.length) {
        throw new Error("FormatProfile.keyLines must return exactly one key per line");
    }
    const sig: SigLine[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() !== "") {
            sig.push({ text: lines[i], lineIdx: i, norm: keys[i] });
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
function computeEditScript(saved: string, serialized: string, profile: FormatProfile): {
    edits: Edit[];
    savedLines: string[];
    serialLines: string[];
} {
    const savedLines = saved.split("\n");
    const serialLines = serialized.split("\n");
    const savedSig = analyzeLines(savedLines, profile);
    const serialSig = analyzeLines(serialLines, profile);
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
 * re-insertion instead. When `savedSpanLines` is empty the region is a
 * SUPPRESSION: lines the serializer synthesizes with no saved counterpart
 * (e.g. the close fence it emits for a document ending in an unclosed code
 * fence) — the repair pass deletes them so a save never writes them. A
 * suppression's identity lives entirely in its anchors, so repair demands
 * BOTH of them (a rewrite needs only one): once the user edits either
 * neighbor the synthetic lines are written after all — the canonical form
 * wins on touched constructs, same as everywhere else in this engine.
 */
interface ProtectedRegion {
    savedSpanLines: string[];
    insNorms: string[];
    anchorPrevNorm: string | null;
    anchorNextNorm: string | null;
}

export interface RoundTripProtection {
    regions: ProtectedRegion[];
    /** `FormatProfile.baselineFacts`' opaque result for this file, if any. It
     *  rides along here because protection is already computed exactly where
     *  the baseline serialization exists and is already threaded to every
     *  merge — see `baselineFacts`. */
    baselineFacts?: unknown;
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
    profile: FormatProfile,
): RoundTripProtection | null {
    // No EOL handling here: keys are ending-blind and a region records the
    // serializer side only as keys, so an LF baseline against a CRLF file
    // yields the same regions either way. `applyMinimalChanges` — including
    // the self-check below — remains the single place endings are reconciled.
    const { edits, savedLines } = computeEditScript(saved, baselineSerialized, profile);
    if (!edits.some((e) => e.op !== "keep")) return null;

    const baselineFacts = profile.baselineFacts?.(pairBaselineLines(edits, savedLines.length - 1));

    // Self-check: protection must reproduce the saved bytes exactly when the
    // serializer output is the baseline itself. The per-construct split
    // pairs del/ins adjacency groups positionally, which can mis-pair exotic
    // runs (e.g. a dropped construct sharing a run with a construct whose
    // canonical form has a different line count) — repairing with wrong
    // bytes is worse than canonicalization, so fall back to the fused
    // region. `allowSplit` governs the finer per-line split as well, so both
    // granularities share this one retreat. Note what it can and cannot
    // catch: a mis-paired split that still reproduces the baseline passes
    // here and only misbehaves once the user edits one of its lines, which is
    // why the splits are gated on evidence rather than on this check.
    // Suppression regions get the same discipline: if including them
    // fails the self-check, retry without them (never worse than the
    // pre-suppression engine), and if nothing can reproduce the baseline,
    // ship no protection at all.
    for (const suppressInsertions of [true, false]) {
        for (const allowSplit of [true, false]) {
            const regions = buildProtectedRegions(edits, savedLines, allowSplit, suppressInsertions);
            if (regions.length === 0) continue;
            const protection = { regions, baselineFacts };
            if (applyMinimalChanges(saved, baselineSerialized, profile, protection) === saved) {
                return protection;
            }
        }
    }
    return null;
}

/**
 * Pair each saved line with the bytes the zero-edit round trip emitted for it.
 * Two shapes qualify, and only two:
 *
 *   - a `keep` — the serializer reproduced the line, possibly in a different
 *     spelling that keys equal, which is exactly the interesting case;
 *   - a run consisting of EXACTLY one `del` and one `ins`, the same isolated
 *     adjacency the merge itself calls an in-place replacement.
 *
 *   - a run whose two sides correspond LINE BY LINE, in the narrow sense
 *     `positionalRunPairs` defines: same number of dels and inses, and each
 *     i-th pair identical apart from its leading whitespace.
 *
 * Everything else in a non-keep run is left unpaired on purpose. A `del` with
 * no `ins` is a construct the serializer dropped outright, so no counterpart
 * exists. And a longer run does not interleave: the LCS emits all its dels and
 * then all its inses, so "a del immediately followed by an ins" would pair the
 * run's LAST saved line with its FIRST serialized one — lines that have nothing
 * to do with each other. Pairing such a run by ADJACENCY is the temptation
 * `buildProtectedRegions` resists just below, and the stakes here are higher: an
 * absent fact costs a profile nothing (it falls back to whatever it did before),
 * while a WRONG one is a confident lie about the file. What makes the third
 * shape admissible is that it does not guess the correspondence — it declines
 * unless the bytes exhibit one (see `positionalRunPairs`).
 *
 * `lastSavedIdx` is the saved split's final segment, whose trailing `\r` is
 * content rather than an ending (see "Line endings" above); every other line is
 * handed over stripped, exactly as `reconcileLine` does.
 */
function pairBaselineLines(edits: Edit[], lastSavedIdx: number): BaselineLinePair[] {
    const pairs: BaselineLinePair[] = [];
    const savedContent = (line: SigLine): string =>
        line.lineIdx === lastSavedIdx ? line.text : stripEol(line.text);
    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        if (edit.op === "keep") {
            pairs.push({ saved: savedContent(edit.saved), serial: stripEol(edit.serial.text) });
            continue;
        }
        // Walk the whole non-keep run, then take it only if it is a lone
        // del/ins couple or corresponds line by line.
        const start = i;
        while (i < edits.length && edits[i].op !== "keep") i++;
        const run = edits.slice(start, i);
        i--; // the outer loop's own increment steps past the run's last edit
        if (run.length === 2 && run[0].op === "del" && run[1].op === "ins") {
            pairs.push({
                saved: savedContent((run[0] as Extract<Edit, { op: "del" }>).saved),
                serial: stripEol((run[1] as Extract<Edit, { op: "ins" }>).serial.text),
            });
            continue;
        }
        for (const pair of positionalRunPairs(run, lastSavedIdx) ?? []) {
            pairs.push({
                saved: savedContent(pair.saved),
                serial: stripEol(pair.serial.text),
            });
        }
    }
    return pairs;
}

/** A line's content with its leading whitespace removed — everything the
 *  serializer preserved verbatim when all it changed was the indentation. */
function bodyOf(line: string): string {
    return line.replace(/^[ \t]+/, "");
}

/**
 * The line-by-line correspondence of a non-keep run, or null when the run does
 * not exhibit one.
 *
 * A run's dels and its inses are, by construction, the same contiguous span of
 * the document before and after the round trip, so IF each saved line has
 * exactly one serialized counterpart, that counterpart is the one at the same
 * position — a serializer re-emits a span, it does not reorder it. The whole
 * question is the "if": a span where one construct was dropped and another
 * expanded has equal line counts on both sides and no line-wise correspondence
 * at all, and pairing it positionally teaches a confident lie (MAR-222's first
 * cut mispaired one such run, taught the dictionary that six spaces render as
 * two, and corrupted an unrelated list).
 *
 * So this does not infer the correspondence from the line COUNTS, which is the
 * step that goes wrong. It requires the bytes to show one: every pair identical
 * apart from its leading whitespace, meaning the round trip changed nothing
 * about those lines except how far in they sit. That is both the strongest
 * witness available (a differing body could be anything) and exactly the case
 * the missing facts are about — two adjacent lines sharing an unusual indent,
 * which collapse into one 2-del/2-ins run and so teach nothing (MAR-231).
 *
 * Order within the run is not consulted: dels and inses are collected
 * separately, each in document order, so an interleaved run pairs the same way
 * a grouped one does.
 */
function positionalRunPairs(
    run: readonly Edit[],
    lastSavedIdx: number,
): { saved: SigLine; serial: SigLine }[] | null {
    const dels = run.filter((e): e is Extract<Edit, { op: "del" }> => e.op === "del");
    const inses = run.filter((e): e is Extract<Edit, { op: "ins" }> => e.op === "ins");
    if (dels.length === 0 || dels.length !== inses.length) return null;
    const pairs = dels.map((d, i) => ({ saved: d.saved, serial: inses[i].serial }));
    for (const pair of pairs) {
        const saved = pair.saved.lineIdx === lastSavedIdx ? pair.saved.text : stripEol(pair.saved.text);
        if (bodyOf(saved) !== bodyOf(stripEol(pair.serial.text))) return null;
    }
    return pairs;
}

/**
 * Pair each KEPT line with the bytes the serializer emitted for it in the merge
 * now being performed — `mergeFacts`' evidence.
 *
 * Deliberately narrower than `pairBaselineLines`, which also accepts a lone
 * del/ins couple and a run that corresponds line by line: see `mergeFacts` for
 * why only a `keep` is a witness strong enough to spell an inserted line from.
 */
function pairKeptLines(edits: Edit[], lastSavedIdx: number): BaselineLinePair[] {
    const pairs: BaselineLinePair[] = [];
    for (const edit of edits) {
        if (edit.op !== "keep") continue;
        pairs.push({
            saved: edit.saved.lineIdx === lastSavedIdx
                ? edit.saved.text
                : stripEol(edit.saved.text),
            serial: stripEol(edit.serial.text),
        });
    }
    return pairs;
}

/** Build protected regions from a baseline edit script. */
function buildProtectedRegions(
    edits: Edit[],
    savedLines: string[],
    allowSplit: boolean,
    suppressInsertions: boolean,
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

        const prevKeep = start > 0 ? (edits[start - 1] as Extract<Edit, { op: "keep" }>) : null;
        const nextKeep = k < edits.length ? (edits[k] as Extract<Edit, { op: "keep" }>) : null;
        const anchorPrevNorm = prevKeep ? prevKeep.saved.norm : null;
        const anchorNextNorm = nextKeep ? nextKeep.saved.norm : null;

        if (dels.length === 0) {
            // Pure insertion at baseline: the serializer synthesized these
            // lines out of nothing, so there are no saved bytes to pin —
            // instead record a suppression region that deletes them from
            // later serializations (invariant A: a zero-edit save never
            // rewrites the file).
            if (suppressInsertions) {
                regions.push({
                    savedSpanLines: [],
                    insNorms: inses.map((i) => i.serial.norm),
                    anchorPrevNorm,
                    anchorNextNorm,
                });
            }
            continue;
        }

        // Split the run into per-construct sub-regions when both sides break
        // into the same number of adjacency groups (consecutive line numbers
        // = one construct). Two rewritten constructs changed in one run
        // otherwise become an all-or-nothing region: editing one would
        // unprotect both.
        //
        // ADJACENT LINES ARE ONE GROUP, which is as far as that goes on its
        // own: two neighbouring lines the round trip merely re-indented are
        // consecutive on both sides, so they form a single region and editing
        // either one canonicalizes the other's indentation as collateral
        // damage (MAR-231). Where the run corresponds line by line —
        // `positionalRunPairs`' narrow test, not "the counts match" — each
        // line's canonical form is exactly its own counterpart, so the region
        // can be split that far and an edit unprotects only the line it
        // touched.
        const perLine = allowSplit ? positionalRunPairs(run, savedLines.length - 1) : null;
        const delGroups = groupByAdjacency(dels.map((d) => d.saved));
        const insGroups = inses.length > 0 ? groupByAdjacency(inses.map((i) => i.serial)) : [];
        const pairable = allowSplit && insGroups.length > 0 && delGroups.length === insGroups.length;
        const subRegions = perLine
            ? perLine.map((p) => ({ delSpan: [p.saved], insSpan: [p.serial] }))
            : pairable
                ? delGroups.map((dg, gi) => ({ delSpan: dg, insSpan: insGroups[gi] }))
                : [{ delSpan: dels.map((d) => d.saved), insSpan: inses.map((i) => i.serial) }];

        for (let gi = 0; gi < subRegions.length; gi++) {
            const sub = subRegions[gi];
            const first = sub.delSpan[0].lineIdx;
            const last = sub.delSpan[sub.delSpan.length - 1].lineIdx;
            // Anchors must bound THIS sub-region, not the whole run. Handing
            // every sub-region the run's outer keeps is wrong the moment a run
            // splits: the inner sub-regions' real neighbours are the sibling
            // sub-regions, and anchors are matched against the PRISTINE
            // serialization (see repairSerialized), where the siblings appear
            // in their canonical form and adjacent to each other.
            //
            // Getting this wrong corrupts documents rather than merely
            // canonicalizing them. `a * b` + a `~~~` fence share one run (the
            // blank line between them is insignificant): the fence-open
            // sub-region inherited the run's `anchorPrev = null` — "document
            // start" — which cannot match, while its `anchorNext` is the line
            // the user just edited. Score 0, so the open fence stood down and
            // was written canonically as ``` while the CLOSE fence, whose
            // anchor still hit, was repaired back to `~~~`. The mismatched pair
            // swallowed every following block into the code block on reopen.
            const prevSub = subRegions[gi - 1];
            const nextSub = subRegions[gi + 1];
            regions.push({
                savedSpanLines: savedLines.slice(first, last + 1),
                insNorms: sub.insSpan.map((s) => s.norm),
                anchorPrevNorm: prevSub
                    ? prevSub.insSpan[prevSub.insSpan.length - 1].norm
                    : anchorPrevNorm,
                anchorNextNorm: nextSub ? nextSub.insSpan[0].norm : anchorNextNorm,
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
function repairSerialized(
    serialized: string,
    protection: RoundTripProtection,
    profile: FormatProfile,
    /** Ending for the blank separators below — the only lines this function
     *  invents rather than copying from the saved or serialized side. */
    eol: "\n" | "\r\n",
): string {
    // Every region is matched against ONE analysis of the pristine
    // serialized text. Repairs swap serializer-canonical lines for saved
    // bytes, which can change the classification context of LATER lines
    // (e.g. in markdown, restoring a `~~~` fence open makes the serializer's
    // following ``` close line look like content of an unclosed tilde fence) — so
    // re-analyzing after each splice would invalidate the very norms the
    // regions were recorded under, the later regions would stop matching,
    // and protection's self-check would fail (null protection = the file is
    // rewritten on a zero-edit save). Raw indices found on the pristine text
    // are translated into the output through `offset`; matching walks left
    // to right with a forward-only cursor, so every later match lies beyond
    // every splice already applied.
    const pristine = serialized.split("\n");
    const sig = analyzeLines(pristine, profile);
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
            //
            // A SUPPRESSION (empty savedSpanLines) must match BOTH anchors: a
            // rewrite's insNorms carry the construct's own identity, so one
            // anchor is corroboration — but a suppression's insNorms are just
            // the synthetic lines (a bare close fence), which any legitimate
            // twin can equal. Deleting a wrong match is corruption, so when
            // either neighbor changed the suppression stands down and the
            // synthetic lines are written — canonical form wins on touched
            // constructs. This NARROWS the twin hazard rather than removing
            // it: a twin whose entire neighborhood keys equal to the anchors
            // can still be mistaken for the synthetic lines (MAR-174 records
            // the residual — reachable only where the construct is
            // parse-neutral anyway).
            const len = region.insNorms.length;
            const isSuppression = region.savedSpanLines.length === 0;
            let best = -1;
            let bestScore = isSuppression ? 1 : 0;
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
            const blank = eol === "\r\n" ? "\r" : "";
            const insertion = [...region.savedSpanLines];
            if (rawAt > 0 && pristine[rawAt - 1].trim() !== "") insertion.unshift(blank);
            if (rawAt < pristine.length && pristine[rawAt].trim() !== "") insertion.push(blank);
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
 * - Formatting-only differences (lines the profile keys equal) are never
 *   applied.
 * - With `protection` (from `computeRoundTripProtection`), changes the
 *   round trip produces on its own — rewritten or dropped constructs — are
 *   repaired back to their saved bytes before the diff, so they merge as
 *   ordinary unchanged lines.
 *
 * Returns `saved` (same reference) when nothing changed.
 */
export function applyMinimalChanges(
    saved: string,
    serialized: string,
    profile: FormatProfile,
    protection?: RoundTripProtection | null,
): string {
    // Give the serializer's output the document's endings BEFORE anything else,
    // so repair splices saved bytes among lines that already agree with them.
    const eol = dominantEol(saved);
    const matched = matchEol(serialized, eol);
    const effective = protection ? repairSerialized(matched, protection, profile, eol) : matched;
    const { edits, savedLines, serialLines } = computeEditScript(saved, effective, profile);

    // NOTE: there is deliberately no "every edit is a keep, so return `saved`"
    // fast path here. An all-keeps script does not mean nothing changed — it
    // means nothing changed AMONG THE SIGNIFICANT LINES, and the blank runs
    // between them are exactly where this format's block structure lives. A
    // pure paragraph split (`alpha\nbeta` → `alpha\n\nbeta`) and its mirror, a
    // pure join, change no significant line at all, so such a fast path
    // discarded both edits silently — the user saw two paragraphs, saved, and
    // reopened one (MAR-290). The rebuild below is the only code that consults
    // the profile's blank-run structure predicates, and it must be reached.
    //
    // No bytes are at risk in the ordinary case: for an all-keeps script the
    // rebuild emits each saved significant line with the saved blank run before
    // it and the saved remainder after, which reconstructs `saved` byte for
    // byte, and the identity return at the end hands back the same reference so
    // callers still see "nothing changed". The ONLY way its output can differ
    // is a `gapBefore` substitution, and that fires only where a structure
    // predicate says the blank run is block structure rather than spacing
    // style. (Asserted across the whole suite while developing MAR-290: no
    // all-keeps rebuild ever differed from `saved` without one firing.) What it
    // does cost is the rebuild itself — one O(lines) pass that the fast path
    // used to skip on a save that changed nothing. It is off the keystroke path
    // (see webview/editor.ts) and small beside the serialization and LCS that
    // precede it on the same save.
    //
    // Which makes corpus invariant A — a zero-edit save is byte-identical — a
    // soundness test for those predicates, where before it was blind to them: a
    // predicate that misjudges a construct now rewrites the file on a save that
    // changed nothing, and can also cost the file its round-trip protection
    // outright, since `computeRoundTripProtection` keeps a protection only if
    // replaying it reproduces the baseline exactly. That cascade is how a `$$`
    // misjudgement surfaced as `$$x$$` → `$x$` in `math-variants.md`. All of
    // that is the point, not a hazard: the same lie already corrupted every
    // save that touched anything ELSE in the document, and the fast path only
    // hid it from the one case a test looks at.

    // What this file's own untouched lines say about how it spells what the
    // serializer renders canonically — the evidence an inserted line is written
    // from (see `mergeFacts` / `reconcileInsertion`). Distilled once per merge,
    // and only for a profile that can actually use it.
    const mergeFacts =
        profile.reconcileInsertion &&
        profile.mergeFacts &&
        edits.some((e) => e.op === "ins")
            ? profile.mergeFacts(pairKeptLines(edits, savedLines.length - 1))
            : null;

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

    // Where the saved file's UNTERMINATED final segment landed in `out`, if it
    // was emitted at all (it is blank, and so never a significant line, in the
    // usual case of a file that ends with a newline). If the merge goes on to
    // emit anything after it, the join gives it an LF it never had — so it is
    // patched up with the document's ending once the output is complete.
    const lastSavedIdx = savedLines.length - 1;
    let unterminatedAt = -1;

    // Both gap slices only ever span blank lines: significant lines are
    // consumed strictly in order on each side, so the region between two
    // consecutively consumed ones contains no significant line.
    const savedGap = (to: number) => savedLines.slice(prevSavedIdx + 1, to);
    const serialGap = (to: number) => serialLines.slice(prevSerialIdx + 1, to);

    let prevLineText: string | null = null; // last significant line emitted
    const hasBlank = (lines: string[]): boolean => lines.some((l) => l.trim() === "");

    // The blank-line run to emit before the next significant line. Normally the
    // saved file's spacing wins on unedited lines (`dirty` false) and the
    // serializer's on edited ones — with two profile-driven exceptions where a
    // blank run is block STRUCTURE rather than style:
    // - `blankSplitsBlock`: a saved blank between two lines the serializer now
    //   emits contiguously was a block separator the edit dissolved (e.g. a
    //   block moving between quote blocks merges them); keeping it would
    //   reopen the merged block split in two. Defer to the serializer's
    //   spacing in that case only — a genuinely separate block keeps its blank
    //   because the serializer emits one too, so this never churns real
    //   separators.
    // - `glueChangesConstruct` (the dual rule): the serializer SEPARATES the
    //   next line with a blank the saved bytes don't have, and gluing would
    //   change the next line's construct — the serializer's separating spacing
    //   is structure, not style, so it wins. A genuinely glued saved construct
    //   keeps its bytes because the serializer re-emits it glued too, so this
    //   never churns.
    const gapBefore = (savedTo: number, serialTo: number, nextText: string): string[] => {
        if (dirty) {
            return serialGap(serialTo);
        }
        const saved = savedGap(savedTo);
        if (
            prevLineText !== null &&
            hasBlank(saved) &&
            profile.blankSplitsBlock(stripEol(prevLineText), stripEol(nextText))
        ) {
            const serial = serialGap(serialTo);
            if (!hasBlank(serial)) {
                return serial;
            }
        }
        if (
            prevLineText !== null &&
            !hasBlank(saved) &&
            profile.glueChangesConstruct(stripEol(prevLineText), stripEol(nextText))
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
            if (edit.saved.lineIdx === lastSavedIdx) unterminatedAt = out.length - 1;
            prevSavedIdx = edit.saved.lineIdx;
            prevSerialIdx = edit.serial.lineIdx;
            prevLineText = edit.saved.text;
            dirty = false;
            e++;
        } else if (edit.op === "del" && next?.op === "ins") {
            // del immediately followed by ins = an in-place replacement: the
            // line changed but its surroundings did not, so the saved spacing
            // around it is kept (modulo the block-split guard in gapBefore).
            // The profile gets the last word on the BYTES too — it may carry
            // source-only facts the serializer canonicalized away.
            const text = reconcileLine(
                profile,
                edit.saved.text,
                next.serial.text,
                edit.saved.lineIdx !== lastSavedIdx,
                protection?.baselineFacts ?? null,
            );
            // Everything downstream must see the line actually written, not
            // the raw serializer line: gapBefore's structure predicates reason
            // about the emitted neighbours, so feeding them a line that was
            // never written would decide the blank run on fiction.
            out.push(...gapBefore(edit.saved.lineIdx, next.serial.lineIdx, text));
            out.push(text);
            if (edit.saved.lineIdx === lastSavedIdx) unterminatedAt = out.length - 1;
            prevSavedIdx = edit.saved.lineIdx;
            prevSerialIdx = next.serial.lineIdx;
            prevLineText = text;
            dirty = false;
            e += 2;
        } else if (edit.op === "del") {
            dirty = true;
            e++;
        } else {
            // Pure insertions: they have no position in the saved file, so
            // their spacing (before and after) can only come from the
            // serializer. Their BYTES get the profile's last word — inserted
            // lines land among saved ones, and a convention the serializer
            // canonicalized can carry meaning there (see `reconcileInsertion`).
            //
            // The whole consecutive run goes to the profile at once, because
            // it is one block of content and its interior indentation is
            // relative. Blank lines between them are not part of the run: they
            // are insignificant to the diff and are emitted from the
            // serializer's gaps, exactly as before.
            const runStart = e;
            while (e < edits.length && edits[e].op === "ins") e++;
            const run = edits
                .slice(runStart, e)
                .map((ins) => (ins as Extract<Edit, { op: "ins" }>).serial);
            const texts = reconcileInsertedRun(
                profile,
                run,
                serialLines.length - 1,
                prevLineText === null ? null : stripEol(prevLineText),
                mergeFacts,
                protection?.baselineFacts ?? null,
            );
            for (let r = 0; r < run.length; r++) {
                // As in the replacement branch, everything downstream must see
                // the line actually written, not the raw serializer line.
                out.push(...serialGap(run[r].lineIdx));
                out.push(texts[r]);
                prevSerialIdx = run[r].lineIdx;
                prevLineText = texts[r];
            }
            dirty = true;
        }
    }

    // Trailing region after the last significant line (blank lines and the
    // final newline — or its absence).
    out.push(...(dirty ? serialLines.slice(prevSerialIdx + 1) : savedLines.slice(prevSavedIdx + 1)));

    // The saved final segment has stopped being final (content was appended
    // after it), so it now needs the terminator it never carried.
    if (
        unterminatedAt !== -1 &&
        unterminatedAt < out.length - 1 &&
        eol === "\r\n" &&
        !out[unterminatedAt].endsWith("\r")
    ) {
        out[unterminatedAt] += "\r";
    }

    const result = out.join("\n");
    return result === saved ? saved : result;
}
