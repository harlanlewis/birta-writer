/**
 * src/utils/linkTargetSuggestions.ts
 *
 * Pure path math for link target suggestions: converts absolute workspace
 * file paths into the two forms the WebView offers the user — relative to
 * the current document and relative to the workspace root (leading slash).
 * Separated from MarkdownEditorProvider so it is unit-testable without a
 * WebView panel.
 */
import * as path from "path";
import type { LinkTargetSuggestionItem } from "../../shared/messages";

/** Normalizes a platform path to forward slashes for markdown links. */
function toPosix(p: string): string {
    return p.split(path.sep).join("/");
}

/**
 * Builds both link forms for every candidate file. The document itself is
 * never suggested, and files outside the workspace root are skipped (they
 * have no sensible root-relative form).
 */
export function buildLinkTargetItems(
    fileFsPaths: readonly string[],
    docFsPath: string,
    workspaceRootFsPath: string,
): LinkTargetSuggestionItem[] {
    const docDir = path.dirname(docFsPath);
    const items: LinkTargetSuggestionItem[] = [];
    for (const fsPath of fileFsPaths) {
        if (fsPath === docFsPath) { continue; }
        const fromRoot = path.relative(workspaceRootFsPath, fsPath);
        if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) { continue; }
        items.push({
            relative: toPosix(path.relative(docDir, fsPath)),
            rootRelative: "/" + toPosix(fromRoot),
        });
    }
    return items;
}
