/**
 * Pure word tokenizer behind the spell check.
 *
 * Extracts checkable English word tokens from plain block text while
 * skipping everything that would produce false positives in a markdown
 * document: URLs, e-mails, file paths, code-ish identifiers (camelCase,
 * digits, ALL-CAPS acronyms), non-Latin words, and inline-node placeholders.
 */

export type WordToken = {
    /** The word, with typographic apostrophes normalized to ASCII */
    word: string;
    /** 0-indexed character offset of the token start (inclusive) */
    start: number;
    /** 0-indexed character offset of the token end (exclusive) */
    end: number;
};

/** Placeholder character used for non-text inline nodes (images, breaks). */
export const INLINE_PLACEHOLDER = "￼";

/**
 * Characters that mark a whitespace-delimited chunk as tech-speak (URL, path,
 * e-mail, domain…). Checked after trimming surrounding punctuation, so a
 * sentence-ending period doesn't veto its word but "example.com" is skipped.
 */
const TECH_CHUNK = /[./\\@_~#=&`]|:\/\//;

/** Word characters: any letter plus ASCII/typographic apostrophes. */
const WORD_RE = /[\p{L}][\p{L}'’]*/gu;

/** Strip punctuation that merely surrounds a chunk (quotes, brackets, sentence marks). */
function trimChunk(chunk: string): string {
    return chunk.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
}

function isCheckableWord(word: string): boolean {
    // Too short to be worth flagging ("a", "I", stray letters)
    if (word.length < 2) { return false; }
    // camelCase / PascalCase / ALL-CAPS acronyms are identifiers, not prose
    if (/[A-Z]/.test(word.slice(1))) { return false; }
    // Words with non-ASCII letters (café, 汉字) are outside the EN dictionary — skip, never flag
    if (/[^\x00-\x7F]/.test(word.replace(/’/g, "'"))) { return false; }
    return true;
}

/**
 * Tokenize text into spell-checkable words with their offsets.
 * The input is expected to be one block's plain text where inline code has
 * been masked with spaces and non-text nodes replaced by INLINE_PLACEHOLDER.
 */
export function extractWordTokens(text: string): WordToken[] {
    const tokens: WordToken[] = [];
    // Walk whitespace-delimited chunks so URL/path context can veto whole chunks
    const chunkRe = /\S+/g;
    let chunkMatch: RegExpExecArray | null;
    while ((chunkMatch = chunkRe.exec(text)) !== null) {
        const chunk = chunkMatch[0];
        // A chunk touching a non-text inline node (image, break) has unclear word edges — skip it
        if (chunk.includes(INLINE_PLACEHOLDER)) { continue; }
        const trimmed = trimChunk(chunk);
        if (!trimmed || TECH_CHUNK.test(trimmed) || /\p{N}/u.test(trimmed)) { continue; }

        WORD_RE.lastIndex = 0;
        let wordMatch: RegExpExecArray | null;
        while ((wordMatch = WORD_RE.exec(chunk)) !== null) {
            const raw = wordMatch[0];
            const word = raw.replace(/’/g, "'").replace(/'+$/, "");
            if (!isCheckableWord(word)) { continue; }
            tokens.push({
                word,
                start: chunkMatch.index + wordMatch.index,
                end: chunkMatch.index + wordMatch.index + word.length,
            });
        }
    }
    return tokens;
}
