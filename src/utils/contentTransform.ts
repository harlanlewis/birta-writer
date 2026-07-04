/**
 * Pure-function transformation utilities for Markdown content, shared by MarkdownEditorProvider and unit tests.
 * These functions do not depend on the VSCode API (no webview.asWebviewUri), so they can be tested directly in a Node environment.
 */

/**
 * Extracts the YAML frontmatter from Markdown content.
 * Only recognizes the standard format at the very start of the file (--- ... ---).
 * The closing fence must be a FULL line of exactly `---` (followed by a line
 * break or end of file): inner lines that merely start with `---` (e.g.
 * `--- draft` or `----`) must not terminate the block, otherwise a save cycle
 * would truncate the document at that line. The lazy quantifier backtracks
 * past such lines until the real closing fence is found.
 */
export function extractFrontmatter(content: string): { frontmatter: string; body: string } {
    const match = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
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
