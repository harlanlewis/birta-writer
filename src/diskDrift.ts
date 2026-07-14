/**
 * diskDrift.ts
 *
 * Notify-only detection of external disk edits. When the file backing an open
 * document changes on disk while the editor has UNSAVED edits, the editor and
 * the file have drifted apart — this controller raises an advisory badge in the
 * webview toolbar and lets the USER choose what to do (reload from disk, compare,
 * or ignore and save). It NEVER edits, reverts, or writes the document itself.
 *
 * This is deliberately much smaller than an auto-merge: on the highest-stakes
 * surface (round-trip trust) the safest code is code that doesn't mutate the
 * user's bytes. It also stops reinventing the platform —
 *
 * - CLEAN documents need nothing: VS Code's own watcher auto-reloads a clean
 *   `TextDocument` when its file changes, and the provider's existing inbound
 *   sync pushes that to the webview. So drift is only ever flagged for a DIRTY
 *   document, where the webview otherwise gives no sign the disk moved (a custom
 *   editor doesn't surface VS Code's native "newer on disk" chrome).
 * - Keeping your edits is just a normal save — VS Code's native "file is newer
 *   on disk" dialog remains the final backstop; the badge is the early warning.
 *
 * Why user-initiated reload is safe: `workbench.action.files.revert` reverts the
 * ACTIVE editor (it ignores a URI argument — the reason the old auto-revert
 * design was a data-loss vector, MAR-138). The badge lives in the focused
 * document's own toolbar, so a click reverts exactly that document. The
 * controller never reverts a background document.
 */
import * as path from "path";
import * as vscode from "vscode";

export interface DiskDriftHooks {
    /**
     * Fired on drift-state TRANSITIONS only (never repeats a state), so the
     * caller can post a single webview message per change.
     */
    onDriftChange(uriKey: string, drifted: boolean): void;
}

/** Coalesce write bursts (external tools often rewrite a file several times). */
const WATCH_DEBOUNCE_MS = 120;

export class DiskDriftController {
    /** Documents whose unsaved edits have drifted from a newer file on disk. */
    private readonly _drifted = new Set<string>();
    private readonly _tracked = new Set<string>();

    constructor(private readonly _hooks: DiskDriftHooks) {}

    /** True while the document's unsaved edits differ from the file on disk. */
    isDrifted(uriKey: string): boolean {
        return this._drifted.has(uriKey);
    }

    /**
     * Watch a document's file for external writes. Returns a disposable to call
     * when the panel closes.
     */
    track(document: vscode.TextDocument, uriKey: string): { dispose(): void } {
        this._tracked.add(uriKey);

        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(
                vscode.Uri.joinPath(document.uri, ".."),
                path.basename(document.uri.fsPath),
            ),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const schedule = (): void => {
            if (timer !== undefined) { clearTimeout(timer); }
            timer = setTimeout(() => {
                timer = undefined;
                void this._evaluate(document, uriKey);
            }, WATCH_DEBOUNCE_MS);
        };

        const subscriptions = [
            watcher.onDidChange(schedule),
            // Some tools replace files by unlink + create; onDidChange alone
            // would miss the new content.
            watcher.onDidCreate(schedule),
            // A save writes the editor's content to disk, so the two now agree —
            // clear any drift immediately (don't wait for the watcher echo).
            vscode.workspace.onDidSaveTextDocument((saved) => {
                if (saved.uri.toString() === uriKey) { this._setDrift(uriKey, false); }
            }),
            // A document that becomes CLEAN (reload/revert, or undo back to the
            // save point) now matches disk by definition — clear drift. A dirty
            // change leaves drift as-is (the disk edits are still unreconciled).
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === uriKey && !e.document.isDirty) {
                    this._setDrift(uriKey, false);
                }
            }),
        ];

        return {
            dispose: () => {
                if (timer !== undefined) { clearTimeout(timer); }
                for (const sub of subscriptions) { sub.dispose(); }
                watcher.dispose();
                this._tracked.delete(uriKey);
                this._setDrift(uriKey, false);
            },
        };
    }

    /**
     * The badge's click action: a native picker offering the two safe,
     * user-driven ways out of a drift. Escape keeps the badge as-is (equivalent
     * to "keep my edits" — a manual save then goes through VS Code's own dialog).
     */
    async resolveDriftInteractively(document: vscode.TextDocument): Promise<void> {
        type Item = vscode.QuickPickItem & { action: "reload" | "compare" };
        const items: Item[] = [
            {
                label: vscode.l10n.t("Reload from disk"),
                description: vscode.l10n.t("Discard your unsaved changes and load the file as it is on disk"),
                action: "reload",
            },
            {
                label: vscode.l10n.t("Compare with the file on disk"),
                description: vscode.l10n.t("See your unsaved version and the file on disk side by side"),
                action: "compare",
            },
        ];
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: vscode.l10n.t("This file changed on disk since your last edit"),
        });
        if (!picked) { return; }

        if (picked.action === "reload") {
            // Reverts the ACTIVE editor — which is the document whose badge was
            // clicked (its custom editor is focused). Never targets a background
            // document, so this can't discard the wrong editor's edits.
            await vscode.commands.executeCommand("workbench.action.files.revert", document.uri);
        } else {
            await vscode.commands.executeCommand(
                "workbench.files.action.compareWithSaved",
                document.uri,
            );
        }
    }

    /**
     * Re-evaluate drift for a document after a disk write: dirty + disk differs
     * from the editor's content → drifted. Clean, converged, or unreadable →
     * not drifted. Read-only; never mutates the document.
     */
    private async _evaluate(document: vscode.TextDocument, uriKey: string): Promise<void> {
        if (!this._tracked.has(uriKey)) { return; } // panel closed while queued
        // A clean document is reloaded by VS Code itself; it is never "drifted".
        if (!document.isDirty) { this._setDrift(uriKey, false); return; }

        let diskText: string;
        try {
            diskText = await this._readDiskText(document.uri);
        } catch {
            // Deleted or unreadable: VS Code's own orphaned-file handling owns
            // this; nothing for the badge to say.
            this._setDrift(uriKey, false);
            return;
        }
        if (!this._tracked.has(uriKey)) { return; } // closed during the async read
        this._setDrift(uriKey, diskText !== document.getText());
    }

    /** Set drift state, firing the hook only on a transition. */
    private _setDrift(uriKey: string, drifted: boolean): void {
        const was = this._drifted.has(uriKey);
        if (was === drifted) { return; }
        if (drifted) { this._drifted.add(uriKey); } else { this._drifted.delete(uriKey); }
        this._hooks.onDriftChange(uriKey, drifted);
    }

    /** The file's content, decoded as UTF-8 with any BOM stripped (matching TextDocument.getText). */
    private async _readDiskText(uri: vscode.Uri): Promise<string> {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString("utf8");
        return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    }
}
