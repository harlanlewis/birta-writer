/**
 * shared/fixedChords.ts
 *
 * The chords the EDITOR binds itself, per command, in ProseMirror's notation.
 *
 * Fixed means not rebindable, on any surface: these are ProseMirror keymaps
 * rather than contributed keybindings, because they collide with native
 * contenteditable behavior and have to be handled synchronously at the keydown
 * (the argument is in `webview/plugins/formatKeymap.ts`, and the full
 * inventory of hardcoded chords, with each one's key-leak claim decision, is
 * `shared/__tests__/keymapChords.ts`).
 *
 * Which is exactly what makes them the only chords the editor may PRINT
 * without a host's help: no user configuration can move them and no host can
 * take them away, so a tooltip naming one cannot be wrong.
 *
 * Here rather than beside the resolver that reads it (`webview/commandChords.
 * ts`) because two consumers need it and one of them cannot load webview code:
 * `shared/__tests__/menuChordParity.test.ts` holds the Mac app's menu chords against
 * both this table and the extension's contributed keybindings, and a menu row
 * for Bold has to be measured against the keymap rather than against
 * package.json, which contributes nothing for it.
 *
 * A subset, deliberately: a command belongs here when chrome names it and the
 * editor binds it outright. Adding an entry is a claim that the chord cannot
 * change under the user, so it is checked against the keymap inventory by that
 * same test.
 */
import type { EditorCommandId } from "./editorCommands";

export const FIXED_COMMAND_CHORDS: Partial<Record<EditorCommandId, string>> = {
    toggleBold: "Mod-b",
    toggleItalic: "Mod-i",
    toggleInlineCode: "Mod-e",
    toggleStrikethrough: "Mod-Shift-x",
};
