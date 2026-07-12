/**
 * plugins/caseTransform.ts — selection case transforms (VS Code parity, MAR-97).
 *
 * Palette-only commands (no keybindings, like the built-in editor's
 * "Transform to …" family): uppercase, lowercase, and title case over the
 * current selection.
 *
 * Semantics:
 *  - Operates on every range of the selection (`selection.ranges`), so
 *    TextSelection, CellSelection and BlockRangeSelection all work — a block
 *    range is just a single wide range.
 *  - Only TEXT nodes are rewritten, segment by segment, each reusing its own
 *    node's marks — bold/link/code-span extents are preserved exactly, and
 *    node boundaries never move. Non-text inline nodes are never entered:
 *    `math_inline` keeps its LaTeX (which is literal text CONTENT, see
 *    plugins/math.ts), wikilinks and images are untouched.
 *  - Case mapping is locale-independent `toUpperCase()`/`toLowerCase()`
 *    (Unicode-aware by default). Title case capitalizes the first
 *    letter-or-digit after a simple word boundary (whitespace/punctuation —
 *    no stopword rules) and lowercases the rest of the word; an apostrophe
 *    continues a word only mid-word ("it's" → "It's", "'quoted" → "'Quoted"),
 *    matching VS Code. Word state carries across mark boundaries within a
 *    text run ("he**llo**" is one word) and resets across any gap — block
 *    boundaries and inline atoms both start a new word.
 *  - Caret-only selection, or a selection containing no text nodes: false.
 *  - A non-empty text selection is always "handled" (true), but when the
 *    mapped text equals the original nothing is dispatched — running a
 *    transform twice causes no doc churn and no extra undo step.
 *  - Each transform is one transaction, hence one undo step.
 */
import type { Command } from "@milkdown/prose/state";
import type { Mark } from "@milkdown/prose/model";

/** Per-range text mapper; `boundary()` is called at every word-state gap. */
interface SegmentMapper {
    map(text: string): string;
    boundary(): void;
}

/** Stateless mapper (upper/lower) — one shared instance is fine. */
const constantMapper = (fn: (text: string) => string): SegmentMapper => ({
    map: fn,
    boundary: () => {},
});

const upperMapper = constantMapper((text) => text.toUpperCase());
const lowerMapper = constantMapper((text) => text.toLowerCase());

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Stateful title-case mapper: tracks whether we are inside a word. */
function titleMapper(): SegmentMapper {
    let inWord = false;
    return {
        map(text: string): string {
            let out = "";
            for (const ch of text) {
                if (LETTER_OR_DIGIT.test(ch)) {
                    out += inWord ? ch.toLowerCase() : ch.toUpperCase();
                    inWord = true;
                } else {
                    out += ch;
                    // An apostrophe continues a word only when already inside
                    // one; any other non-letter char is a word boundary.
                    inWord = inWord && (ch === "'" || ch === "’");
                }
            }
            return out;
        },
        boundary() {
            inWord = false;
        },
    };
}

interface Replacement {
    from: number;
    to: number;
    text: string;
    marks: readonly Mark[];
}

/** Builds a case-transform command from a mapper factory. */
function makeCaseCommand(createMapper: () => SegmentMapper): Command {
    return (state, dispatch) => {
        const { selection, doc } = state;
        if (selection.empty) {
            return false;
        }

        const replacements: Replacement[] = [];
        let sawText = false;

        for (const range of selection.ranges) {
            const from = range.$from.pos;
            const to = range.$to.pos;
            if (to <= from) {
                continue;
            }
            const mapper = createMapper();
            // End position of the previous text segment; a gap (block
            // boundary, inline atom) resets the title-case word state.
            let lastEnd = -1;
            doc.nodesBetween(from, to, (node, pos) => {
                if (!node.isText) {
                    // Descend into blocks, but never into non-text inline
                    // nodes: math_inline stores its LaTeX as text content,
                    // wikilinks/images are atoms — all stay untouched.
                    return !node.isInline;
                }
                const start = Math.max(from, pos);
                const end = Math.min(to, pos + node.nodeSize);
                if (end <= start) {
                    return false;
                }
                sawText = true;
                if (start !== lastEnd) {
                    mapper.boundary();
                }
                lastEnd = end;
                const original = node.text!.slice(start - pos, end - pos);
                const mapped = mapper.map(original);
                if (mapped !== original) {
                    replacements.push({ from: start, to: end, text: mapped, marks: node.marks });
                }
                return false;
            });
        }

        if (!sawText) {
            return false;
        }
        if (replacements.length > 0 && dispatch) {
            const tr = state.tr;
            // Back-to-front so earlier positions stay valid even when the
            // mapped text changes length (e.g. "ß".toUpperCase() === "SS").
            for (let i = replacements.length - 1; i >= 0; i--) {
                const r = replacements[i]!;
                tr.replaceWith(r.from, r.to, state.schema.text(r.text, r.marks));
            }
            dispatch(tr.scrollIntoView());
        }
        // Handled whenever a non-empty text selection existed, even if the
        // text was already in the target case (VS Code parity).
        return true;
    };
}

/** Uppercase the selected text. */
export const transformToUppercase: Command = makeCaseCommand(() => upperMapper);

/** Lowercase the selected text. */
export const transformToLowercase: Command = makeCaseCommand(() => lowerMapper);

/** Title-case the selected text. */
export const transformToTitleCase: Command = makeCaseCommand(titleMapper);
