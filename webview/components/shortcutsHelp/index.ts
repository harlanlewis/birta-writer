/**
 * webview/components/shortcutsHelp/index.ts
 *
 * The keyboard-shortcuts HELP overlay (markdownWysiwyg.editor.
 * openShortcutsHelp) — a read-only cheatsheet. Deliberately distinct from
 * `openKeyboardShortcuts`, which opens VS Code's native Keyboard Shortcuts
 * UI and remains the customize/rebind path; this overlay should link to it
 * with a button rather than duplicating it.
 *
 * SCAFFOLD: empty opener until the cheatsheet implementer lands it. The
 * real implementation MUST:
 *   - register with webview/ui/escapeLayers.ts (`registerEscapeLayer`) while
 *     open, and unregister on close, so Escape closes surfaces in order;
 *   - NEVER print rebindable chords: contributed keybindings can be rebound
 *     and the webview cannot query the user's effective bindings, so any
 *     printed default may be wrong (the policy noHardcodedKeybindings.test.ts
 *     enforces for kbd()/tooltip labels applies here too). Only fixed-grammar
 *     keys — typing-level ProseMirror keymap chords, Escape, Tab, arrows —
 *     may be named; for everything rebindable, point at the native Keyboard
 *     Shortcuts UI via the existing `openKeyboardShortcuts` command;
 *   - keep launch cost at zero: this module is in the eager import graph
 *     (webview/index.ts wires it into the command host), so build the
 *     overlay DOM lazily on first open, never at module load.
 */

/** Open the shortcuts-help overlay. SCAFFOLD: no-op. */
export function openShortcutsHelp(): void {
    // SCAFFOLD: no overlay yet.
}
