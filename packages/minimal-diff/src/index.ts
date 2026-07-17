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
     * blanks never participate in the diff.
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
    const keys = profile.keyLines(lines);
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
    const { edits, savedLines } = computeEditScript(saved, baselineSerialized, profile);
    if (!edits.some((e) => e.op !== "keep")) return null;

    // Self-check: protection must reproduce the saved bytes exactly when the
    // serializer output is the baseline itself. The per-construct split
    // pairs del/ins adjacency groups positionally, which can mis-pair exotic
    // runs (e.g. a dropped construct sharing a run with a construct whose
    // canonical form has a different line count) — repairing with wrong
    // bytes is worse than canonicalization, so fall back to the fused
    // region. Suppression regions get the same discipline: if including them
    // fails the self-check, retry without them (never worse than the
    // pre-suppression engine), and if nothing can reproduce the baseline,
    // ship no protection at all.
    for (const suppressInsertions of [true, false]) {
        for (const allowSplit of [true, false]) {
            const regions = buildProtectedRegions(edits, savedLines, allowSplit, suppressInsertions);
            if (regions.length === 0) continue;
            const protection = { regions };
            if (applyMinimalChanges(saved, baselineSerialized, profile, protection) === saved) {
                return protection;
            }
        }
    }
    return null;
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
function repairSerialized(
    serialized: string,
    protection: RoundTripProtection,
    profile: FormatProfile,
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
    const effective = protection ? repairSerialized(serialized, protection, profile) : serialized;
    const { edits, savedLines, serialLines } = computeEditScript(saved, effective, profile);

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
            profile.blankSplitsBlock(prevLineText, nextText)
        ) {
            const serial = serialGap(serialTo);
            if (!hasBlank(serial)) {
                return serial;
            }
        }
        if (
            prevLineText !== null &&
            !hasBlank(saved) &&
            profile.glueChangesConstruct(prevLineText, nextText)
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
            // around it is kept (modulo the block-split guard in gapBefore).
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
