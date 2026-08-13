/**
 * phantomDirty.ts
 *
 * Clear the unsaved-changes state of a document whose buffer has come back to
 * the bytes already on disk.
 *
 * VS Code decides "this file has unsaved changes" from the text model's
 * alternative version id, not from its contents. The flag clears when an UNDO
 * walks the model back to the version that was last written, and never merely
 * because some later edit happens to restore those bytes. A raw text editor
 * produces the first shape; a custom text editor whose undo lives in its
 * webview produces the second. A Cmd+Z in the editor reaches the TextDocument
 * as a NEW WorkspaceEdit that puts the old text back, so the document is
 * byte-identical to the file and still wears the dot, with nothing to save
 * (MAR-364).
 *
 * `workbench.action.files.revert` is the only handle the extension API offers
 * on that flag: it marks the model saved and re-reads the file. The re-read is
 * what makes it safe HERE and nowhere else — the precondition is that the
 * buffer already equals the file, so the read replaces nothing, writes nothing,
 * and runs no save participant. It is a way of saying "this document has no
 * unsaved changes" to a platform that has no other way to hear it.
 *
 * The precondition is established by a read the revert does not repeat, so an
 * external write landing between the two is a window nothing here can close.
 * It degrades to taking disk, which is what an external write asks for; what
 * it costs is the drift badge (MAR-152), which never appears for that one.
 *
 * TARGETING is the whole risk, and it is the reason for the gate stack below.
 * The command reverts the ACTIVE editor and ignores its URI argument (MAR-138:
 * an earlier auto-revert design was a data-loss vector for exactly this
 * reason), so a settle that fires while some OTHER editor is active reverts
 * that one instead. Two independent conditions answer it, and both must hold:
 *
 *   - OUR TAB IS THE ACTIVE ONE, so the command lands on this document.
 *   - NO OTHER TAB HOLDS UNSAVED WORK, so a mis-target is inert. The extension
 *     host learns about focus one IPC hop behind the workbench, which is a
 *     window this code cannot close by checking more carefully; what it can do
 *     is refuse whenever the answer would matter. Reverting a clean editor
 *     re-reads a file that already matches it.
 *
 * Every gate is re-read after the disk await, since focus and dirtiness both
 * move underneath it. Refusing costs the user a dot that stays lit until their
 * next save, which is the behavior they have today; taking it wrongly costs
 * them work. So "ours" is read narrowly: a dirty tab counts as foreign unless
 * its unsaved bytes ARE this TextDocument's, which naming the same file does
 * not establish.
 */
import * as vscode from "vscode";

import { readDiskText } from "./utils/diskText";

/**
 * Clear the document's dirty state IF its buffer matches the file on disk and
 * the revert can only reach this document. Returns whether it did.
 *
 * Callers should reach here only when the document plausibly just returned to
 * its saved bytes: the disk read is cheap but not free, and a save-point
 * comparison the caller already holds keeps it off every keystroke burst.
 */
export async function settlePhantomDirty(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    uriKey: string,
    viewType: string,
): Promise<boolean> {
    const settleable = (): boolean =>
        document.isDirty &&
        !document.isUntitled &&
        !document.isClosed &&
        panel.active &&
        activeTabIs(uriKey, viewType) &&
        noForeignUnsavedWork(uriKey, viewType);

    if (!settleable()) { return false; }

    let diskText: string;
    try {
        diskText = await readDiskText(document.uri);
    } catch {
        // Deleted or unreadable: there is no saved state to be clean against.
        return false;
    }
    if (diskText !== document.getText()) { return false; }
    // Re-read every gate: the await let focus, the tab set, and the document's
    // own dirty state move.
    if (!settleable()) { return false; }

    await vscode.commands.executeCommand("workbench.action.files.revert");
    return true;
}

/** Whether the focused tab is this document's own editor of `viewType`. */
function activeTabIs(uriKey: string, viewType: string): boolean {
    const input = vscode.window.tabGroups?.activeTabGroup?.activeTab?.input;
    return (
        input instanceof vscode.TabInputCustom &&
        input.viewType === viewType &&
        input.uri.toString() === uriKey
    );
}

/** Whether every tab holding unsaved changes is backed by THIS TextDocument. */
function noForeignUnsavedWork(uriKey: string, viewType: string): boolean {
    for (const group of vscode.window.tabGroups?.all ?? []) {
        for (const tab of group.tabs) {
            if (tab.isDirty && !isOurTextDocument(tab, uriKey, viewType)) { return false; }
        }
    }
    return true;
}

/**
 * Whether a tab's unsaved work IS this document's, so that reverting the
 * document loses nothing the tab was holding.
 *
 * Naming the same file is not enough, and this is the distinction the gate
 * turns on. A custom editor keeps its own dirty state, unrelated to the
 * TextDocument: `Open With > Hex Editor` on the same `.md` gives a tab whose
 * uri matches ours and whose unsaved bytes a revert would discard. So a custom
 * tab must also be OUR viewType, which is the only one whose dirty state is
 * this document's. A plain text editor over the uri is backed by the same
 * TextDocument and is safe.
 *
 * Everything else counts as foreign, including a diff and a notebook: a
 * notebook's uri can match a text file it was opened from, and a diff's dirty
 * side is a different model. The question here is never "which file" but
 * "whose unsaved bytes", and the safe direction is to refuse.
 */
function isOurTextDocument(tab: vscode.Tab, uriKey: string, viewType: string): boolean {
    const input = tab.input;
    if (input instanceof vscode.TabInputCustom) {
        return input.viewType === viewType && input.uri.toString() === uriKey;
    }
    if (input instanceof vscode.TabInputText) {
        return input.uri.toString() === uriKey;
    }
    return false;
}
