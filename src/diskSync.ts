/**
 * diskSync.ts
 *
 * Reconciles external disk writes (terminal tools, background sync, git) into
 * open documents, so an editor never sits on stale content and a manual save
 * never lands in VS Code's "file is newer on disk" dialog when the changes
 * don't actually collide.
 *
 * One controller instance serves every open document. Per tracked document it
 * keeps a file-system watcher and the MERGE BASE — the disk content at the
 * last point the TextDocument and the file agreed (resolve, save,
 * reload/revert). On a watcher event the decision table is:
 *
 * - disk == document        → nothing to merge; a dirty document is reverted
 *                             in place (same content, fresh disk stat).
 * - document clean          → force-revert to the disk content (backstop for
 *                             VS Code's own auto-reload of clean models).
 * - document dirty          → three-way merge (base / document / disk). A
 *                             clean merge is applied as revert-then-reapply:
 *                             the user's edits survive unsaved ON TOP of the
 *                             fresh disk state, so the next save writes
 *                             cleanly. A true conflict leaves the document
 *                             untouched and flags the conflict (toolbar badge
 *                             webview-side; VS Code's native save dialog
 *                             remains the final backstop).
 *
 * Reconciliation runs on the provider's per-document edit queue so it can
 * never interleave with a webview-originated WorkspaceEdit.
 *
 * Known limitations, accepted deliberately:
 * - Merged external changes participate in the model's undo stack (there is
 *   no extension API to edit outside it), so undo after a merge steps through
 *   the intermediate disk state.
 * - Disk reads assume UTF-8. A non-UTF-8 file mis-decodes into "everything
 *   differs", which degrades SAFELY: clean documents revert (VS Code decodes
 *   correctly), dirty ones conflict — never a corrupting merge.
 * - "Keep your version" writes UTF-8, preserving a leading UTF-8 BOM if the
 *   disk file has one. A non-UTF-8 file (UTF-16, …) is re-encoded to UTF-8 —
 *   its text is preserved, its byte encoding is not. Only that one explicit
 *   user action re-encodes; every other path leaves bytes untouched.
 * - A keystroke landing inside the sub-second merge window can be dropped: an
 *   in-flight webview update that a reconcile supersedes is rebased onto the
 *   merged text (stale-rejected by seq), so the character typed mid-merge is
 *   lost. Inherent to the optimistic-sync model; the merge itself never loses
 *   already-committed edits.
 * - One tracked entry per document URI: a second editor panel on the same file
 *   shares (and on close disarms) that entry — matching the provider's
 *   existing one-panel-per-URI assumption.
 */
import * as path from "path";
import * as vscode from "vscode";
import { computeReplaceRange } from "./utils/textEdit";
import { merge3 } from "./utils/merge3";

export interface DiskSyncHooks {
    /**
     * Serializes a task on the caller's per-document edit queue (the same
     * queue webview-originated edits run on).
     */
    enqueue(uriKey: string, task: () => Promise<void>): Promise<void>;
    /**
     * Fired on conflict-state TRANSITIONS only (never repeats a state), so
     * the caller can relay it to the webview's toolbar badge.
     */
    onConflictChange(uriKey: string, conflicted: boolean): void;
}

export class DiskSyncController {
    // Disk content at the last model↔disk sync point (the three-way base).
    private readonly _baseText = new Map<string, string>();

    // Documents whose unsaved edits conflict with a newer file on disk.
    private readonly _conflicted = new Set<string>();

    // Documents currently tracked; reconciles for untracked keys are stale
    // queue entries from a closed editor and must no-op.
    private readonly _tracked = new Set<string>();

    constructor(private readonly _hooks: DiskSyncHooks) {}

    /** Whether the document's unsaved edits currently conflict with the disk. */
    isConflicted(uriKey: string): boolean {
        return this._conflicted.has(uriKey);
    }

    /**
     * Starts tracking a document: seeds the merge base, watches its file for
     * external writes, and follows its saves. Dispose the returned handle
     * when the editor closes.
     */
    track(document: vscode.TextDocument, uriKey: string): { dispose(): void } {
        this._tracked.add(uriKey);

        // Seed the merge base. A clean document mirrors the disk; a dirty one
        // (hot-exit restore) diverged from it, so the disk itself is the base.
        // The dirty seed goes through the edit queue AHEAD of any reconcile:
        // a watcher event racing an unseeded base would fall back to treating
        // the restored edits as already-on-disk and could revert them away.
        if (!document.isDirty) {
            this._baseText.set(uriKey, document.getText());
        } else {
            void this._hooks.enqueue(uriKey, async () => {
                if (this._baseText.has(uriKey)) { return; } // save/reload beat us
                try {
                    this._baseText.set(uriKey, await this._readDiskText(document.uri));
                } catch {
                    this._baseText.set(uriKey, document.getText());
                }
            });
        }

        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(
                vscode.Uri.joinPath(document.uri, ".."),
                path.basename(document.uri.fsPath),
            ),
        );
        // Coalesce write bursts (external tools often write a file several
        // times in quick succession) into one reconciliation.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const schedule = (): void => {
            if (timer !== undefined) { clearTimeout(timer); }
            timer = setTimeout(() => {
                timer = undefined;
                void this._hooks.enqueue(uriKey, () => this._reconcile(document, uriKey));
            }, 150);
        };
        const subscriptions = [
            watcher.onDidChange(schedule),
            // Some tools replace files by unlink + create; onDidChange alone
            // would miss the new content.
            watcher.onDidCreate(schedule),
            vscode.workspace.onDidSaveTextDocument((saved) => {
                if (saved.uri.toString() !== uriKey) { return; }
                // The model was just written to disk: it IS the new base, and
                // by definition no longer conflicts with the file.
                this._baseText.set(uriKey, saved.getText());
                this._setConflict(uriKey, false);
            }),
        ];
        return {
            dispose: () => {
                if (timer !== undefined) { clearTimeout(timer); }
                for (const sub of subscriptions) { sub.dispose(); }
                watcher.dispose();
                this._tracked.delete(uriKey);
                this._baseText.delete(uriKey);
                this._conflicted.delete(uriKey);
            },
        };
    }

    /**
     * Feed of the provider's onDidChangeTextDocument events. A CLEAN document
     * after a content change means the model was synced with the disk
     * (auto-reload, revert, undo back to the save point): re-anchor the merge
     * base there and clear any conflict — a model that matches the disk
     * cannot be in conflict with it.
     */
    noteDocumentChanged(document: vscode.TextDocument, uriKey: string): void {
        if (!this._tracked.has(uriKey) || document.isDirty) { return; }
        this._baseText.set(uriKey, document.getText());
        this._setConflict(uriKey, false);
    }

    /**
     * The toolbar badge's click action: a native QuickPick offering the three
     * ways out of a disk conflict. Escape keeps the conflict state (and the
     * badge) as-is.
     */
    async resolveConflictInteractively(
        document: vscode.TextDocument,
        uriKey: string,
    ): Promise<void> {
        type ResolveItem = vscode.QuickPickItem & { action: "compare" | "keepMine" | "takeDisk" };
        const items: ResolveItem[] = [
            {
                label: vscode.l10n.t("Compare with the file on disk"),
                description: vscode.l10n.t("See both versions side by side"),
                action: "compare",
            },
            {
                label: vscode.l10n.t("Keep your version"),
                description: vscode.l10n.t("Overwrite the file on disk with this editor's content"),
                action: "keepMine",
            },
            {
                label: vscode.l10n.t("Reload from disk"),
                description: vscode.l10n.t("Discard your unsaved changes and load the file as it is on disk"),
                action: "takeDisk",
            },
        ];
        // The pick itself waits OFF the edit queue — blocking the queue for
        // the lifetime of a modal would freeze this document's disk sync.
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: vscode.l10n.t(
                "The file changed on disk in a way that overlaps your unsaved edits",
            ),
        });
        if (!picked || !this._tracked.has(uriKey)) { return; }

        if (picked.action === "compare") {
            // Read-only: the built-in dirty-model-vs-disk diff. Touches no
            // state, so it needn't serialize; the conflict stays flagged until
            // the user picks a side or saves.
            await vscode.commands.executeCommand(
                "workbench.files.action.compareWithSaved",
                document.uri,
            );
            return;
        }

        // The mutating branches run ON the edit queue so they can never
        // interleave with a watcher reconcile (an external tool can write the
        // file while the picker is open — the whole scenario this feature is
        // about). Content is re-read inside the task, after the queue drains.
        await this._hooks.enqueue(uriKey, async () => {
            if (!this._tracked.has(uriKey)) { return; }
            if (picked.action === "keepMine") {
                // Overwrite disk with the editor's content — the one place this
                // module writes bytes. (VS Code's own save would honor the
                // file's encoding, but a forced save can't skip the conflict
                // dialog from an extension.) document.getText() is decoded
                // UTF-8 without a BOM, so re-attach a leading UTF-8 BOM when the
                // file on disk currently has one, preserving that byte for the
                // common UTF-8-with-BOM (Windows) case. Non-UTF-8 encodings
                // (UTF-16, …) can't be reconstructed from the decoded string
                // here and still round-trip to UTF-8 — see Known limitations.
                const ours = document.getText();
                const oursUtf8 = Buffer.from(ours, "utf8");
                const bytes = (await this._diskHasUtf8Bom(document.uri))
                    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), oursUtf8])
                    : oursUtf8;
                await vscode.workspace.fs.writeFile(document.uri, bytes);
                // Reload so the model is clean on the freshly written content.
                await this._revertToDisk(document.uri);
                this._baseText.set(uriKey, ours);
                this._setConflict(uriKey, false);
            } else {
                // takeDisk
                await this._revertToDisk(document.uri);
                this._baseText.set(uriKey, document.getText());
                this._setConflict(uriKey, false);
            }
        });
    }

    /**
     * Reconciles the document with the file on disk after a watcher event.
     * Runs on the per-document edit queue; see the module doc for the
     * decision table.
     */
    private async _reconcile(document: vscode.TextDocument, uriKey: string): Promise<void> {
        if (!this._tracked.has(uriKey)) { return; } // editor closed while queued
        let theirs: string;
        try {
            theirs = await this._readDiskText(document.uri);
        } catch {
            // Deleted or unreadable: VS Code's own orphaned-file handling owns this.
            return;
        }
        const ours = document.getText();
        const base = this._baseText.get(uriKey) ?? ours;

        if (theirs === ours) {
            // Model already matches the disk (our own save's watcher echo,
            // VS Code's auto-reload, or an external write that converged with
            // the user's edits). A dirty model still needs a revert: same
            // content, but it refreshes the disk stat and clears the dirty
            // flag, so the next save can't hit the conflict dialog.
            if (document.isDirty) { await this._revertToDisk(document.uri); }
            this._baseText.set(uriKey, theirs);
            this._setConflict(uriKey, false);
            return;
        }

        if (!document.isDirty) {
            // Clean but stale — VS Code's auto-reload usually beats us here;
            // revert explicitly so the editor never sits on stale content.
            // The revert's change event pushes the new text to the webview
            // and re-anchors the merge base (via noteDocumentChanged).
            await this._revertToDisk(document.uri);
            this._setConflict(uriKey, false);
            return;
        }

        // Dirty and diverged. Note there is deliberately NO early-out for
        // theirs === base (an mtime-only touch, or a rewrite of identical
        // bytes): the model's disk stat is stale all the same, and only the
        // revert-then-reapply below refreshes it — skipping would leave the
        // next save to hit the conflict dialog over a no-op disk event. The
        // merge fast-paths that case to merged === ours.
        const merge = merge3(base, ours, theirs);
        if (!merge.ok) {
            // The user's unsaved edits and the disk changed the same lines
            // differently. Leave the document untouched (nothing is lost, and
            // a manual save still lands in VS Code's native conflict dialog)
            // and light the toolbar badge so the state is visible before that.
            this._setConflict(uriKey, true);
            return;
        }

        // Clean merge: reload the disk content (fresh stat, clears dirty),
        // then reapply the merged text as an edit — the document ends up
        // dirty with the user's edits preserved ON TOP of the disk state, so
        // a subsequent save writes cleanly instead of raising the dialog.
        await this._revertToDisk(document.uri);
        const fresh = document.getText();
        let merged = merge.merged;
        if (fresh !== theirs) {
            // The disk moved again between the read and the revert. Re-merge
            // against what the revert actually loaded.
            const retry = merge3(base, ours, fresh);
            if (!retry.ok) {
                // Now conflicting — restore the user's content (the revert
                // replaced it) and flag the conflict.
                await this._applyContentEdit(document, ours);
                this._baseText.set(uriKey, fresh);
                this._setConflict(uriKey, true);
                return;
            }
            merged = retry.merged;
        }
        if (merged !== fresh) {
            await this._applyContentEdit(document, merged);
        }
        this._baseText.set(uriKey, fresh);
        this._setConflict(uriKey, false);
    }

    /** The file's current content, decoded as UTF-8 with any BOM stripped (matching TextDocument.getText). */
    private async _readDiskText(uri: vscode.Uri): Promise<string> {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString("utf8");
        return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    }

    /** True if the file on disk currently begins with a UTF-8 BOM (EF BB BF). */
    private async _diskHasUtf8Bom(uri: vscode.Uri): Promise<boolean> {
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
        } catch {
            return false;
        }
    }

    /**
     * Force-reverts the document to the disk content (also refreshing the
     * model's disk stat, which is what arms/disarms the native save-conflict
     * dialog). Failures are non-fatal: the next watcher event retries.
     */
    private async _revertToDisk(uri: vscode.Uri): Promise<void> {
        try {
            await vscode.commands.executeCommand("workbench.action.files.revert", uri);
        } catch {
            // Revert can fail transiently (e.g. the file vanished mid-flight).
        }
    }

    /**
     * Applies merged content to the document as a minimal range replacement.
     * Deliberately does NOT touch the caller's webview-echo baseline: the
     * webview does not have this text yet, so the change event must flow to
     * it as an external update.
     */
    private async _applyContentEdit(
        document: vscode.TextDocument,
        newContent: string,
    ): Promise<void> {
        const replace = computeReplaceRange(document.getText(), newContent);
        if (!replace) { return; }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(
                document.positionAt(replace.startOffset),
                document.positionAt(replace.endOffset),
            ),
            replace.replacement,
        );
        await vscode.workspace.applyEdit(edit);
    }

    /** Records the conflict state, notifying the hook only on transitions. */
    private _setConflict(uriKey: string, conflicted: boolean): void {
        if (this._conflicted.has(uriKey) === conflicted) { return; }
        if (conflicted) {
            this._conflicted.add(uriKey);
        } else {
            this._conflicted.delete(uriKey);
        }
        this._hooks.onConflictChange(uriKey, conflicted);
    }
}
