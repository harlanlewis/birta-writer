/**
 * plugins/joinLines.ts — Join Lines (VS Code parity).
 *
 * Reachable from the command palette everywhere and Ctrl+J on macOS (a
 * contributed, rebindable keybinding in package.json — no ProseMirror keymap
 * here). Unbound on Windows/Linux, exactly like the built-in editor.
 *
 * STUB: honest no-op until the implementation lands (keyboard-canon work in
 * flight). Returning false keeps every fallthrough behavior intact.
 */
import type { Command } from "@milkdown/prose/state";

/** Join the next line/block onto the current one (single undo step). */
export const joinLinesCommand: Command = () => false;
