/**
 * keyboardShortcuts.ts
 *
 * Registers and handles the editor's keyboard shortcuts:
 * - Cmd/Ctrl+F: open the find bar (pre-filled with the current selection)
 * - Cmd/Ctrl+Alt+F and Ctrl+H: open the find bar with the replace row shown
 * - Cmd/Ctrl+Shift+M: switch to the text editor (with the current viewport line)
 * - Option/Alt+K: send the selection or current block to Claude (with exact line numbers)
 */

import type { EditorView } from "@milkdown/prose/view";
import { CellSelection } from "@milkdown/prose/tables";
import {
    notifySendToClaudeChat,
    notifySwitchToTextEditor,
} from "./messaging";
import {
    getBlockContainerText,
    findLineInOriginalSource,
    getCellRowSourceLine,
} from "./components/selectionToolbar";
import type { FindBarController } from "./components/findBar";
import type { EventManager } from "./eventManager";

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
    // Switch to text editor (registered below). Safe to swallow even though
    // package.json contributes the same keybinding: while the webview is
    // focused our handler posts the switch message itself; when the webview
    // is NOT focused the key never enters it and the contributed keybinding
    // fires natively.
    { key: "m", mod: true, shift: true },
    // Send to Claude (registered below; Alt combo)
    { code: "KeyK", alt: true },
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
    for (const s of CLAIMED_SHORTCUTS) {
        if (s.nonMacOnly && isMac) { continue; }
        if (s.key !== undefined) {
            if (eventKey !== s.key) { continue; }
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

/** Initialize the editor's keyboard shortcuts and the key-leak guard. */
export function initKeyboardShortcuts(
    eventManager: EventManager,
    getEditorView: () => EditorView | null,
    getLineMap: () => number[],
    getMarkdownSource: () => string,
    getFirstVisibleSourceLine: (view: EditorView, lineMap: number[]) => number,
    findBar: FindBarController,
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

    // Option/Alt+K: send the top-level block at the cursor to Claude.
    // With a text selection, send the selected text + exact line numbers;
    // without one, send the whole top-level block.
    eventManager.onShortcut(
        // preventDefault is done in the handler, after the overlay-input
        // check below, so typing in overlay inputs keeps its default action
        { code: "KeyK", alt: true, stopPropagation: true, preventDefault: false },
        (e) => {
            // Ignore Alt+K while typing in overlay inputs (find bar, link
            // popup, language picker, ...): only editor content can be sent
            // to Claude. The ProseMirror root is itself contenteditable, so
            // editable targets inside it stay allowed.
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
            if (!view) {
                return;
            }
            const lineMap = getLineMap();
            const markdownSource = getMarkdownSource();
            const { selection } = view.state;
            const $from = view.state.doc.resolve(selection.from);
            const topBlockIdx = $from.index(0);
            const topBlock = view.state.doc.child(topBlockIdx);
            const textBefore = view.state.doc.textBetween(0, $from.before(1), "\n");
            const fallbackStart = (textBefore.match(/\n/g) ?? []).length + 1;
            const blockStartLine = lineMap[topBlockIdx] ?? fallbackStart;

            if (!selection.empty) {
                // Text selection: send the selected text + exact line numbers
                const text = view.state.doc.textBetween(
                    selection.from,
                    selection.to,
                    "\n",
                );
                if (!text.trim()) {
                    return;
                }

                let startLine: number;
                let endLine: number;

                if (selection instanceof CellSelection) {
                    // Use $anchorCell.pos / $headCell.pos to stay inside the cells
                    const anchorLine = getCellRowSourceLine(
                        view.state.doc,
                        selection.$anchorCell.pos,
                        () => markdownSource,
                    );
                    const headLine = getCellRowSourceLine(
                        view.state.doc,
                        selection.$headCell.pos,
                        () => markdownSource,
                    );
                    if (anchorLine !== null && headLine !== null) {
                        startLine = Math.min(anchorLine, headLine);
                        endLine = Math.max(anchorLine, headLine);
                    } else {
                        startLine = anchorLine ?? headLine ?? blockStartLine;
                        endLine = startLine;
                    }
                } else {
                    // Plain text selection: prefer text search, fall back to lineMap + offset
                    const $fromPos = view.state.doc.resolve(selection.from);
                    const $toPos = view.state.doc.resolve(selection.to);
                    const startBlockText = getBlockContainerText($fromPos);
                    const endBlockText = getBlockContainerText($toPos);
                    startLine = findLineInOriginalSource(markdownSource, startBlockText);
                    endLine = findLineInOriginalSource(markdownSource, endBlockText);

                    if (startLine === -1) {
                        // Search the source for the first line of the selected text
                        const firstLine = text.trim().split("\n")[0].trim();
                        if (firstLine.length >= 2) {
                            const idx = markdownSource
                                .split("\n")
                                .findIndex((l) => l.includes(firstLine));
                            if (idx >= 0) {
                                startLine = idx + 1;
                            }
                        }
                    }
                    if (startLine === -1) {
                        const isFenced = topBlock.type.name === "code_block";
                        const blockContentStart = $from.before(1) + 1;
                        const textBeforeInBlock = view.state.doc.textBetween(
                            blockContentStart,
                            selection.from,
                            "\n",
                        );
                        const linesIntoBlock = (
                            textBeforeInBlock.match(/\n/g) ?? []
                        ).length;
                        startLine =
                            blockStartLine + (isFenced ? 1 : 0) + linesIntoBlock;
                    }
                    if (endLine === -1) {
                        endLine = startLine + (text.match(/\n/g) ?? []).length;
                    }
                }

                notifySendToClaudeChat(text, startLine, endLine);
            } else {
                // No selection: send the whole top-level block
                const text = topBlock.textContent;
                if (!text.trim()) {
                    return;
                }
                const endLine = blockStartLine + text.split("\n").length - 1;
                notifySendToClaudeChat(text, blockStartLine, endLine);
            }
        },
    );
}
