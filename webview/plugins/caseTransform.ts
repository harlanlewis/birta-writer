/**
 * plugins/caseTransform.ts — selection case transforms (VS Code parity).
 *
 * Palette-only commands (no keybindings, like the built-in editor's
 * "Transform to …" family): uppercase, lowercase, and title case over the
 * current text selection, preserving inline marks.
 *
 * STUB: honest no-ops until the implementation lands (keyboard-canon work in
 * flight). Returning false keeps every fallthrough behavior intact.
 */
import type { Command } from "@milkdown/prose/state";

/** Uppercase the selected text. */
export const transformToUppercase: Command = () => false;

/** Lowercase the selected text. */
export const transformToLowercase: Command = () => false;

/** Title-case the selected text. */
export const transformToTitleCase: Command = () => false;
