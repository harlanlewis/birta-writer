/**
 * externalChanges.ts — the extension's external-change seam (MAR-152).
 *
 * ## ADR: two mechanisms, deliberately separate
 *
 * The extension reacts to "something changed outside the webview" through two
 * pipelines that LOOK similar (both debounce a change signal) but answer
 * different questions from different — and mutually blind — signal sources:
 *
 * **A. Document changed under the webview (this module).**
 *    Signal: `workspace.onDidChangeTextDocument`. Question: "does the webview
 *    need to re-base on new TextDocument content?" Covers side-by-side text
 *    edits, undo/redo, git checkout, hot-exit restore, and disk changes VS
 *    Code auto-applies to a CLEAN document. Consumer: the provider's
 *    `externalUpdate` push (cursor-preserving minimal diff in the webview).
 *    The debounce (EXTERNAL_CHANGE_DEBOUNCE_MS) coalesces keystroke bursts;
 *    the sync-version bump happens SYNCHRONOUSLY at observe time so an
 *    in-flight webview update inside the debounce window is already stale.
 *
 * **B. Disk drifted from a dirty document (src/diskDrift.ts).**
 *    Signal: a per-document `FileSystemWatcher` (+ save/clean events).
 *    Question: "did the file on disk diverge while the editor holds unsaved
 *    edits?" Consumer: a notify-only advisory badge; never edits the document.
 *    Its debounce (DISK_DRIFT_DEBOUNCE_MS) coalesces external tools' multi-
 *    write bursts.
 *
 * They are NOT unified into one pipeline because neither signal can serve the
 * other's question: VS Code does not apply a disk write to a DIRTY document,
 * so mechanism A's document events never fire for exactly the case B exists
 * for; and B's disk events say nothing about in-memory changes (undo, side-
 * by-side edits) that A must relay. Driving B's evaluation from A's listener
 * would leave B blind to its primary trigger, and merging the watchers would
 * re-couple a notify-only advisory to the content-sync path (the coupling
 * MAR-138 removed for being a data-loss vector). The division of labor is:
 * one signal source per question, both debounce constants declared here so
 * the timing story reads in one place. Timing is pinned by
 * markdownEditorProvider.textSync.test.ts (200ms) and the diskDrift tests
 * (120ms).
 */
import * as vscode from "vscode";

/** Mechanism A: coalesce TextDocument change bursts (e.g. side-by-side typing). */
export const EXTERNAL_CHANGE_DEBOUNCE_MS = 200;

/** Mechanism B: coalesce disk write bursts (external tools often rewrite a file several times). */
export const DISK_DRIFT_DEBOUNCE_MS = 120;

export interface ExternalChangeHooks {
    /** True when `text` is the echo of our own webview-originated applyEdit. */
    isEcho(text: string): boolean;
    /**
     * Called SYNCHRONOUSLY for every observed genuine external change, before
     * the debounce — the provider bumps the sync version here so a racing
     * webview update is rejected as stale inside the debounce window.
     */
    onChangeObserved(): void;
    /**
     * Called once the debounce settles. The provider re-checks the echo
     * baseline (the document may have settled back) and pushes externalUpdate.
     */
    onChangeSettled(): void;
}

/**
 * Mechanism A's listener: watch the TextDocument behind `uriKey` for genuine
 * external changes and drive the hooks. Returns a disposable that clears the
 * pending debounce and unsubscribes (call on panel dispose).
 */
export function watchExternalDocumentChanges(
    document: vscode.TextDocument,
    uriKey: string,
    hooks: ExternalChangeHooks,
): vscode.Disposable {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const subscription = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== uriKey) { return; }
        if (e.contentChanges.length === 0) { return; }
        // Echo of a webview-originated applyEdit: the webview already has this text.
        if (hooks.isEcho(e.document.getText())) { return; }
        hooks.onChangeObserved();
        if (timer !== undefined) { clearTimeout(timer); }
        timer = setTimeout(() => {
            timer = undefined;
            hooks.onChangeSettled();
        }, EXTERNAL_CHANGE_DEBOUNCE_MS);
    });
    return {
        dispose: () => {
            if (timer !== undefined) { clearTimeout(timer); }
            timer = undefined;
            subscription.dispose();
        },
    };
}
