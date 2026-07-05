/**
 * keyboardShortcuts.ts
 *
 * Registers and handles the editor's keyboard shortcuts:
 * - Cmd/Ctrl+F: open the find bar (pre-filled with the current selection)
 * - Cmd/Ctrl+Alt+F and Ctrl+H: open the find bar with the replace row shown
 * - Cmd/Ctrl+Shift+M: switch to the text editor (with the current viewport line)
 */

import type { EditorView } from "@milkdown/prose/view";
import { notifySwitchToTextEditor } from "./messaging";
import type { FindBarController } from "./components/findBar";
import type { EventManager } from "./eventManager";

/** Initialize the keyboard shortcuts */
export function initKeyboardShortcuts(
    eventManager: EventManager,
    getEditorView: () => EditorView | null,
    getLineMap: () => number[],
    getFirstVisibleSourceLine: (view: EditorView, lineMap: number[]) => number,
    findBar: FindBarController,
): void {
    // Cmd/Ctrl+F: open the find bar (pre-fills from the selection itself)
    eventManager.onShortcut(
        { code: "KeyF", meta: true, ctrl: true, stopPropagation: true },
        () => findBar.open(),
    );

    // Cmd/Ctrl+Alt+F: open the find bar with the replace row shown
    eventManager.onShortcut(
        { code: "KeyF", meta: true, ctrl: true, alt: true, stopPropagation: true },
        () => findBar.open(undefined, { showReplace: true }),
    );

    // Ctrl+H (Windows/Linux convention; on macOS Ctrl+H is delete-backward)
    const isMac = window.__i18n?.isMac ?? /Mac/.test(navigator.platform);
    if (!isMac) {
        eventManager.onShortcut(
            { code: "KeyH", ctrl: true, stopPropagation: true },
            () => findBar.open(undefined, { showReplace: true }),
        );
    }

    // Cmd/Ctrl+Shift+M：切换到文本编辑器（附带当前视口顶部行号，供文本编辑器定位）
    eventManager.onShortcut(
        { code: "KeyM", meta: true, ctrl: true, shift: true },
        () => {
            const view = getEditorView();
            const lineMap = getLineMap();
            const line = view ? getFirstVisibleSourceLine(view, lineMap) : undefined;
            notifySwitchToTextEditor(line);
        },
    );
}
