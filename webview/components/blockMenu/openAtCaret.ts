/**
 * webview/components/blockMenu/openAtCaret.ts
 *
 * Keyboard path into the gutter block menu (markdownWysiwyg.editor.
 * openBlockMenu — the mouse path is clicking a gutter marker).
 *
 * SCAFFOLD: honest no-op (returns false — nothing opened) until the block
 * menu implementer lands it. The real implementation resolves the caret's
 * top-level block position, finds that block's gutter marker element
 * (`.heading-fold-marker` — present in the DOM regardless of hover
 * visibility; resolve block pos, then `view.nodeDOM(pos)` and query for the
 * marker), and calls `openBlockMenu(view, blockPos, marker, true)` from
 * ./index — the `true` (viaKeyboard) makes Escape return focus to the
 * marker. The menu is fully keyboard-navigable once open.
 */
import type { EditorView } from "@milkdown/prose/view";

/**
 * Open the block menu anchored to the caret's block. Returns whether a menu
 * was opened. SCAFFOLD: no-op.
 */
export function openBlockMenuAtCaret(view: EditorView): boolean {
    void view;
    return false;
}
