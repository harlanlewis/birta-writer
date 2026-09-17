/**
 * components/gotoLine/parse.ts
 *
 * What a line number typed into the Go to Line prompt means, with no DOM.
 *
 * The rule is VS Code's own for its Go to Line input, because a reader who
 * reaches for Ctrl+G brings that input's habits with them: digits are a line,
 * a leading `:` is tolerated (the quick-open spelling, `:42`), whitespace is
 * ignored, and anything else is not a line at all. A number past the end is
 * refused rather than clamped: the prompt says so and keeps the field open,
 * since "go to line 900" of a 300-line document is more often a typo than a
 * wish to land at the end. Zero and negatives are refused for the same
 * reason. A column after a second `:` (`42:7`) is read too, so a `file:line:col`
 * reference pasted whole lands on the character it names.
 */
import type { GotoLineTarget } from "./loader";

export type { GotoLineTarget } from "./loader";

export type GotoLineParse =
    | { kind: "empty" }
    | { kind: "target"; target: GotoLineTarget }
    | { kind: "outOfRange"; line: number }
    | { kind: "invalid" };

// The column's digits are optional after the colon, so `42:` on the way to
// `42:7` is still line 42 rather than a refusal that flashes mid-keystroke.
const SHAPE = /^:?(\d+)(?::(\d*))?$/;

/**
 * Read `text` against a document of `lineCount` lines.
 *
 * `lineCount` below 1 is treated as 1: every document has a first line, and
 * a prompt over an empty buffer should still be able to go to it.
 */
export function parseGotoLine(text: string, lineCount: number): GotoLineParse {
    const trimmed = text.trim();
    if (trimmed === "" || trimmed === ":") { return { kind: "empty" }; }
    const match = SHAPE.exec(trimmed);
    if (!match) { return { kind: "invalid" }; }
    const line = Number.parseInt(match[1]!, 10);
    const last = Math.max(1, Math.floor(lineCount));
    if (!Number.isFinite(line) || line < 1 || line > last) { return { kind: "outOfRange", line }; }
    const column = match[2] ? Math.max(0, Number.parseInt(match[2], 10) - 1) : undefined;
    return { kind: "target", target: column === undefined ? { line } : { line, column } };
}
