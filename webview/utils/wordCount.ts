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
 * CJK silent-reading rate in characters per minute. ~260 cpm is a representative
 * value for Chinese from the same body of reading-rate research; CJK text packs
 * more meaning per character, so it is read faster per "word" than Latin.
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
 * Count words, non-whitespace characters, and estimated reading time for a run
 * of plain text (already stripped of markdown syntax by the caller).
 */
export function countText(text: string): TextCount {
    let characters = 0;
    let cjkChars = 0;
    // Latin text with every CJK code point replaced by a space, so a CJK
    // character always terminates the surrounding Latin word even when no real
    // whitespace separates them ("abc" + two CJK chars counts as 1 + 2 words).
    const latinParts: string[] = [];

    for (const ch of text) {
        const codePoint = ch.codePointAt(0)!;
        if (!/\s/.test(ch)) { characters++; }
        if (isCjk(codePoint)) {
            cjkChars++;
            latinParts.push(" ");
        } else {
            latinParts.push(ch);
        }
    }

    const latinWords = latinParts
        .join("")
        .split(/\s+/)
        .filter((token) => HAS_WORD_CHAR.test(token)).length;

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
