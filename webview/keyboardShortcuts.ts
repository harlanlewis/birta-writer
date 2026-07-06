/**
 * keyboardShortcuts.ts — the workbench key-leak guard.
 *
 * This module deliberately handles NO editor shortcuts of its own anymore.
 * Every UI-level action (find, find & replace, find next/previous, find &
 * replace selection, insert/edit link, switch to text editor) is a
 * contributed keybinding in package.json routed through a VS Code command
 * (`markdownWriter.editor.*` / `markdownWriter.switchToTextEditor`) back
 * into the webview, so users can rebind or unbind them like any other
 * keybinding. Those chords must stay visible to the workbench — never claim
 * them below, or the user's binding stops resolving.
 *
 * What remains hardcoded (and therefore claimed) are the typing-level keys
 * ProseMirror must handle synchronously inside the webview: formatting
 * (Mod+B/I/E, Mod+Shift+X), history (Mod+Z/Shift+Z/Y), and Tab. These cannot
 * be routed through the extension host because the keystroke's default action
 * (native contenteditable formatting, focus traversal, workbench side
 * effects like Cmd+B toggling the sidebar) has to be suppressed at the event
 * itself. Users can still bind ADDITIONAL chords to the corresponding
 * `markdownWriter.editor.toggle*` commands; only these defaults are fixed.
 */

import { fallbackKeyFromKeyCode, type EventManager } from "./eventManager";

// ── Workbench key-leak guard ─────────────────────────────────────────────
//
// The VS Code webview host attaches a bubble-phase keydown listener to the
// webview's `window` and forwards every key press to the workbench, so
// workbench keybindings work while a webview is focused. It does this even
// when the event was already handled inside the webview (ProseMirror's
// keymaps call preventDefault() but do NOT stop propagation), which is why
// e.g. Cmd+B both bolds the selection AND toggles the workbench sidebar.
//
// The fix is a single bubble-phase listener on `document` that stops
// propagation for key combos the editor claims for itself:
// - Bubble phase on `document` runs AFTER ProseMirror's handlers (bound on
//   the editor DOM), so everything that should handle the key has already
//   seen it.
// - `document` is one node below `window`, so stopPropagation() here is the
//   last stop before the host's forwarder. (A capture-phase listener on
//   `window` would be wrong: stopPropagation() during capture at `window`
//   would keep the event from ever reaching ProseMirror. And a bubble-phase
//   listener on `window` is too late: the host's forwarder is registered
//   first on that node.)
// - The guard never calls preventDefault(): whether the key's default action
//   is suppressed stays the decision of ProseMirror's keymaps.

/**
 * A key combo the editor claims for itself.
 * Modifiers not listed must NOT be pressed (exact matching), so e.g.
 * Cmd+Shift+E is not claimed by the Mod+E entry.
 */
interface ClaimedShortcut {
    /**
     * Produced character (KeyboardEvent.key), compared lowercase.
     * Layout-aware: ProseMirror keymaps match the produced character, so a
     * Dvorak Cmd+B (physical KeyN) bolds and must be claimed, while a
     * Dvorak Cmd+X (physical KeyB) is cut and must NOT be.
     */
    key?: string;
    /**
     * Platform primary modifier ("Mod"): Cmd (and not Ctrl) on macOS, Ctrl
     * (and not Cmd) elsewhere — the normalization prosemirror-keymap
     * applies to "Mod-" bindings, so the guard claims exactly the combos
     * ProseMirror responds to (e.g. Ctrl+Z on macOS is handled by nothing
     * and stays visible to the workbench).
     */
    mod?: boolean;
    shift?: boolean;
}

/** Combos handled inside the webview that must never reach the workbench. */
const CLAIMED_SHORTCUTS: ClaimedShortcut[] = [
    // formatKeymap plugin (webview/plugins/formatKeymap.ts)
    { key: "b", mod: true },                // bold
    { key: "i", mod: true },                // italic
    { key: "e", mod: true },                // inline code
    { key: "x", mod: true, shift: true },   // strikethrough
    // history plugin (webview/plugins/history.ts)
    { key: "z", mod: true },                // undo
    { key: "z", mod: true, shift: true },   // redo
    { key: "y", mod: true },                // redo
];

/** Whether a keydown matches a combo the editor handles itself. */
function isEditorClaimedKey(e: KeyboardEvent, isMac: boolean): boolean {
    // Tab is claimed by the tabKeymap plugin, but only inside ProseMirror
    // content — in overlay inputs (find bar, toolbars) Tab must keep its
    // native focus-traversal behavior and stay visible to the workbench.
    if (e.code === "Tab") {
        return (
            !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey &&
            e.target instanceof Element &&
            e.target.closest(".ProseMirror") !== null
        );
    }

    if (e.altKey) { return false; }

    // Everything else is claimed document-wide: the whole webview document
    // is editor UI (content, topbar, TOC, find bar, ...), and these combos
    // must not trigger workbench actions no matter which part has focus.
    const eventKey = e.key.toLowerCase();
    // prosemirror-keymap also resolves bindings via base[event.keyCode] when
    // the produced char is non-ASCII (non-Latin layouts: Russian Ctrl+Z has
    // key "я", keyCode 90 → PM handles Mod-z). The guard must claim those
    // too, or the chord leaks to the workbench and the action fires twice.
    const fallbackKey = fallbackKeyFromKeyCode(e);
    for (const s of CLAIMED_SHORTCUTS) {
        if (eventKey !== s.key && fallbackKey !== s.key) { continue; }
        if (s.mod) {
            // Platform primary modifier only (see ClaimedShortcut.mod)
            const primary = isMac
                ? e.metaKey && !e.ctrlKey
                : e.ctrlKey && !e.metaKey;
            if (!primary) { continue; }
        }
        if (e.shiftKey !== !!s.shift) { continue; }
        return true;
    }
    return false;
}

/** Install the key-leak guard (see the comment block above). */
export function initKeyboardShortcuts(eventManager: EventManager): void {
    const isMac = window.__i18n?.isMac ?? /Mac/.test(navigator.platform);

    // Keep claimed combos from reaching the VS Code webview host's
    // window-level key forwarder.
    eventManager.onDocument("keydown", (e) => {
        if (isEditorClaimedKey(e, isMac)) {
            // stopPropagation only — never preventDefault — so ProseMirror
            // keeps full control of the key.
            e.stopPropagation();
        }
    });
}
