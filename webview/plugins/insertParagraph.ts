/**
 * plugins/insertParagraph.ts — Insert Paragraph After/Before (VS Code's
 * "Insert Line Below/Above", block-flavored).
 *
 * Mod-Enter / Mod-Shift-Enter are typing-level chords: they must be handled
 * synchronously in a ProseMirror keymap (an extension-host round-trip would
 * let contenteditable's default Enter handling race the command). Claimed by
 * the key-leak guard (webview/keyboardShortcuts.ts); the palette entries
 * (`markdownWysiwyg.editor.insertParagraphAfter` / `insertParagraphBefore`)
 * stay rebindable to ADDITIONAL chords.
 *
 * CONSTRAINT for the implementation: the commonmark preset already binds
 * Mod-Enter to exit code blocks and tables. This plugin is registered BEFORE
 * the presets (editor.ts), so its bindings win — the commands MUST return
 * false whenever the selection is inside a code block or table so the
 * preset's exit behavior keeps working.
 *
 * STUB commands: honest no-ops until the implementation lands
 * (keyboard-canon work in flight). Returning false hands Mod-Enter straight
 * to the presets, preserving today's behavior exactly.
 */
import { keymap } from "@milkdown/prose/keymap";
import type { Command } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";

/** Insert an empty paragraph after the current block and move the caret in. */
export const insertParagraphAfter: Command = () => false;

/** Insert an empty paragraph before the current block and move the caret in. */
export const insertParagraphBefore: Command = () => false;

export const insertParagraphKeymapPlugin = $prose(() =>
    keymap({
        "Mod-Enter": insertParagraphAfter,
        "Mod-Shift-Enter": insertParagraphBefore,
    }),
);
