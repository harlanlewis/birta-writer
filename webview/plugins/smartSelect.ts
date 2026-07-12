/**
 * plugins/smartSelect.ts — Expand/Shrink Selection (VS Code smart select).
 *
 * The default chords are hardcoded ProseMirror keymap bindings, not
 * contributed keybindings: they collide with native contenteditable
 * selection behavior (word/line extension), so the default action must be
 * suppressed synchronously at the keydown — a round-trip through the
 * extension host would let the native selection change land first. Same
 * reasoning as the Alt+Arrow move-block bindings in blockKeys.ts. The
 * chords mirror the built-in editor per platform:
 *   - macOS:          Ctrl+Shift+Cmd+ArrowRight / ArrowLeft
 *   - Windows/Linux:  Shift+Alt+ArrowRight / ArrowLeft
 * Both are claimed by the key-leak guard (webview/keyboardShortcuts.ts) so
 * they never double-fire a workbench action; the palette entries
 * (`markdownWysiwyg.editor.expandSelection` / `shrinkSelection`) stay
 * rebindable to ADDITIONAL chords.
 *
 * STUB commands: honest no-ops until the implementation lands
 * (keyboard-canon work in flight). Returning false keeps native selection
 * behavior intact for now — the guard never calls preventDefault itself.
 */
import { keymap } from "@milkdown/prose/keymap";
import type { Command } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";

/** Grow the selection to the next enclosing syntactic range. */
export const expandSelection: Command = () => false;

/** Shrink the selection back one step of the expand ladder. */
export const shrinkSelection: Command = () => false;

export const smartSelectKeymapPlugin = $prose(() => {
    const isMac = window.__i18n?.isMac ?? /Mac/.test(navigator.platform);
    return keymap(
        isMac
            ? {
                "Ctrl-Shift-Cmd-ArrowRight": expandSelection,
                "Ctrl-Shift-Cmd-ArrowLeft": shrinkSelection,
            }
            : {
                "Shift-Alt-ArrowRight": expandSelection,
                "Shift-Alt-ArrowLeft": shrinkSelection,
            },
    );
});
