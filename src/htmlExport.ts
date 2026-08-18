/**
 * src/htmlExport.ts
 *
 * The extension half of Export as HTML (MAR-32). The webview renders the
 * document into one self-contained HTML string and posts it as `exportHtml`;
 * this module owns everything that needs the host: the save dialog, the write,
 * and the offer to open the result in the browser.
 *
 * There is no PDF export. A webview has no print API, so the honest PDF path
 * is the browser's own print-to-PDF on the exported file, which is why the
 * follow-up action is "Open in Browser" and the export carries print CSS.
 */
import * as path from "path";
import * as vscode from "vscode";
import { reportError } from "./errorSink";

/** The default file name for a document: its own base name with `.html`. */
export function exportFileName(documentName: string): string {
    const base = path.basename(documentName).replace(/\.[^.]+$/, "");
    return `${base || "document"}.html`;
}

/**
 * Ask where to save, write the bytes, offer to open. Resolves once the flow
 * has finished; a cancelled dialog is a quiet no-op, and a failed write is
 * reported through the error sink rather than thrown.
 */
export async function saveHtmlExport(
    document: vscode.TextDocument,
    html: string,
    suggestedName: string,
): Promise<vscode.Uri | undefined> {
    const name = exportFileName(suggestedName || document.uri.path);
    // Beside the document when it lives on disk; an untitled document has no
    // "beside", so the dialog opens on its own default location.
    const defaultUri = document.uri.scheme === "file"
        ? vscode.Uri.joinPath(document.uri, "..", name)
        : undefined;
    const target = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { HTML: ["html", "htm"] },
        saveLabel: vscode.l10n.t("Export"),
        title: vscode.l10n.t("Export as HTML"),
    });
    if (!target) { return undefined; }
    try {
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(html));
    } catch (err) {
        reportError("exportHtml", err);
        void vscode.window.showErrorMessage(
            vscode.l10n.t("Could not write {0}. See the developer console for details.", path.basename(target.path)),
        );
        return undefined;
    }
    const open = vscode.l10n.t("Open in Browser");
    void vscode.window
        .showInformationMessage(vscode.l10n.t("Exported {0}", path.basename(target.path)), open)
        .then((choice) => {
            if (choice === open) { void vscode.env.openExternal(target); }
        });
    return target;
}
