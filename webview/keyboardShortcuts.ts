/**
 * keyboardShortcuts.ts — the workbench key-leak guard.
 *
 * This module deliberately handles NO editor shortcuts of its own anymore.
 * Every UI-level action (find, find & replace, find next/previous, find &
 * replace selection, insert/edit link, switch to text editor) is a
 * contributed keybinding in package.json routed through a VS Code command
 * (`birta.editor.*` / `birta.switchToTextEditor`) back
 * into the webview, so users can rebind or unbind them like any other
 * keybinding. Those chords must stay visible to the workbench — never claim
 * them below, or the user's binding stops resolving.
 *
 * What remains hardcoded are the typing-level keys ProseMirror must handle
 * synchronously inside the webview: formatting (Mod+B/I/E, Mod+Shift+X),
 * history (Mod+Z/Shift+Z/Y), Tab, and the block/selection chords. These
 * cannot be routed through the extension host because the keystroke's
 * default action (native contenteditable formatting/selection, focus
 * traversal, workbench side effects like Cmd+B toggling the sidebar) has to
 * be suppressed at the event itself. Users can still bind ADDITIONAL chords
 * to the corresponding `birta.editor.*` commands; only these defaults are
 * fixed.
 *
 * ── THE CLAIM RULE (stated here once; every other site derives from it) ──
 *
 * Hardcoded is not the same as claimed. A chord is CLAIMED — hidden from the
 * workbench forwarder — if and only if the webview OWNS IT OUTRIGHT: there
 * is no editor state in which we deliberately hand the key back to the
 * platform or the workbench.
 *
 * The rule is NOT "mutates the document" and NOT "mutates the document or
 * selection"; the code falsifies both. Mod+Backspace mutates the document
 * (join/delete at a list item's start) and is deliberately UNCLAIMED, while
 * Mod+A and the smart-select chords mutate only the selection and ARE
 * claimed. What decides it is fall-through, because this guard is a static
 * table that runs BLIND to editor state: claiming a chord whose keymap
 * deliberately returns false in some state would silently break exactly that
 * state's native behavior, while leaving an outright-owned chord unclaimed
 * lets a user-bound workbench action fire alongside our handler (the
 * double-fire bug MAR-150 was filed for).
 *
 * Three classes follow:
 *   1. Owned outright — listed in CLAIMED_SHORTCUTS, or special-cased in
 *      isEditorClaimedKey for Tab and Mod+A, which are owned only inside
 *      ProseMirror content.
 *   2. Conditionally owned, with a designed fall-through — NOT claimed:
 *      Shift+Arrow, Mod+Shift+Arrow, Mod+Backspace, Shift+Tab each return
 *      false in the states where the platform's own behavior is what the
 *      user wants. VS Code's own defaults on these are editorTextFocus-
 *      scoped and inert while a webview has focus, so leaving them visible
 *      costs nothing.
 *   3. Conditionally owned but must not double-fire — stops propagation
 *      ITSELF at the point of consumption, where the condition is known:
 *      Escape (blockKeys' handleBlockKeydown) and the overlays' own Escape
 *      handlers.
 *
 * The per-chord decisions are recorded once, as data, in
 * `shared/__tests__/keymapChords.ts`. Both policy tests derive from that
 * table: keyboardShortcuts.test.ts drives this guard with a real event per
 * chord per platform, and noHardcodedKeybindings.test.ts uses it as the
 * source-scan allowlist — so a new keymap chord fails the scan until it is
 * classified, and a misclassification fails the guard test.
 *
 * ── Contributed-keybinding parity (MAR-144's deferred audit, 2026-07-29) ──
 *
 * Every hardcoded chord was re-checked against its raw-editor equivalent for
 * convertibility to a contributed (rebindable) keybinding. NONE can convert,
 * each for one of three structural reasons:
 *   (a) a native contenteditable default must be suppressed synchronously —
 *       the Alt/Option+Arrow class (move/duplicate block, smart select). A
 *       contributed command runs after the native caret move has landed;
 *       MAR-144's first attempt shipped a corrupted caret this way and was
 *       reverted (c535203);
 *   (b) the binding is conditional (class 2 above) and a contributed command
 *       cannot express "handle this only in state X" — it owns the chord
 *       always or never;
 *   (c) it must beat another synchronous in-webview keymap on the same
 *       keystroke (Mod+Enter vs the preset's exit-code-block binding).
 * The parity that IS available is an ADDITIONAL binding via a palette
 * command, and every hardcoded chord naming a discrete action already has
 * one: moveBlockUp/Down, duplicateBlockUp/Down, expandSelection /
 * shrinkSelection, insertParagraphAfter/Before, toggleBold / toggleItalic /
 * toggleInlineCode / toggleStrikethrough. The rest are continuous
 * typing/selection verbs a palette entry cannot sensibly express (Tab,
 * Shift+Tab, Mod+A, Shift+Arrow, Mod+Shift+Arrow, Mod+Backspace) or history
 * (Mod+Z/Y, already called out in the CHANGELOG). Closing the gap for real
 * needs the webview to read the user's keybinding configuration — a separate
 * feature, not a fix here.
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
export interface ClaimedShortcut {
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
    /** Alt must be pressed (unlisted modifiers must NOT be — exact match). */
    alt?: boolean;
    /**
     * Raw Ctrl pressed IN ADDITION to `mod` — macOS-only chords like
     * Ctrl+Shift+Cmd+Arrow (smart select). Meaningless off macOS, where
     * `mod` already is Ctrl; pair with `mac: true`.
     */
    ctrl?: boolean;
    /** Platform gate: true = macOS only, false = Windows/Linux only. */
    mac?: boolean;
    /**
     * Claimed only inside ProseMirror content (like the Tab and Mod+A
     * special cases): in overlay inputs (find bar, toolbars) the chord keeps
     * its native behavior and stays visible to the workbench.
     */
    content?: boolean;
}

/**
 * Combos handled inside the webview that must never reach the workbench.
 * Exported ONLY for the policy snapshot in keyboardShortcuts.test.ts: every
 * claimed chord is permanently un-rebindable for the user, so any change to
 * this list must be a deliberate, reviewed decision.
 */
export const CLAIMED_SHORTCUTS: readonly ClaimedShortcut[] = [
    // formatKeymap plugin (webview/plugins/formatKeymap.ts)
    { key: "b", mod: true },                // bold
    { key: "i", mod: true },                // italic
    { key: "e", mod: true },                // inline code
    { key: "x", mod: true, shift: true },   // strikethrough
    // history plugin (webview/plugins/history.ts)
    { key: "z", mod: true },                // undo
    { key: "z", mod: true, shift: true },   // redo
    { key: "y", mod: true },                // redo
    // Block/selection chords. All content-scoped: overlay inputs keep their
    // native caret/selection behavior. Each is owned outright inside content
    // (the claim rule in this file's header, class 1) — the sibling chords
    // that fall through in some state (Shift+Arrow, Mod+Shift+Arrow) are
    // deliberately absent from this list.
    // blockKeys plugin: move block up/down (Alt+Arrow).
    { key: "arrowup", alt: true, content: true },
    { key: "arrowdown", alt: true, content: true },
    // blockKeys plugin: duplicate block up/down
    { key: "arrowup", shift: true, alt: true, content: true },
    { key: "arrowdown", shift: true, alt: true, content: true },
    // smartSelect plugin: expand/shrink selection (platform-split chords;
    // on macOS Shift+Alt+Arrows stay native word-wise selection)
    { key: "arrowright", mod: true, ctrl: true, shift: true, mac: true, content: true },
    { key: "arrowleft", mod: true, ctrl: true, shift: true, mac: true, content: true },
    { key: "arrowright", shift: true, alt: true, mac: false, content: true },
    { key: "arrowleft", shift: true, alt: true, mac: false, content: true },
    // insertParagraph plugin: Mod-Enter / Mod-Shift-Enter
    { key: "enter", mod: true, content: true },
    { key: "enter", mod: true, shift: true, content: true },
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

    // Mod+A is the block-selection escalation ladder (blockKeys plugin:
    // block text → block → everything), claimed only inside ProseMirror
    // content: VS Code binds its own webview select-all to Cmd+A while a
    // webview has focus, and letting the chord leak fires an
    // execCommand('selectAll') that stomps the ladder with a full-document
    // selection right after PM sets ours. Overlay inputs keep the
    // workbench/native behavior. Inside content the key is always handled
    // (the ladder, a table's native select-all via baseKeymap, or
    // codeBlockSelectAll's capture handler), so nothing is lost.
    if (e.key.toLowerCase() === "a" && !e.shiftKey && !e.altKey) {
        const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
        return (
            primary &&
            e.target instanceof Element &&
            e.target.closest(".ProseMirror") !== null
        );
    }

    // The listed combos are claimed document-wide unless `content`-scoped:
    // the whole webview document is editor UI (content, topbar, TOC, find
    // bar, ...), and these combos must not trigger workbench actions no
    // matter which part has focus.
    const eventKey = e.key.toLowerCase();
    // prosemirror-keymap also resolves bindings via base[event.keyCode] when
    // the produced char is non-ASCII (non-Latin layouts: Russian Ctrl+Z has
    // key "я", keyCode 90 → PM handles Mod-z). The guard must claim those
    // too, or the chord leaks to the workbench and the action fires twice.
    const fallbackKey = fallbackKeyFromKeyCode(e);
    const inContent =
        e.target instanceof Element && e.target.closest(".ProseMirror") !== null;
    for (const s of CLAIMED_SHORTCUTS) {
        if (eventKey !== s.key && fallbackKey !== s.key) { continue; }
        if (s.mac !== undefined && s.mac !== isMac) { continue; }
        if (s.content && !inContent) { continue; }
        if (e.shiftKey !== !!s.shift) { continue; }
        if (e.altKey !== !!s.alt) { continue; }
        if (s.mod) {
            // Platform primary modifier (see ClaimedShortcut.mod), plus the
            // optional explicit Ctrl for macOS smart-select chords.
            const primary = isMac
                ? e.metaKey && e.ctrlKey === !!s.ctrl
                : e.ctrlKey && !e.metaKey;
            if (!primary) { continue; }
        } else if (e.metaKey || e.ctrlKey) {
            // Exact matching: an unlisted primary modifier disqualifies.
            continue;
        }
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
