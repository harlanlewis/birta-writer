import { history, redo, undo } from "../pm";
import { keymap } from "../pm";
import { $prose } from "@milkdown/utils";

// Register the ProseMirror history plugin (undo/redo support)
export const historyPlugin = $prose(() => history());

// Shortcuts: Mod-z = undo, Mod-Shift-z / Mod-y = redo.
// ProseMirror preventDefaults these but they still bubble to the VS Code
// webview key forwarder; the key-leak guard in webview/keyboardShortcuts.ts
// stops their propagation so the workbench never double-handles undo/redo.
export const historyKeymapPlugin = $prose(() =>
    keymap({
        "Mod-z": undo,
        "Mod-y": redo,
        "Mod-Shift-z": redo,
    }),
);
