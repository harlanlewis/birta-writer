/**
 * Maps Markdown content into an array of paragraph line numbers (used for editor line highlighting and global search jumps).
 * Each element is the starting line number (1-indexed) of a "paragraph" (a group of non-empty lines).
 * Code blocks are treated as a single unit and their inner lines are not split.
 *
 * Shared between the extension host (line sync, scroll mapping) and the
 * webview (local recompute for the find bar's raw-source fallback).
 */
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
