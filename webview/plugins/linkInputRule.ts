/**
 * Link input rule: typing the closing ")" of a literal `[text](url)`
 * construct in the document body converts it into `text` carrying a `link`
 * mark (href = url). Without this rule the commonmark preset leaves the
 * typed syntax as plain text forever — only a file reload would parse it.
 *
 * Follows the $inputRule composable pattern of the preset's strong/em rules
 * (@milkdown/preset-commonmark markRule), but with a custom handler because
 * markRule keeps the LAST capture group as the visible text while a link
 * must keep group 1 (the label) and move group 2 (the url) into the mark —
 * and it must accept an empty url (`[text]()`) so the link popup can fill
 * the href in afterwards, which markRule's empty-group guard would reject.
 *
 * The rule never fires inside code contexts: Milkdown's input-rule runner
 * already skips code blocks ($from.parent.type.spec.code), and the handler
 * additionally bails when the matched range carries an inline code mark.
 */
import { InputRule } from "@milkdown/prose/inputrules";
import type { EditorState, Transaction } from "@milkdown/prose/state";
import { $inputRule } from "@milkdown/utils";

/** Literal inline link syntax ending at the just-typed ")". */
export const LINK_INPUT_REGEX = /\[([^\[\]]+)\]\(([^()\s]*)\)$/;

/** True when any text node in [from, to) carries a code mark (inline code). */
function rangeHasCodeMark(state: EditorState, from: number, to: number): boolean {
    let hasCode = false;
    state.doc.nodesBetween(from, to, (node) => {
        if (node.isText && node.marks.some((m) => m.type.spec.code)) {
            hasCode = true;
        }
    });
    return hasCode;
}

/**
 * Builds the transaction that replaces the literal source range [start, end)
 * with `text` carrying a link mark (href = url; empty url allowed). Returns
 * null when the conversion must not happen (code context, no link mark in
 * the schema, empty label, atom placeholders in the match).
 *
 * Shared by the input rule below and by the caret URL autocomplete's pick
 * handler (webview/plugins/linkUrlComplete.ts), which applies the same
 * conversion directly because input rules only run on real typing.
 */
export function createLinkifyTr(
    state: EditorState,
    start: number,
    end: number,
    text: string,
    url: string,
): Transaction | null {
    const linkType = state.schema.marks["link"];
    if (!linkType) { return null; }
    if (!text.trim()) { return null; }
    // textBetween renders leaf nodes (images, inline HTML, ...) as U+FFFC;
    // a match containing one would delete a real atom node. Never convert.
    if (text.includes("\uFFFC") || url.includes("\uFFFC")) { return null; }
    const $start = state.doc.resolve(start);
    if ($start.parent.type.spec.code) { return null; } // code block
    if (rangeHasCodeMark(state, start, end)) { return null; } // inline code
    const { tr } = state;
    // Restore the pre-conversion stored marks afterwards so what the user
    // types NEXT does not extend the link (mirrors @milkdown/prose markRule).
    const storedMarks = tr.storedMarks ?? [];
    tr.delete(start, end);
    tr.insertText(text, start);
    tr.addMark(start, start + text.length, linkType.create({ href: url, title: null }));
    tr.setStoredMarks(storedMarks);
    return tr;
}

/**
 * The composable input rule. `start` is the doc position of the opening "[";
 * `end` is the caret — the typed ")" is part of the regex match but not yet
 * part of the document, so a returned transaction replaces `[text](url` and
 * the ")" is never inserted.
 */
export const linkInputRule = $inputRule(() =>
    new InputRule(LINK_INPUT_REGEX, (state, match, start, end) => {
        const [, text, url] = match;
        return createLinkifyTr(state, start, end, text ?? "", url ?? "");
    }),
);
