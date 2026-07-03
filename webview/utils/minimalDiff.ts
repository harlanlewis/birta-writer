/**
 * Minimal-diff merge between the last saved Markdown text and a fresh full
 * serialization of the editor document.
 *
 * remark-stringify re-serializes the entire document on every edit, which
 * would silently reformat regions the user never touched (table column
 * padding, separator dash widths, blank-line style, ...). Instead of writing
 * the serializer output verbatim, we LCS-diff its significant (non-blank)
 * lines against the saved file and apply only the real content changes.
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

// ─── Minimal-diff merge ─────────────────────────────────────────────────────

interface SigLine {
    text: string;
    lineIdx: number;
}

type Edit =
    | { op: "keep"; saved: SigLine; serial: SigLine }
    | { op: "del"; saved: SigLine }
    | { op: "ins"; serial: SigLine };

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
 *
 * Returns `saved` (same reference) when nothing changed.
 */
export function applyMinimalChanges(saved: string, serialized: string): string {
    const savedLines = saved.split("\n");
    const serialLines = serialized.split("\n");

    const sigLines = (lines: string[]): SigLine[] =>
        lines.reduce<SigLine[]>((acc, line, i) => {
            if (line.trim() !== "") acc.push({ text: line, lineIdx: i });
            return acc;
        }, []);

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

    // Backtrack into an edit script over significant lines
    const edits: Edit[] = [];
    {
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
    }

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
