/**
 * Math-aware `*` emphasis.
 *
 * Milkdown's stock star rule turns `*text*` into emphasis the moment the
 * closing `*` is typed — including INTRAWORD stars, which CommonMark permits
 * for `*`. That is exactly where inline arithmetic dies: typing
 * `60*60*1000ms in hr` italicizes the middle `60` and eats both stars, so the
 * calc layer sees `60601000ms` and the user sees italics they never asked
 * for. This rule replaces the stock one with the same behavior EXCEPT when
 * the star pair reads as multiplication:
 *
 * - the char before the opening `*` is a digit / `.` / `)` (`2*x*`), or
 * - it is any word character and the captured span carries a digit
 *   (`budget*2*`),
 * and the captured span contains only expression material (identifiers,
 * digits, operators — `great*idea*` still italicizes).
 *
 * Suppression leaves the literal `*` in the text node; the serializer escapes
 * it (`\*`), so the file round-trips and re-opens as literal text. A file
 * authored ELSEWHERE with bare `60*60*1000` still parses as emphasis at load
 * — that is CommonMark's reading of those bytes, and reinterpreting the
 * parser would gamble round-trip fidelity; write `60 * 60` (flanking spaces
 * are never emphasis) or use a ```calc block for formula-heavy work.
 *
 * `pureCommonmark` filters the stock rule via `emphasisInputReplacedPlugins`
 * and registers this one (the headingInput replaced-plugins pattern), so
 * every construction site — production and tests — gets the same behavior.
 */
import { InputRule, markRule } from "../pm";
import type { EditorState, Transaction } from "../pm";
import { emphasisSchema, emphasisStarInputRule } from "@milkdown/preset-commonmark";
import { $inputRule } from "@milkdown/utils";

/** The stock rule's regex, verbatim. */
const STAR_EMPHASIS = /(?:^|[^*])\*([^*]+)\*$/;

/** Captured span is expression material only (idents, digits, operators). */
const ARITHMETIC_SPAN = /^[\w.+\-/%^() ,°πτ']*$/u;

/** Would this star pair read as multiplication, not emphasis? */
export function starPairIsMath(prefixChar: string, captured: string): boolean {
    if (!ARITHMETIC_SPAN.test(captured)) { return false; }
    if (/[0-9.)]/.test(prefixChar)) { return true; }
    return /[\w)]/u.test(prefixChar) && /\d/.test(captured);
}

export const mathAwareEmphasisStarInputRule = $inputRule((ctx) => {
    const base = markRule(STAR_EMPHASIS, emphasisSchema.type(ctx), {
        getAttr: () => ({ marker: "*" }),
        updateCaptured: ({ fullMatch, start }) =>
            !fullMatch.startsWith("*")
                ? { fullMatch: fullMatch.slice(1), start: start + 1 }
                : {},
    }) as InputRule & {
        // prosemirror-inputrules stores the handler as a public field; typings
        // mark it internal, so name it here to delegate to the stock behavior.
        handler: (
            state: EditorState,
            match: RegExpMatchArray,
            start: number,
            end: number,
        ) => Transaction | null;
    };
    return new InputRule(STAR_EMPHASIS, (state, match, start, end) => {
        // The regex's optional first char IS the char before the opening `*`
        // ("" only at a hard start, which is always prose-legit).
        const prefixChar = match[0].startsWith("*") ? "" : match[0][0];
        if (starPairIsMath(prefixChar, match[1] ?? "")) { return null; }
        return base.handler(state, match, start, end);
    });
});

/** The stock preset plugin this module replaces. */
export const emphasisInputReplacedPlugins = new Set<unknown>([emphasisStarInputRule]);
