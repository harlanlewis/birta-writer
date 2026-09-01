/**
 * Pure-function transformation utilities for Markdown content, shared by MarkdownEditorProvider and unit tests.
 * These functions do not depend on the VSCode API (no webview.asWebviewUri), so they can be tested directly in a Node environment.
 */

/**
 * Extracts the frontmatter block from Markdown content.
 * Only recognizes a block at the very start of the file, fenced by either
 * `---` (YAML) or `+++` (TOML, the Hugo/Zola convention).
 *
 * The closing fence must be a FULL line of exactly the OPENING delimiter
 * (followed by a line break or end of file), which the backreference enforces.
 * Two properties follow, and both are load-bearing:
 *
 * - Inner lines that merely start with the delimiter (`--- draft`, `----`,
 *   `++++`) must not terminate the block, otherwise a save cycle would truncate
 *   the document at that line. The lazy quantifier backtracks past such lines
 *   until the real closing fence is found.
 * - A block opened with one delimiter is never closed by the other. A
 *   mismatched pair is not frontmatter at all, so the panel can never write one
 *   dialect's fence over the other's.
 *
 * Ported into Swift as `Frontmatter.split` (mac/Sources/BirtaWriterCore/
 * Frontmatter.swift), pattern string included, with the cases below mirrored
 * there. Splitting is the host's job on every surface, so a change here needs
 * the same change there or the two disagree about the same file's bytes.
 * `shared/__tests__/frontmatterPort.test.ts` compares the two pattern strings,
 * so that is a check rather than a request.
 */
export function extractFrontmatter(content: string): { frontmatter: string; body: string } {
    const match = content.match(/^(---|\+\+\+)\r?\n[\s\S]*?\r?\n\1(?:\r?\n|$)/);
    if (match) {
        return { frontmatter: match[0], body: content.slice(match[0].length) };
    }
    return { frontmatter: "", body: content };
}

/**
 * Restores webviewUri values back to relative paths and prepends the frontmatter.
 * The pure-function extracted version corresponding to _prepareContentForSave.
 */
export function restoreContentForSave(
    content: string,
    frontmatter: string,
    uriMap: Map<string, string>,
): string {
    let result = frontmatter ? frontmatter + content : content;
    for (const [webviewUri, relPath] of uriMap) {
        result = result.split(webviewUri).join(relPath);
    }
    return result;
}
