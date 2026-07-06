/**
 * keyboardShortcuts.ts
 *
 * Registers and handles the editor's keyboard shortcuts:
 * - Cmd/Ctrl+F: open the find bar (pre-filled with the current selection)
 * - Cmd/Ctrl+Alt+F and Ctrl+H: open the find bar with the replace row shown
 * - Cmd+G / Cmd+Shift+G (macOS) and F3 / Shift+F3: find next/previous match
 * - Cmd/Ctrl+D: open find & replace pre-filled with the selection or the
 *   word around the caret, replace input focused
 * - Cmd/Ctrl+K: open the Insert/Edit Link prompt (same as the toolbar button)
 * - Cmd/Ctrl+Shift+M: switch to the text editor (with the current viewport line)
 */

import type { EditorView } from "@milkdown/prose/view";
import { notifySwitchToTextEditor } from "./messaging";
import type { FindBarController } from "./components/findBar";
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
//   the editor DOM) and after our own document-level shortcut handlers, so
//   everything that should handle the key has already seen it.
// - `document` is one node below `window`, so stopPropagation() here is the
//   last stop before the host's forwarder. (A capture-phase listener on
//   `window` would be wrong: stopPropagation() during capture at `window`
//   would keep the event from ever reaching ProseMirror. And a bubble-phase
//   listener on `window` is too late: the host's forwarder is registered
//   first on that node.)
// - The guard never calls preventDefault(): whether the key's default action
//   is suppressed stays the decision of ProseMirror / the shortcut handlers.

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
     * Physical key code (KeyboardEvent.code). Used instead of `key` only
     * for Alt combos: macOS Option remaps the produced character (Option+K
     * types "˚"), and our Alt handlers (EventManager.onShortcut) match
     * e.code for the same reason.
     */
    code?: string;
    /**
     * Platform primary modifier ("Mod"): Cmd (and not Ctrl) on macOS, Ctrl
     * (and not Cmd) elsewhere — the normalization prosemirror-keymap
     * applies to "Mod-" bindings. Our own onShortcut registrations below
     * are tightened to the platform primary modifier too, so the guard
     * claims exactly the combos some handler responds to (e.g. Ctrl+Z on
     * macOS is handled by nothing and stays visible to the workbench).
     */
    mod?: boolean;
    /** Require Ctrl specifically (used for the non-Mod Ctrl+H binding). */
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    /** Skip this entry on macOS (e.g. Ctrl+H is delete-backward there). */
    nonMacOnly?: boolean;
    /** Claim this entry only on macOS (e.g. Ctrl+G is go-to-line elsewhere). */
    macOnly?: boolean;
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
    // find bar (registered below)
    { key: "f", mod: true },                // find
    { code: "KeyF", mod: true, alt: true }, // find & replace (Alt combo)
    { key: "h", ctrl: true, nonMacOnly: true }, // replace (Win/Linux)
    { key: "g", mod: true, macOnly: true },              // find next (Ctrl+G is go-to-line elsewhere)
    { key: "g", mod: true, shift: true, macOnly: true }, // find previous
    { key: "f3" },                          // find next
    { key: "f3", shift: true },             // find previous
    { key: "d", mod: true },                // selection/word → find & replace
    // Insert/Edit Link prompt (registered below). Claimed document-wide so
    // the chord never starts a workbench Cmd+K key sequence while the
    // webview is focused; the handler itself skips overlay inputs.
    { key: "k", mod: true },
    // Switch to text editor (registered below). Safe to swallow even though
    // package.json contributes the same keybinding: while the webview is
    // focused our handler posts the switch message itself; when the webview
    // is NOT focused the key never enters it and the contributed keybinding
    // fires natively.
    { key: "m", mod: true, shift: true },
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
        if (s.nonMacOnly && isMac) { continue; }
        if (s.macOnly && !isMac) { continue; }
        if (s.key !== undefined) {
            if (eventKey !== s.key && fallbackKey !== s.key) { continue; }
        } else if (e.code !== s.code) {
            continue;
        }
        if (s.mod) {
            // Platform primary modifier only (see ClaimedShortcut.mod)
            const primary = isMac
                ? e.metaKey && !e.ctrlKey
                : e.ctrlKey && !e.metaKey;
            if (!primary) { continue; }
        } else if (e.metaKey || e.ctrlKey !== !!s.ctrl) {
            continue;
        }
        if (e.shiftKey !== !!s.shift) { continue; }
        if (e.altKey !== !!s.alt) { continue; }
        return true;
    }
    return false;
}

/**
 * Query for the Cmd/Ctrl+D find bridge: the selected text, or the word
 * around the caret when the selection is empty (mirroring how VS Code's
 * "add selection to next find match" seeds its query).
 */
export function selectionOrWordQuery(view: EditorView): string | undefined {
    const { selection } = view.state;
    if (!selection.empty) {
        const text = view.state.doc.textBetween(selection.from, selection.to);
        return text.trim() ? text : undefined;
    }
    const $pos = selection.$from;
    if (!$pos.parent.isTextblock) {
        return undefined;
    }
    // Leaf nodes (images, math) map to a placeholder so offsets stay aligned
    const text = $pos.parent.textBetween(0, $pos.parent.content.size, undefined, "￼");
    const off = $pos.parentOffset;
    const isWordChar = (ch: string | undefined) =>
        ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
    let start = off;
    let end = off;
    while (isWordChar(text[start - 1])) { start--; }
    while (isWordChar(text[end])) { end++; }
    return start < end ? text.slice(start, end) : undefined;
}

/** Initialize the editor's keyboard shortcuts and the key-leak guard. */
export function initKeyboardShortcuts(
    eventManager: EventManager,
    getEditorView: () => EditorView | null,
    getLineMap: () => number[],
    getFirstVisibleSourceLine: (view: EditorView, lineMap: number[]) => number,
    findBar: FindBarController,
    openLinkPrompt: () => void,
): void {
    const isMac = window.__i18n?.isMac ?? /Mac/.test(navigator.platform);

    // Key-leak guard: keep claimed combos from reaching the VS Code webview
    // host's window-level key forwarder (see the comment block above).
    eventManager.onDocument("keydown", (e) => {
        if (isEditorClaimedKey(e, isMac)) {
            // stopPropagation only — never preventDefault — so ProseMirror
            // and the shortcut handlers below keep full control of the key.
            e.stopPropagation();
        }
    });

    // Platform primary modifier for our own bindings: Cmd on macOS, Ctrl
    // elsewhere — the same "Mod-" normalization prosemirror-keymap applies.
    // Registered as a single exact modifier (not meta-or-ctrl) so the
    // claimed-key guard above and these handlers agree on what is handled.
    const mod: { meta?: boolean; ctrl?: boolean } =
        isMac ? { meta: true } : { ctrl: true };

    // Cmd/Ctrl+F: open the find bar (pre-fills from the selection itself).
    // Letter shortcuts match on the produced character (`key`) so non-QWERTY
    // layouts work; Alt combos match on `code` (see CLAIMED_SHORTCUTS).
    eventManager.onShortcut(
        { key: "f", ...mod, stopPropagation: true },
        () => findBar.open(),
    );

    // Cmd/Ctrl+Alt+F: open the find bar with the replace row shown
    eventManager.onShortcut(
        { code: "KeyF", ...mod, alt: true, stopPropagation: true },
        () => findBar.open(undefined, { showReplace: true }),
    );

    // Ctrl+H (Windows/Linux convention; on macOS Ctrl+H is delete-backward)
    if (!isMac) {
        eventManager.onShortcut(
            { key: "h", ctrl: true, stopPropagation: true },
            () => findBar.open(undefined, { showReplace: true }),
        );
    }

    // Cmd+G / Cmd+Shift+G (macOS only — Ctrl+G is go-to-line elsewhere) and
    // F3 / Shift+F3 (all platforms): find next/previous while the editor
    // keeps focus, reopening the bar with the last query when it is hidden.
    if (isMac) {
        eventManager.onShortcut(
            { key: "g", ...mod, stopPropagation: true },
            () => findBar.findNext(),
        );
        eventManager.onShortcut(
            { key: "g", ...mod, shift: true, stopPropagation: true },
            () => findBar.findPrev(),
        );
    }
    eventManager.onShortcut(
        { key: "f3", stopPropagation: true },
        () => findBar.findNext(),
    );
    eventManager.onShortcut(
        { key: "f3", shift: true, stopPropagation: true },
        () => findBar.findPrev(),
    );

    // Cmd/Ctrl+D: bridge to find & replace pre-filled with the selection (or
    // the word around the caret), replace input focused — the WYSIWYG
    // stand-in for VS Code's "add selection to next find match" flow.
    eventManager.onShortcut(
        // preventDefault is done in the handler, after the overlay-input
        // check, so overlay inputs keep the key's default action
        { key: "d", ...mod, stopPropagation: true, preventDefault: false },
        (e) => {
            // Ignore Cmd/Ctrl+D while typing in overlay inputs (find bar,
            // link popup, ...): the bridge reads the editor selection only.
            const target = e.target;
            if (
                target instanceof HTMLElement &&
                target.closest(".ProseMirror") === null &&
                (target instanceof HTMLInputElement ||
                    target instanceof HTMLTextAreaElement ||
                    target.isContentEditable)
            ) {
                return;
            }
            e.preventDefault();
            const view = getEditorView();
            const query = view ? selectionOrWordQuery(view) : undefined;
            findBar.open(query, { showReplace: true, focusReplace: true });
        },
    );

    // Cmd/Ctrl+K: open the Insert/Edit Link prompt — the exact prompt behind
    // the toolbar's link button, so selection handling (pre-filled text,
    // existing href, no-selection insert) matches the button 1:1.
    eventManager.onShortcut(
        // preventDefault is done in the handler, after the overlay-input
        // check below, so overlay inputs keep the key's default action
        { key: "k", ...mod, stopPropagation: true, preventDefault: false },
        (e) => {
            // Ignore Cmd/Ctrl+K while typing in overlay inputs (find bar,
            // link popup, language picker, ...): the prompt edits editor
            // content only. The ProseMirror root is itself contenteditable,
            // so editable targets inside it stay allowed.
            const target = e.target;
            if (
                target instanceof HTMLElement &&
                target.closest(".ProseMirror") === null &&
                (target instanceof HTMLInputElement ||
                    target instanceof HTMLTextAreaElement ||
                    target.isContentEditable)
            ) {
                return;
            }
            e.preventDefault();
            openLinkPrompt();
        },
    );

    // Cmd/Ctrl+Shift+M: switch to the text editor (with the first visible
    // source line so the text editor can restore the viewport position)
    eventManager.onShortcut(
        { key: "m", ...mod, shift: true, stopPropagation: true },
        () => {
            const view = getEditorView();
            const lineMap = getLineMap();
            const line = view ? getFirstVisibleSourceLine(view, lineMap) : undefined;
            notifySwitchToTextEditor(line);
        },
    );
}
