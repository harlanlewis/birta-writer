import type { TextCount } from "../../shared/messages";

/**
 * CJK-aware word / character / reading-time counting (MAR-29).
 *
 * Word counting differs by script. Latin (and other space-delimited) text is
 * counted in whitespace-separated words; CJK text has no inter-word spaces, so
 * each CJK character is counted as one "word" — the convention every prose
 * editor with mixed-script support uses (Word, Typora, MarkText). "hello"
 * followed by two CJK characters is therefore 1 + 2 = 3 "words".
 *
 * `characters` counts non-whitespace Unicode code points, so the synthetic
 * block separators the caller inserts between paragraphs never inflate it.
 */

/**
 * English silent-reading rate in words per minute. 238 wpm is the mean for
 * non-fiction from Brysbaert's 2019 meta-analysis ("How many words do we read
 * per minute?"), the most widely cited modern figure.
 */
const LATIN_WORDS_PER_MINUTE = 238;

/**
 * CJK silent-reading rate in characters per minute — an UNSOURCED ESTIMATE, not
 * a research figure. Brysbaert 2019 is Latin-alphabet focused and reports no
 * chars/min rate for Chinese, Japanese, or Korean, so it cannot back this
 * number (260 is its English *fiction* wpm, which is where this value appears
 * to have come from). Published CJK rates vary widely with text difficulty,
 * measurement paradigm, and reader population, and we have not adopted one.
 *
 * Treat this as a placeholder tuned to keep the readout plausible rather than
 * as an empirical claim: it only feeds a rounded "N min read" estimate, where
 * being off by a modest factor shifts the displayed minutes very little. If a
 * defensible source is ever chosen, update this constant and the reading-time
 * tests in `webview/__tests__/wordCount.test.ts` that pin 260 together.
 */
const CJK_CHARS_PER_MINUTE = 260;

/**
 * True for a code point in a CJK script that is counted per-character rather
 * than per-word: Hiragana/Katakana, CJK Unified Ideographs (incl. Extension A
 * and the astral extensions), compatibility ideographs, half-width Katakana,
 * and Hangul syllables.
 */
function isCjk(codePoint: number): boolean {
    return (
        (codePoint >= 0x3040 && codePoint <= 0x30ff) || // Hiragana + Katakana
        (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Extension A
        (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified Ideographs
        (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK Compatibility Ideographs
        (codePoint >= 0xff66 && codePoint <= 0xff9d) || // Half-width Katakana
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
        (codePoint >= 0x20000 && codePoint <= 0x2fa1f)  // CJK Extensions B–F + Compatibility Supplement
    );
}

/** A token counts as a Latin word only if it contains a letter or number. */
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * True for a code point JavaScript's `\s` matches, checked numerically so the
 * hot loop never allocates a single-character string to run a regex against.
 * Must stay in exact agreement with `/\s/` — pinned by a test that sweeps the
 * whole BMP plus the astral boundary.
 */
function isWhitespace(codePoint: number): boolean {
    if (codePoint === 0x20) { return true; }        // space — by far the most common
    if (codePoint < 0x09) { return false; }
    if (codePoint <= 0x0d) { return true; }         // \t \n \v \f \r
    if (codePoint < 0xa0) { return false; }
    return (
        codePoint === 0xa0 ||                        // no-break space
        codePoint === 0x1680 ||                      // Ogham space mark
        (codePoint >= 0x2000 && codePoint <= 0x200a) || // en quad … hair space
        codePoint === 0x2028 ||                      // line separator
        codePoint === 0x2029 ||                      // paragraph separator
        codePoint === 0x202f ||                      // narrow no-break space
        codePoint === 0x205f ||                      // medium mathematical space
        codePoint === 0x3000 ||                      // ideographic space
        codePoint === 0xfeff                         // zero-width no-break space (BOM)
    );
}

/** True for a code point that makes its token count as a word (letter or number). */
function isWordChar(codePoint: number): boolean {
    // ASCII fast path: covers virtually all Latin prose without touching a regex.
    if (codePoint < 0x80) {
        return (
            (codePoint >= 0x61 && codePoint <= 0x7a) || // a–z
            (codePoint >= 0x41 && codePoint <= 0x5a) || // A–Z
            (codePoint >= 0x30 && codePoint <= 0x39)    // 0–9
        );
    }
    return HAS_WORD_CHAR.test(String.fromCodePoint(codePoint));
}

/**
 * Count words, non-whitespace characters, and estimated reading time for a run
 * of plain text (already stripped of markdown syntax by the caller).
 *
 * Single pass over the code points, with no intermediate string or array: this
 * runs on the whole document on every recompute, so allocating per character
 * showed up as tens of milliseconds of main-thread block on large documents.
 * A CJK character terminates the surrounding Latin word exactly as whitespace
 * does, so "abc" followed by two CJK chars counts as 1 + 2 words.
 */
export function countText(text: string): TextCount {
    let characters = 0;
    let cjkChars = 0;
    let latinWords = 0;
    // Whether the Latin token currently being scanned has shown a letter or
    // number yet — that is what promotes a run of non-whitespace, non-CJK code
    // points from punctuation to a word. Flushed at every token boundary
    // (whitespace, a CJK character, or end of input).
    let tokenHasWordChar = false;

    for (let i = 0; i < text.length; i++) {
        let codePoint = text.charCodeAt(i);
        // Combine a surrogate pair into its astral code point, matching the
        // code-point iteration order of `for…of` (a lone surrogate stands alone).
        if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < text.length) {
            const low = text.charCodeAt(i + 1);
            if (low >= 0xdc00 && low <= 0xdfff) {
                codePoint = (codePoint - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
                i++;
            }
        }

        if (isWhitespace(codePoint)) {
            if (tokenHasWordChar) { latinWords++; }
            tokenHasWordChar = false;
            continue;
        }

        characters++;

        if (isCjk(codePoint)) {
            cjkChars++;
            if (tokenHasWordChar) { latinWords++; }
            tokenHasWordChar = false;
            continue;
        }

        if (!tokenHasWordChar && isWordChar(codePoint)) { tokenHasWordChar = true; }
    }
    if (tokenHasWordChar) { latinWords++; }

    const rawMinutes =
        latinWords / LATIN_WORDS_PER_MINUTE + cjkChars / CJK_CHARS_PER_MINUTE;

    return {
        words: latinWords + cjkChars,
        characters,
        readingTimeMinutes: rawMinutes > 0 ? Math.ceil(rawMinutes) : 0,
    };
}

/** Zero counts, for an empty document or when there is nothing to report. */
export const EMPTY_TEXT_COUNT: TextCount = {
    words: 0,
    characters: 0,
    readingTimeMinutes: 0,
};
