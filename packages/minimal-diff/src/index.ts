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
     * whole-line to SUB-LINE granularity. A `keep` writes the saved bytes;
     * without this hook a replacement writes the serializer's line wholesale,
     * so every formatting-only part of an edited line (its outline indent unit,
     * a table cell the user never touched) is canonicalized as collateral
     * damage while its untouched neighbours keep theirs — leaving two
     * conventions mixed inside one construct (MAR-213 / MAR-214).
     *
     * `facts` is whatever `baselineFacts` distilled for this file, or null when
     * no protection was computed. A profile MUST treat it as untrusted (it
     * round-trips through the caller's cache) and MUST behave correctly without
     * it.
     *
     * `keys` carries both lines' comparison keys, exactly as `keyLines` produced
     * them in full document context — the same fact `reconcileInsertion` already
     * receives per line, and for the same reason: a profile cannot classify a
     * line from its bytes in isolation. A line reading `- item` is an outline
     * bullet in prose and verbatim content inside a fence, and only the key can
     * tell them apart. Passing it is what lets a profile refuse to reason about
     * structure on a line that has none (MAR-299).
     */
    reconcileReplacement(
        saved: string,
        serial: string,
        facts: unknown,
        keys: ReplacementKeys,
    ): string;
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
     *
     * Return `undefined` to mean "nothing to teach". The distinction matters
     * for a file whose round trip is CLEAN: it needs no repair regions, but its
     * keeps are still evidence, so `computeRoundTripProtection` returns a
     * zero-region protection carrying whatever this hook distilled — and stays
     * null only when this hook is absent or returns `undefined` (MAR-322).
     */
    baselineFacts?(pairs: readonly BaselineLinePair[]): unknown;
    /**
     * Which lines' LEADING WHITESPACE is literal user content rather than
     * document structure — the one question the facts hooks above cannot ask,
     * because they receive pairs and the answer needs the whole document.
     *
     * A verbatim span reproduces its own bytes by construction, so both sides
     * of its pair carry identical leading whitespace and the pair "agrees"
     * about an indent that means nothing structural. Fed to a learner that is
     * distilling how the file spells its indentation, that agreement is not
     * weak evidence, it is a CONFLICTING witness: a fenced diagram indented
     * four spaces reports `"    " → "    "` beside an outline's genuine
     * `"    " → "  "`, and a learner that drops what it sees two ways then
     * drops a fact the file really has (MAR-325 — five nesting levels flatten
     * on the next save that carries an edit).
     *
     * Distinguishing the two is exactly what a whole-document classification
     * already does, and no rule reading a line in isolation can: four leading
     * spaces are one outline level, an indented code block, and a diagram's own
     * layout, and one file holds all three.
     *
     * Optional — a profile that does not answer leaves every pair marked
     * structural, which is the pre-MAR-325 behaviour. Called at most once per
     * document, and only when a facts hook is actually going to consume the
     * result.
     */
    indentIsContent?(lines: readonly string[]): readonly boolean[];
    /**
     * Does rewriting `before` as `after` DEMOTE a construct whose contents are
     * opaque — code that stops being code?
     *
     * Asked of the round-trip repair, not of the merge. The output self-check
     * below compares the merged text against `effective` (the serializer's text
     * with each protected region's saved bytes spliced back in), which catches
     * anything the MERGE broke. It cannot catch anything `effective` itself got
     * wrong, because both sides of that comparison then carry the identical
     * defect — and the repair can get it wrong, because splicing saved bytes
     * beside a NEW neighbour changes what those bytes mean. A fenced block the
     * serializer emitted correctly was replaced by the saved indented-code
     * bytes, which had just acquired a list item above them, so four spaces
     * stopped being a code block and became a list-item continuation: the code
     * was silently demoted to prose on disk (MAR-326).
     *
     * Deliberately NOT "did the repair change any line's role". That was
     * measured over 285 corpus merges and would stand down on 34 of them — one
     * in eight — discarding the protection repairs on all of them. Repairs
     * change roles for a living; that is what they are for. Only a repair that
     * demotes CODE is asking to be overruled, because no repair's purpose is to
     * stop code being code, and the same measurement puts that at zero
     * occurrences outside the defect itself.
     *
     * Optional. Line counts may differ — `after` can hold constructs the
     * serializer dropped entirely, which is the ordinary reason a region is
     * protected at all — so an implementation must not compare positionally.
     */
    losesOpaqueContent?(before: readonly string[], after: readonly string[]): boolean;
    /**
     * Classify each line's structural role for the merge's OUTPUT SELF-CHECK.
     * Opaque strings — the engine only compares them for equality — but
     * markdown's profile reports "verbatim" for a line whose bytes are an
     * opaque enclosed span (fenced code interior) and otherwise
     * `content:<depth>` or `content:<depth>:<adjacency>` (see its own doc).
     *
     * WHY the check exists: the diff keys equivalent spellings of a construct
     * equal so both spellings can survive as keeps — markdown keys a fence
     * marker line by its info string alone, so a saved `~~~` stays beside a
     * serializer ```` ``` ````. Safe when the document's order is unchanged;
     * under a block MOVE the LCS may pair one marker line of a fence with a
     * DIFFERENT fence's marker, keeping one end's saved spelling while the
     * other end takes the serializer's — and a ``` run cannot close a `~~~`
     * fence, so the mismatched pair swallows everything to the next matching
     * run on reopen. The raw serialization is clean, so no pre-merge refusal
     * can see it; only the merged bytes are wrong. (MAR-323 added a second,
     * unrelated hazard the same mechanism catches: a `keep` line's saved
     * bytes landing at a real column — tab stop 4 — that collides with a
     * container the file's own canonical-depth approximation never priced
     * in, once a move relocates it beside new neighbours.)
     *
     * The check: after the rebuild, the merged text's significant lines must
     * carry the same role sequence as the text the diff ran on. A mismatched
     * fence pair flips later lines between "verbatim" and "content"; a
     * collided real column flips a depth number; either is exactly the kind
     * of divergence this detects. On mismatch the merge DEGRADES to the raw
     * serializer output (EOL-matched): canonicalization churn, never
     * corruption — the trade this engine prefers everywhere.
     *
     * Keep the roles COARSE and, beyond the one profile-chosen exception,
     * blank-insensitive. A finer classification (indented code, setext)
     * reads meaning out of blank runs, and the merge legitimately emits
     * saved blank spacing beside serializer lines, so a role that depends on
     * a blank fires on merges that are fine wherever it is not scoped to a
     * construct whose MEANING actually turns on that adjacency.
     *
     * `hadRelocatedContent` reports whether this merge deleted a line at one
     * position and inserted an otherwise-identical line (same normalized
     * key) at another — the engine's own signal that a block MOVE happened,
     * computed once and handed to both calls (see `rolesDiverge`). A
     * profile whose role can only diverge on genuinely relocated content
     * (MAR-323's depth) should gate on it: an ordinary in-place edit can
     * leave two indent conventions sitting beside each other for reasons
     * this check has no business re-litigating (MAR-222's "ambiguous, drop
     * rather than guess" is exactly such a case — no move, both spellings
     * legitimately unresolved), and firing there would degrade a save that
     * is fine by this profile's OWN other rules.
     */
    lineRoles?(lines: readonly string[], hadRelocatedContent: boolean): readonly string[];
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
     * protection.
     *
     * WHY the fact is needed: `preceding`, and the run's own lines, can arrive
     * wearing bytes the SERIALIZER never wrote. `repairSerialized` runs before
     * the diff, so a protected construct reaches this hook spelled the way the
     * saved file spells it, inside a stream that is otherwise canonical. A
     * profile reasoning about which convention a neighbouring line is in cannot
     * answer that from this merge's keeps alone — the baseline round trip is the
     * only record of what the file's own spellings are (MAR-297).
     *
     * WHY it is a PARAMETER rather than something the profile closes over: only
     * for symmetry with `reconcileReplacement`, which already receives it this
     * way. Passing it here is NOT forced — a profile-bound wrapper closing over
     * `protection.baselineFacts` was built and measured byte-identical on every
     * probe, since that field is already public and already threaded to the
     * wrapper. MAR-297's commit message claims the widening was forced; that is
     * wrong, and the honest reason is that one fact reaching two sibling hooks
     * by two different mechanisms is worse than one extra argument. If these
     * hooks are ever reworked, this is a free choice, not a constraint.
     *
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

/** The comparison keys of the two lines in an in-place replacement — see
 *  `reconcileReplacement`. They always differ: a pair that keyed equal would
 *  have merged as a `keep` and never reached the hook. */
export interface ReplacementKeys {
    saved: string;
    serial: string;
}

/** One saved line beside its zero-edit serialization — see `baselineFacts`. */
export interface BaselineLinePair {
    saved: string;
    serial: string;
    /** Whether each side's LEADING WHITESPACE is literal user content rather
     *  than document structure — `indentIsContent`'s verdict for that line, or
     *  false when the profile does not answer the question. Carried on the pair
     *  because the hooks receive pairs, not documents, and the question is
     *  contextual: no rule reading one line in isolation can answer it. */
    savedIndentIsContent: boolean;
    serialIndentIsContent: boolean;
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
    keys: ReplacementKeys,
    /** This line is the file's own bytes, restored by `repairSerialized`, not
     *  the serializer's — so the profile has already had its say. See
     *  `RepairedSerialization.restored`. */
    restored = false,
): string {
    const eol = savedTerminated ? eolOf(saved) : "";
    const savedContent = savedTerminated ? stripEol(saved) : saved;
    const fallback = stripEol(serial) + eol;
    if (restored) return fallback;
    let out: string;
    try {
        out = profile.reconcileReplacement(savedContent, stripEol(serial), facts, keys);
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
    /** Output line indices `repairSerialized` wrote from the file's own bytes
     *  (`RepairedSerialization.restored`). */
    restored: ReadonlySet<number> = EMPTY_RESTORED,
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
    // A restored line keeps the bytes the repair gave it. Those bytes are the
    // file's own, so the file's conventions are already on them and re-basing
    // them writes the same convention a second time (MAR-328). This is a
    // per-line exemption rather than a run-level refusal because "these bytes
    // came from the file" is a per-line fact, and it does not reopen the
    // all-or-nothing rule above: that one keeps a rejected answer from mixing
    // the profile's spelling with the SERIALIZER's, while both sides here are
    // the file's.
    return out.map((line, i) =>
        restored.has(run[i].lineIdx) ? raw[i] : line + eols[i],
    );
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
    const { edits, savedLines, serialLines } = computeEditScript(saved, baselineSerialized, profile);

    const baselineFacts = profile.baselineFacts?.(
        pairBaselineLines(edits, savedLines.length - 1, indentRoles(profile, savedLines, serialLines)),
    );
    if (!edits.some((e) => e.op !== "keep")) {
        // A clean round trip needs no repair regions — but its keeps are the
        // richest baseline evidence a file ever offers, since EVERY line is a
        // witnessed (saved, rendered) pair. Returning null here discarded them,
        // which left exactly the files most exposed to indent re-spelling with
        // nothing to consult: a plain tab outline keys equal to the spaces it
        // renders as, so it is always clean, and a block moved within one then
        // shipped the serializer's spaces beside kept tabs whenever the only
        // line witnessing the landing depth was inside the moved region itself
        // (MAR-322). A zero-region protection performs no repairs — it exists
        // purely to carry the facts to the merge hooks, whose own gates govern
        // every use. `undefined` from the profile still means "nothing to
        // teach", and a profile without the hook keeps the old null. The
        // replay self-check below is deliberately skipped: it verifies that
        // REGIONS reproduce the baseline, and there are none.
        return baselineFacts === undefined ? null : { regions: [], baselineFacts };
    }

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
function pairBaselineLines(
    edits: Edit[],
    lastSavedIdx: number,
    indent: IndentRoles,
): BaselineLinePair[] {
    const pairs: BaselineLinePair[] = [];
    const savedContent = (line: SigLine): string =>
        line.lineIdx === lastSavedIdx ? line.text : stripEol(line.text);
    const pairOf = (saved: SigLine, serial: SigLine): BaselineLinePair => ({
        saved: savedContent(saved),
        serial: stripEol(serial.text),
        savedIndentIsContent: indent.saved(saved.lineIdx),
        serialIndentIsContent: indent.serial(serial.lineIdx),
    });
    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        if (edit.op === "keep") {
            pairs.push(pairOf(edit.saved, edit.serial));
            continue;
        }
        // Walk the whole non-keep run, then take it only if it is a lone
        // del/ins couple or corresponds line by line.
        const start = i;
        while (i < edits.length && edits[i].op !== "keep") i++;
        const run = edits.slice(start, i);
        i--; // the outer loop's own increment steps past the run's last edit
        if (run.length === 2 && run[0].op === "del" && run[1].op === "ins") {
            pairs.push(
                pairOf(
                    (run[0] as Extract<Edit, { op: "del" }>).saved,
                    (run[1] as Extract<Edit, { op: "ins" }>).serial,
                ),
            );
            continue;
        }
        for (const pair of positionalRunPairs(run, lastSavedIdx) ?? []) {
            pairs.push(pairOf(pair.saved, pair.serial));
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
function pairKeptLines(
    edits: Edit[],
    lastSavedIdx: number,
    indent: IndentRoles,
): BaselineLinePair[] {
    const pairs: BaselineLinePair[] = [];
    for (const edit of edits) {
        if (edit.op !== "keep") continue;
        pairs.push({
            saved: edit.saved.lineIdx === lastSavedIdx
                ? edit.saved.text
                : stripEol(edit.saved.text),
            serial: stripEol(edit.serial.text),
            savedIndentIsContent: indent.saved(edit.saved.lineIdx),
            serialIndentIsContent: indent.serial(edit.serial.lineIdx),
        });
    }
    return pairs;
}

/** Per-line `indentIsContent` lookups for the two documents of one merge. */
interface IndentRoles {
    saved(lineIdx: number): boolean;
    serial(lineIdx: number): boolean;
}

/**
 * Ask the profile which lines' leading whitespace is content, once per
 * document, lazily — a caller builds this only when it is about to distill
 * facts, so a merge that learns nothing never pays for the classification and
 * a profile without the hook never allocates.
 */
function indentRoles(
    profile: FormatProfile,
    savedLines: readonly string[],
    serialLines: readonly string[],
): IndentRoles {
    if (!profile.indentIsContent) return { saved: () => false, serial: () => false };
    const saved = profile.indentIsContent(savedLines);
    const serial = profile.indentIsContent(serialLines);
    return { saved: (i) => saved[i] === true, serial: (i) => serial[i] === true };
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

const EMPTY_RESTORED: ReadonlySet<number> = new Set<number>();

/** `repairSerialized`'s output: the repaired text, and which of its lines came
 *  from the file rather than from the serializer. */
interface RepairedSerialization {
    text: string;
    /**
     * Line indices of `text` written from a region's `savedSpanLines`.
     *
     * These lines are the file's own bytes, so every convention the file spells
     * is already on them and the merge's indent reconcilers must not spell it
     * again. A region matches on `norm`, which carries indentation, so a
     * construct whose canonical depth changed does not match its own region at
     * all — repair fires only where the depth held, which is exactly where the
     * saved bytes are still the right answer. Letting the reconcilers re-base
     * them anyway is MAR-328: a moved sublist came back spelled to depths the
     * document has no level for, and stopped parsing as a list.
     */
    restored: ReadonlySet<number>;
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
): RepairedSerialization {
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
    // Which of `lines` came from the file rather than the serializer, spliced
    // in lockstep with `lines` so the two can never disagree about an index.
    // Deliberately not arithmetic over `offset`: that would be a second, silent
    // account of where every splice landed, and the branch below re-inserts a
    // dropped construct WITHOUT advancing the cursor past it, so the splices
    // are not strictly forward-ordered and such an account can drift.
    let flags: boolean[] = pristine.map(() => false);
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
            flags = [
                ...flags.slice(0, firstRaw + offset),
                ...region.savedSpanLines.map(() => true),
                ...flags.slice(lastRaw + 1 + offset),
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
            flags = [
                ...flags.slice(0, rawAt + offset),
                ...insertion.map((line) => line.trim() !== ""),
                ...flags.slice(rawAt + offset),
            ];
            offset += insertion.length;
            cursor = rawAt;
        }
    }
    const restored = new Set<number>();
    for (let i = 0; i < flags.length; i++) if (flags[i]) restored.add(i);
    return { text: lines.join("\n"), restored };
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
 * The contiguous non-keep run starting at `from` — its two sides collected
 * SEPARATELY, each in document order, plus the index just past it. Collecting
 * rather than walking is what lets the merge pair the sides positionally
 * without depending on the order the LCS backtrack happens to emit them in.
 */
function runAt(
    edits: Edit[],
    from: number,
): { dels: SigLine[]; inses: SigLine[]; end: number } {
    const dels: SigLine[] = [];
    const inses: SigLine[] = [];
    let end = from;
    while (end < edits.length && edits[end].op !== "keep") {
        const edit = edits[end];
        if (edit.op === "del") dels.push(edit.saved);
        else if (edit.op === "ins") inses.push(edit.serial);
        end++;
    }
    return { dels, inses, end };
}

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
    // A zero-region protection carries facts only (a clean file's witnessed
    // spellings — see `baselineFacts`), and `repairSerialized` with no regions
    // is a string identity. Skipping it matters because it is not a cheap
    // identity: it re-analyzes and re-keys the whole document, on every sync of
    // every clean file, to return what it was given.
    const repaired =
        protection && protection.regions.length > 0
            ? repairSerialized(matched, protection, profile, eol)
            : null;
    const effective = repaired ? repaired.text : matched;
    const restored = repaired ? repaired.restored : EMPTY_RESTORED;
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
    // does cost is the rebuild itself — one O(lines) pass, paid even on a save
    // that changed nothing. It is off the keystroke path (see
    // webview/editor.ts) and small beside the serialization and LCS that
    // precede it on the same save.
    //
    // Which makes corpus invariant A — a zero-edit save is byte-identical — a
    // soundness test for those predicates: a predicate that misjudges a
    // construct rewrites the file on a save that changed nothing, and can also
    // cost the file its round-trip protection outright, since
    // `computeRoundTripProtection` keeps a protection only if replaying it
    // reproduces the baseline exactly — the cascade that turns a `$$`
    // misjudgement into `$$x$$` → `$x$` in `math-variants.md`. That is the
    // point, not a hazard: the same misjudgement corrupts every save that
    // touches anything ELSE in the document, and a fast path here would only
    // hide it from the one case a test looks at.

    // What this file's own untouched lines say about how it spells what the
    // serializer renders canonically — the evidence an inserted line is written
    // from (see `mergeFacts` / `reconcileInsertion`). Distilled once per merge,
    // and only for a profile that can actually use it.
    const mergeFacts =
        profile.reconcileInsertion &&
        profile.mergeFacts &&
        edits.some((e) => e.op === "ins")
            ? profile.mergeFacts(
                  pairKeptLines(
                      edits,
                      savedLines.length - 1,
                      indentRoles(profile, savedLines, serialLines),
                  ),
              )
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
    // Did this merge relocate content beside new neighbours — the one
    // shape `profile.lineRoles`' depth-sensitive role (MAR-323) is meant to
    // police? An ordinary in-place edit never sets this, which is what
    // keeps that role from firing on documents no move ever touched (see
    // the role's own doc for why that distinction matters).
    //
    // The tell: a deletion and an insertion, anywhere in this edit script —
    // paired or not — whose CORE content (`coreOf`) matches. A genuine
    // block move is exactly this: content that existed at one position and
    // now exists, essentially unchanged, at another. Two things make this
    // the right level rather than the position level or the exact-bytes
    // level:
    //
    //   - `positionalRunPairs`'s reasoning ("a serializer re-emits a span
    //     rather than reordering it") is exactly backwards for a genuine
    //     reorder, so the LCS/run-pairing above can route a relocated span
    //     through as a PURE deletion at its old position and a PURE
    //     insertion at its new one, with no keep or replacement pair ever
    //     connecting them (found reproducing MAR-323's outline-tables case:
    //     a moved table's header/marker line was a leftover del and a
    //     leftover ins in the SAME walk, both singletons, with every
    //     neighbouring keep perfectly contiguous on the saved side — a
    //     position-based check never sees it).
    //   - The moved span's OWN bytes do not have to survive verbatim for
    //     this to be a move: MAR-323's logseq case dissolves a blockquote
    //     in transit (the saved line carries a `> ` the new position never
    //     had), so an exact-key match misses it too. `coreOf` strips the
    //     wrapper syntax — a run of leading non-alphanumeric characters,
    //     covering list markers, quote arrows, and their combinations —
    //     without needing to know what construct it belongs to, so the
    //     comparison survives exactly this kind of in-transit reshaping.
    //
    // A leftover (unpaired) del/ins always feeds the sets below; a PAIRED
    // one only when its own two sides' cores differ from EACH OTHER (see
    // the pairing loop) — an ordinary re-indent is a paired del/ins whose
    // core is trivially identical on both sides, and counting that as
    // relocation evidence would fire the depth role on every reindent,
    // including the ones MAR-299's baseline-spelling rule already handles
    // correctly on its own.
    function coreOf(text: string): string {
        return text.replace(/^[^\p{L}\p{N}]+/u, "");
    }
    const delCoreKeys = new Set<string>();
    const insCoreKeys = new Set<string>();
    let hadRelocatedContent = false;

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
        if (edit.op === "keep") {
            out.push(...gapBefore(edit.saved.lineIdx, edit.serial.lineIdx, edit.saved.text));
            out.push(edit.saved.text);
            if (edit.saved.lineIdx === lastSavedIdx) unterminatedAt = out.length - 1;
            prevSavedIdx = edit.saved.lineIdx;
            prevSerialIdx = edit.serial.lineIdx;
            prevLineText = edit.saved.text;
            dirty = false;
            e++;
        } else {
            // A contiguous run of dels and inses: the same span of the
            // document before and after the edit. Its two sides are paired
            // POSITIONALLY — i-th saved line beside i-th serialized one — and
            // each pair is an in-place replacement, offered to the profile,
            // which may carry source-only facts the serializer canonicalized
            // away. Whatever is left over on the longer side is a plain
            // deletion (no serialized counterpart) or a plain insertion (no
            // saved one).
            //
            // Position is the correspondence, for `positionalRunPairs`'
            // reason: a serializer re-emits a span rather than reordering it.
            // Unlike that function this does not demand the bytes exhibit the
            // correspondence first, because the stakes are opposite. There a
            // mispaired guess becomes a file-wide fact that outlives the merge
            // and is consulted for lines it never saw, so an absent pair is
            // cheap and a wrong one is a lie. Here the pairing is per line and
            // per merge, the profile re-checks every carry against the two
            // lines in front of it, and declining to pair is not a neutral "no
            // answer" — it routes the line to the insertion path, which is an
            // answer of its own, and usually the wrong one.
            //
            // Do NOT reduce this to adjacency — `del` immediately followed by
            // `ins` — as the test for a replacement (MAR-303). The LCS
            // backtrack emits a run's dels and THEN its inses (the fact
            // `pairBaselineLines` states about itself), so on any run longer
            // than one couple that test pairs the LAST saved line with the
            // FIRST serialized one — two lines with nothing to do with each
            // other — and every other serialized line in the run falls through
            // to the insertion path, which has no saved counterpart to consult
            // at all. Editing two adjacent table rows in ONE save is enough to
            // reach it: the second row loses the cell bytes the serializer
            // cannot reproduce, and the first row is handed the second's.
            //
            // Collecting the two sides separately also makes the walk
            // independent of the order the backtrack emits them in, which is a
            // property of the DP rather than of this engine's contract.
            const { dels, inses, end } = runAt(edits, e);
            e = end;

            // SPACING is decided by two rules, independently of the pairing
            // above:
            //   • a saved line with no serialized counterpart takes the blank
            //     run around it away, so a run with more than one del — or
            //     with none at all to pair against — is `dirty` from the
            //     start and every line it emits is spaced by the serializer;
            //   • after the run, `dirty` is false only for the isolated
            //     couple whose surroundings demonstrably did not move.
            // (The second rule is stated in terms of the SERIALIZED side. That
            // is probably an accident of an earlier branch order rather than a
            // reasoned rule, and worth its own look — but change it on its own,
            // never alongside a pairing change, or neither is measurable.)
            if (dels.length > 1 || inses.length === 0) dirty = true;

            const paired = Math.min(dels.length, inses.length);
            // Leftover (unpaired) dels/inses always feed the relocation
            // check (see `coreOf`'s doc) — they have no partner in this run
            // at all, so a match elsewhere in the document is real evidence.
            for (let k = paired; k < dels.length; k++) {
                const core = coreOf(dels[k].text);
                if (core !== "") delCoreKeys.add(core);
            }
            for (let k = paired; k < inses.length; k++) {
                const core = coreOf(inses[k].text);
                if (core !== "") insCoreKeys.add(core);
            }
            for (let k = 0; k < paired; k++) {
                const savedLine = dels[k];
                const serialLine = inses[k];
                // A PAIRED del/ins feeds the relocation check too, but only
                // when the two sides' OWN cores differ — MAR-323's logseq
                // case is exactly this: a del paired with an unrelated
                // bare-marker insertion (the blockquote dissolving in
                // place), whose cores ("A blockquote…" vs "") disagree, so
                // both sides go in and the del's core later matches a
                // SEPARATE pure insertion elsewhere in the script. Skipping
                // an EQUAL pair matters: an ordinary re-indent — MAR-299's
                // "file whose indent unit is wider than the serializer's"
                // — is ALSO a paired del/ins whose only difference is the
                // marker, so its two cores are trivially identical, and
                // adding both would report every reindent as a relocation.
                const delCore = coreOf(savedLine.text);
                const insCore = coreOf(serialLine.text);
                if (delCore !== insCore) {
                    if (delCore !== "") delCoreKeys.add(delCore);
                    if (insCore !== "") insCoreKeys.add(insCore);
                }
                const text = reconcileLine(
                    profile,
                    savedLine.text,
                    serialLine.text,
                    savedLine.lineIdx !== lastSavedIdx,
                    protection?.baselineFacts ?? null,
                    { saved: savedLine.norm, serial: serialLine.norm },
                    restored.has(serialLine.lineIdx),
                );
                // Everything downstream must see the line actually written,
                // not the raw serializer line: gapBefore's structure
                // predicates reason about the emitted neighbours, so feeding
                // them a line that was never written would decide the blank
                // run on fiction.
                out.push(...gapBefore(dels[dels.length - 1].lineIdx, serialLine.lineIdx, text));
                out.push(text);
                if (savedLine.lineIdx === lastSavedIdx) unterminatedAt = out.length - 1;
                prevSerialIdx = serialLine.lineIdx;
                prevLineText = text;
            }
            if (paired > 0) {
                // The saved side is consumed through the run's LAST del, not
                // through the last one this pairing reached: the surplus are
                // DELETIONS, and leaving `prevSavedIdx` short of them would
                // let the next `savedGap` slice their still-significant lines
                // back into the output. (Assigned after the loop, not during:
                // the only reader is `gapBefore`'s saved branch, which a run
                // of more than one del never takes — see the spacing note
                // above.)
                prevSavedIdx = dels[dels.length - 1].lineIdx;
            }

            // Pure insertions: they have no position in the saved file, so
            // their spacing (before and after) can only come from the
            // serializer. Their BYTES get the profile's last word — inserted
            // lines land among saved ones, and a convention the serializer
            // canonicalized can carry meaning there (see `reconcileInsertion`).
            //
            // The whole leftover run goes to the profile at once, because it
            // is one block of content and its interior indentation is
            // relative. Blank lines between them are not part of the run: they
            // are insignificant to the diff and are emitted from the
            // serializer's gaps, exactly as before.
            const inserted = inses.slice(paired);
            if (inserted.length > 0) {
                const texts = reconcileInsertedRun(
                    profile,
                    inserted,
                    serialLines.length - 1,
                    prevLineText === null ? null : stripEol(prevLineText),
                    mergeFacts,
                    protection?.baselineFacts ?? null,
                    restored,
                );
                for (let r = 0; r < inserted.length; r++) {
                    // As in the replacement branch, everything downstream must
                    // see the line actually written, not the raw serializer
                    // line.
                    out.push(...serialGap(inserted[r].lineIdx));
                    out.push(texts[r]);
                    prevSerialIdx = inserted[r].lineIdx;
                    prevLineText = texts[r];
                }
            }

            dirty = dels.length === 0 || inses.length !== 1;
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

    for (const key of delCoreKeys) {
        if (insCoreKeys.has(key)) {
            hadRelocatedContent = true;
            break;
        }
    }

    const result = out.join("\n");
    if (result === saved) return saved;
    // Output self-check (see `lineRoles`): a splice that flips any
    // significant line's role — a mismatched fence pair, or (MAR-323) a
    // `keep` line's saved bytes landing at a real column that changes its
    // list-nesting depth — is corruption the keys cannot prevent, so the
    // merge stands down and the serializer's own text is written instead.
    // Skipped when the result IS the saved bytes: writing them changes
    // nothing, so no new structure can have been introduced.
    if (profile.lineRoles && rolesDiverge(profile, result, effective, hadRelocatedContent)) {
        return matched;
    }
    // The blind spot the check above has by construction (MAR-326): it compares
    // two texts that both descend from `effective`, so a defect `effective`
    // already carries is on both sides and the roles agree. Only the repair can
    // introduce one, and only one KIND of repair damage is worth overruling a
    // repair for — see `losesOpaqueContent`. Deliberately after the role check,
    // and reached only when a repair actually ran: with no regions `effective`
    // IS `matched` and the question is vacuous.
    if (
        effective !== matched &&
        profile.losesOpaqueContent?.(matched.split("\n").map(stripEol), effective.split("\n").map(stripEol))
    ) {
        return matched;
    }
    return result;
}

/** Do `merged` and `effective` disagree on any significant line's role?
 *  Roles are computed over the FULL line arrays (classification is
 *  contextual) and compared only at significant lines, so blank-run
 *  differences — saved spacing beside serializer lines — cannot fire this.
 *  `hadRelocatedContent` is threaded through unchanged to both sides: it is a
 *  property of the merge (did content get deleted at one position and
 *  reinserted, unchanged, at another), not of either individual text, and
 *  markdown's profile uses it to scope its depth-sensitive role to merges a
 *  block move actually touched (see its own doc for why an ordinary
 *  in-place edit must not trip it). */
function rolesDiverge(
    profile: FormatProfile,
    merged: string,
    effective: string,
    hadRelocatedContent: boolean,
): boolean {
    const significantRoles = (text: string): string[] => {
        const lines = text.split("\n").map(stripEol);
        const roles = profile.lineRoles!(lines, hadRelocatedContent);
        const sig: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim() !== "") sig.push(roles[i]);
        }
        return sig;
    };
    const m = significantRoles(merged);
    const e = significantRoles(effective);
    if (m.length !== e.length) return true;
    for (let i = 0; i < m.length; i++) {
        if (m[i] !== e[i]) return true;
    }
    return false;
}
