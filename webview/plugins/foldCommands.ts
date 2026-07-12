/**
 * webview/plugins/foldCommands.ts
 *
 * ProseMirror commands behind the contributed section-folding entries
 * (markdownWysiwyg.editor.foldSection / unfoldSection / foldAllSections /
 * unfoldAllSections), dispatched through the editor-command registry.
 *
 * SCAFFOLD: honest no-ops (return false) until the fold implementer lands
 * them. The real commands work against headingFold's plugin state
 * (webview/plugins/headingFold.ts):
 *   - foldSection / unfoldSection: resolve the caret's enclosing section via
 *     `findSectionHeadingPosAt` (exported from ./headingFold) and dispatch
 *     the existing single-heading `{ type: "toggle", pos }` meta — only when
 *     the toggle actually changes state (fold on an already-folded section
 *     returns false rather than unfolding it);
 *   - foldAllSections / unfoldAllSections: enumerate foldable headings via
 *     `computeFoldRanges(doc)` / `cachedFoldRanges(doc)` and dispatch the
 *     wholesale `{ type: "setAll", folded }` meta added for exactly this;
 *   - every dispatch must carry setMeta("addToHistory", false), matching the
 *     gutter chevron — fold state is a view concern, never an undo step.
 */
import type { Command } from "@milkdown/prose/state";

/** Fold the section containing the caret. SCAFFOLD: no-op. */
export const foldSection: Command = () => false;

/** Unfold the section containing the caret. SCAFFOLD: no-op. */
export const unfoldSection: Command = () => false;

/** Fold every foldable section in the document. SCAFFOLD: no-op. */
export const foldAllSections: Command = () => false;

/** Unfold every folded section in the document. SCAFFOLD: no-op. */
export const unfoldAllSections: Command = () => false;
