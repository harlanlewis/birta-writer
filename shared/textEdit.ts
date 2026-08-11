/**
 * Pure text-diff helper for the CustomTextEditorProvider save path: turns a
 * whole-file "new content" string from the webview into a single minimal
 * range replacement against the current TextDocument text, so undo/redo and
 * the dirty state behave like a normal text edit instead of a full rewrite.
 */

export interface ReplaceRange {
    /** UTF-16 offset in the OLD text where the replacement starts. */
    startOffset: number;
    /** UTF-16 offset in the OLD text where the replacement ends (exclusive). */
    endOffset: number;
    /** Text to insert between startOffset and endOffset. */
    replacement: string;
}

/**
 * Computes the single range replacement that turns `oldText` into `newText`
 * by trimming the common prefix and suffix. Returns null when the texts are
 * identical.
 *
 * Boundary safety: neither offset ever lands between the `\r` and `\n` of a
 * CRLF pair, nor between the halves of a surrogate pair —
 * `TextDocument.positionAt` snaps such offsets, which would corrupt the edit.
 */
export function computeReplaceRange(
    oldText: string,
    newText: string,
): ReplaceRange | null {
    if (oldText === newText) {
        return null;
    }

    // Common prefix
    const minLen = Math.min(oldText.length, newText.length);
    let start = 0;
    while (start < minLen && oldText[start] === newText[start]) {
        start++;
    }
    // Never start the replacement inside a CRLF or surrogate pair: back up
    // until the boundary is clean on the OLD text (the prefix is shared, so
    // the same characters shift into the replacement on both sides).
    while (start > 0 && isUnsafeBoundary(oldText, start)) {
        start--;
    }

    // Common suffix (never overlapping the prefix)
    let oldEnd = oldText.length;
    let newEnd = newText.length;
    while (
        oldEnd > start &&
        newEnd > start &&
        oldText[oldEnd - 1] === newText[newEnd - 1]
    ) {
        oldEnd--;
        newEnd--;
    }
    // Same rule for the end offset: extend the replaced region forward so it
    // never cuts a CRLF or surrogate pair. The suffix is shared, so both
    // slices stay equal as characters move from suffix into replacement.
    while (oldEnd < oldText.length && isUnsafeBoundary(oldText, oldEnd)) {
        oldEnd++;
        newEnd++;
    }

    return {
        startOffset: start,
        endOffset: oldEnd,
        replacement: newText.slice(start, newEnd),
    };
}

/** True when `offset` splits a CRLF pair or a UTF-16 surrogate pair in `text`. */
function isUnsafeBoundary(text: string, offset: number): boolean {
    if (offset <= 0 || offset >= text.length) {
        return false;
    }
    if (text[offset - 1] === "\r" && text[offset] === "\n") {
        return true;
    }
    const prev = text.charCodeAt(offset - 1);
    const next = text.charCodeAt(offset);
    return prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}
