/**
 * Maps Markdown content into an array of paragraph line numbers (used for editor line highlighting and global search jumps).
 * Each element is the starting line number (1-indexed) of a "paragraph" (a group of non-empty lines).
 * Code blocks are treated as a single unit and their inner lines are not split.
 *
 * Shared between the extension host (line sync, scroll mapping) and the
 * webview (local recompute for the find bar's raw-source fallback).
 */
/**
 * How many source lines `text` occupies — used for the frontmatter block, whose
 * lines precede the body the webview renders and therefore offset every
 * document line the two sides exchange (MAR-23).
 *
 * A frontmatter block always ends with its closing fence (`---` or `+++`), with
 * or without the trailing newline a file that ends there would lack, so counting
 * line terminators is exactly the number of lines the BODY is pushed down by.
 * The count is delimiter-agnostic, so no dialect needs a case here.
 *
 * Ported into Swift as `Frontmatter.sourceLineCount` (mac/Sources/
 * BirtaWriterCore/Frontmatter.swift), which every host must send with the split
 * it makes, so a change here needs the same change there. That side counts
 * unicode scalars rather than characters, because Swift makes `\r\n` one
 * Character and a CRLF block counted the obvious way reports zero.
 */
export function sourceLineCount(text: string): number {
    let count = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") { count++; }
    }
    return count;
}

export function computeLineMap(content: string): number[] {
    const lines = content.split("\n");
    const map: number[] = [];
    let i = 0;
    while (i < lines.length) {
        while (i < lines.length && lines[i].trim() === "") i++;
        if (i >= lines.length) break;
        map.push(i + 1);
        const fenceMatch = lines[i].trimStart().match(/^(`{3,}|~{3,})/);
        if (fenceMatch) {
            const fence = fenceMatch[1];
            i++;
            while (i < lines.length && !lines[i].trimStart().startsWith(fence)) i++;
            if (i < lines.length) i++;
        } else {
            while (i < lines.length && lines[i].trim() !== "") i++;
        }
    }
    return map;
}
