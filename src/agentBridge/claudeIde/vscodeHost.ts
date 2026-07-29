/**
 * src/agentBridge/claudeIde/vscodeHost.ts
 *
 * The `vscode`-bound implementation of `IdeHost` — the only file in the IDE
 * endpoint that touches the editor APIs. Selection answers come from the same
 * neutral `ActiveContextResolver` every other bridge adapter reads; the rest
 * are thin projections of stable VS Code surfaces (tabGroups, textDocuments,
 * languages.getDiagnostics).
 */

import * as vscode from "vscode";
import type { ActiveContextResolver } from "../api";
import { toBirtaSelection } from "../format";
import {
    resolveTextSelection,
    type IdeHost,
    type IdeSelectionPayload,
    type IdeTabPayload,
    type OpenFileArgs,
} from "./tools";

/**
 * Restore a (1-indexed) caret/selection in a Birta panel for `fsPath`, now or
 * when it opens: `line`/`column` are the active end, `anchor` the other end.
 */
export type RevealInBirta = (
    fsPath: string,
    line: number,
    column?: number,
    anchor?: { line: number; column?: number },
) => void;

const SEVERITY_NAMES = ["Error", "Warning", "Information", "Hint"] as const;

function documentFor(filePath: string): vscode.TextDocument | undefined {
    const fsPath = vscode.Uri.file(filePath).fsPath;
    return vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === fsPath);
}

export function createVsCodeIdeHost(
    getActive: ActiveContextResolver,
    revealInBirta: RevealInBirta,
): IdeHost {
    return {
        async getSelection(): Promise<IdeSelectionPayload | null> {
            const active = await getActive();
            if (!active) { return null; }
            const { context, uri } = active;
            const sel = context.selections[context.primary] ?? context.selections[0];
            return {
                text: sel?.text ?? "",
                filePath: uri.fsPath,
                fileUrl: uri.toString(),
                selection: { ...toBirtaSelection(context), isEmpty: context.isEmpty },
            };
        },

        listOpenEditors(): IdeTabPayload[] {
            const tabs: IdeTabPayload[] = [];
            vscode.window.tabGroups.all.forEach((group, groupIndex) => {
                for (const tab of group.tabs) {
                    const input = tab.input;
                    const uri =
                        input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom
                            ? input.uri
                            : undefined;
                    if (!uri) { continue; }
                    const doc = documentFor(uri.fsPath);
                    tabs.push({
                        uri: uri.toString(),
                        isActive: tab.isActive,
                        isPinned: tab.isPinned,
                        isPreview: tab.isPreview,
                        isDirty: tab.isDirty,
                        label: tab.label,
                        groupIndex,
                        viewColumn: group.viewColumn,
                        isGroupActive: group.isActive,
                        fileName: uri.fsPath,
                        languageId: doc?.languageId ?? "",
                        ...(doc ? { lineCount: doc.lineCount } : {}),
                        isUntitled: doc?.isUntitled ?? false,
                    });
                }
            });
            return tabs;
        },

        workspaceFolders() {
            const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
                name: folder.name,
                uri: folder.uri.toString(),
                path: folder.uri.fsPath,
                index: folder.index,
            }));
            return { folders, rootPath: folders[0]?.path ?? null };
        },

        async openFile(args: OpenFileArgs): Promise<{ success: boolean; message: string }> {
            const uri = vscode.Uri.file(args.filePath);
            let doc: vscode.TextDocument;
            try {
                doc = await vscode.workspace.openTextDocument(uri);
            } catch {
                return { success: false, message: `Failed to open file: ${args.filePath}` };
            }
            const range = resolveTextSelection(doc.getText(), args);
            if (doc.languageId === "markdown") {
                // Route through the user's editor association — this is what
                // opens Birta when Birta is the default .md editor.
                await vscode.commands.executeCommand("vscode.open", uri, {
                    preview: args.preview,
                    preserveFocus: !args.makeFrontmost,
                });
                if (range) {
                    // setPendingNavigation is 1-indexed and tolerates the
                    // panel not being ready yet (it queues until the webview
                    // is); anchor+active restores the full selection.
                    revealInBirta(uri.fsPath, range.end.line + 1, range.end.character, {
                        line: range.start.line + 1,
                        column: range.start.character,
                    });
                }
                return { success: true, message: `Opened file: ${args.filePath}` };
            }
            const editor = await vscode.window.showTextDocument(doc, {
                preview: args.preview,
                preserveFocus: !args.makeFrontmost,
            });
            if (range) {
                const selection = new vscode.Selection(
                    new vscode.Position(range.start.line, range.start.character),
                    new vscode.Position(range.end.line, range.end.character),
                );
                editor.selection = selection;
                editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            }
            return { success: true, message: `Opened file: ${args.filePath}` };
        },

        documentDirty(filePath: string) {
            const doc = documentFor(filePath);
            return doc ? { isDirty: doc.isDirty, isUntitled: doc.isUntitled } : null;
        },

        async saveDocument(filePath: string): Promise<{ success: boolean; message: string }> {
            const doc = documentFor(filePath);
            if (!doc) { return { success: false, message: `Document not open: ${filePath}` }; }
            const saved = await doc.save();
            return saved
                ? { success: true, message: `Saved: ${filePath}` }
                : { success: false, message: `Save failed: ${filePath}` };
        },

        diagnostics(uriFilter?: string) {
            const wanted = uriFilter ? vscode.Uri.parse(uriFilter).toString() : undefined;
            return vscode.languages
                .getDiagnostics()
                .filter(([uri]) => wanted === undefined || uri.toString() === wanted)
                .map(([uri, diags]) => {
                    const doc = documentFor(uri.fsPath);
                    return {
                        uri: uri.toString(),
                        ...(doc ? { linesInFile: doc.lineCount } : {}),
                        diagnostics: diags.map((d) => ({
                            message: d.message,
                            severity: SEVERITY_NAMES[d.severity] ?? "Error",
                            range: {
                                start: { line: d.range.start.line, character: d.range.start.character },
                                end: { line: d.range.end.line, character: d.range.end.character },
                            },
                            source: d.source ?? null,
                            // `typeof null === "object"` — guard it, or a JS
                            // extension's `code: null` throws on `.value`.
                            code: d.code && typeof d.code === "object" ? d.code.value : d.code ?? null,
                        })),
                    };
                });
        },
    };
}
