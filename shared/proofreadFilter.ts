/**
 * Heuristics deciding whether a flagged span is prose (worth showing) or a
 * tech-like token (paths, URLs, identifiers, inline-node placeholders) that
 * a prose checker should stay quiet about. Shared between the extension
 * host (filtering Harper lints) and tests.
 */

/** Placeholder character the webview uses for non-text inline nodes. */
export const INLINE_PLACEHOLDER = "￼";

/** Characters that mark a whitespace-delimited chunk as tech-speak (URL, path, e-mail…). */
const TECH_CHUNK = /[./\\@_~#=&`]|:\/\/|￼/;

/** Strip punctuation that merely surrounds a chunk (quotes, brackets, sentence marks). */
function trimChunk(chunk: string): string {
    return chunk.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
}

/**
 * True when the span at [start, end) sits inside a tech-like context:
 * its containing whitespace-delimited chunk looks like a path/URL/e-mail,
 * or the span itself is an identifier (internal capitals, digits).
 */
export function isTechSpan(text: string, start: number, end: number): boolean {
    const spanText = text.slice(start, end);
    // Identifier-shaped: camelCase/PascalCase/ALL-CAPS beyond the first letter, or digits
    if (/[^\s]/.test(spanText) && !spanText.includes(" ")) {
        if (/[A-Z]/.test(spanText.slice(1))) { return true; }
        if (/\p{N}/u.test(spanText)) { return true; }
    }
    // Expand to the containing whitespace-delimited chunk and test its shape
    let chunkStart = start;
    while (chunkStart > 0 && !/\s/.test(text[chunkStart - 1])) { chunkStart--; }
    let chunkEnd = end;
    while (chunkEnd < text.length && !/\s/.test(text[chunkEnd])) { chunkEnd++; }
    const chunk = text.slice(chunkStart, chunkEnd);
    if (chunk.includes(INLINE_PLACEHOLDER)) { return true; }
    return TECH_CHUNK.test(trimChunk(chunk));
}
