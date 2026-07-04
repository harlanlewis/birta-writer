/**
 * Pure Markdown heading scanner used by the Go-to-Symbol quick pick.
 *
 * Returns document headings in source order, each with its 1-based line number
 * so callers can map a heading to a `scrollToLine` reveal via the shared
 * lineMap. Both ATX (`## Heading`) and setext (underline `===` / `---`)
 * headings are recognized.
 *
 * Fenced code blocks are skipped whole (reusing the fence-tracking idiom from
 * `shared/lineMap.ts`), so a `# comment` or a fence info line inside ``` / ~~~
 * never registers as a heading. A leading YAML frontmatter block (`---` … `---`)
 * is skipped as well. CRLF line endings are handled.
 */

export interface ScannedHeading {
    /** Heading level, 1–6. */
    level: number;
    /** Heading text with markers and trailing `#` closers stripped. */
    text: string;
    /** 1-based line number of the heading in the source. */
    line: number;
}

/** Matches an opening/closing code fence, capturing the fence run. */
const FENCE_RE = /^(`{3,}|~{3,})/;
/** Matches an ATX heading line, capturing the `#` run and the (optional) text. */
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
/** Matches a setext underline line (`===` for H1, `---` for H2). */
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
/** Matches a trailing ATX closing sequence (` ##` preceded by whitespace). */
const ATX_CLOSER_RE = /[ \t]+#+[ \t]*$/;
/** Matches a YAML frontmatter delimiter line. */
const FRONTMATTER_DELIM_RE = /^(---|\.\.\.)[ \t]*$/;

export function scanHeadings(text: string): ScannedHeading[] {
    // Normalize CRLF/CR: split on \n, then drop a trailing \r per line.
    const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
    const n = lines.length;
    const headings: ScannedHeading[] = [];

    let i = 0;

    // Skip a leading YAML frontmatter block: a `---` fence on line 1, closed by
    // a later `---` or `...`. An unclosed opener is not frontmatter, so we only
    // advance when a closing delimiter is found.
    if (n > 0 && /^---[ \t]*$/.test(lines[0])) {
        let j = 1;
        while (j < n && !FRONTMATTER_DELIM_RE.test(lines[j])) j++;
        if (j < n) i = j + 1;
    }

    for (; i < n; i++) {
        const line = lines[i];

        // Fenced code block: skip to the matching closing fence and continue.
        const fence = line.trimStart().match(FENCE_RE);
        if (fence) {
            const marker = fence[1][0];
            const len = fence[1].length;
            i++;
            while (i < n) {
                const close = lines[i].trimStart().match(FENCE_RE);
                if (close && close[1][0] === marker && close[1].length >= len) break;
                i++;
            }
            // Loop `i++` steps past the closing fence (or off the end).
            continue;
        }

        // ATX heading.
        const atx = line.match(ATX_RE);
        if (atx) {
            const level = atx[1].length;
            const raw = atx[2] ?? "";
            const content = raw.replace(ATX_CLOSER_RE, "").trim();
            headings.push({ level, text: content, line: i + 1 });
            continue;
        }

        // Setext heading: a non-blank text line followed by an underline. The
        // text line must not be an indented code block (4+ leading spaces).
        if (line.trim() !== "" && !/^ {4,}/.test(line) && i + 1 < n) {
            const underline = lines[i + 1].match(SETEXT_RE);
            if (underline) {
                const level = underline[1][0] === "=" ? 1 : 2;
                headings.push({ level, text: line.trim(), line: i + 1 });
                i++; // consume the underline line
            }
        }
    }

    return headings;
}
