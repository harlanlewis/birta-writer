/**
 * src/diffPanel.ts - the rendered-diff panel (MAR-55).
 *
 * Reviewing a change to a `.md` file is a reading job, and VS Code's diff
 * editor can only offer it as source. That is a live reason to leave the
 * WYSIWYG editor, so this panel answers it: the document rendered, with the
 * words that changed marked in place.
 *
 * The panel is deliberately NOT a second custom editor. It compares a URI
 * against its own history rather than editing anything, it must survive the
 * file's tab being closed, and it is opened by a command rather than by
 * opening a file. `vscode.window.createWebviewPanel` is the shape for that,
 * and this is the first one in the extension - `MarkdownEditorProvider` is
 * the reference for webview options and teardown, not for lifecycle.
 *
 * It runs its own page (`dist/diffView.js`), not the editor bundle, and speaks
 * its own protocol (shared/diffMessages.ts). Rung 0 of the ladder in
 * docs/NETWORK_POSTURE.md: `default-src 'none'` with no host added back, and
 * the page renders images as their path rather than fetching them, so the
 * panel cannot make an outbound request at all.
 */
import * as vscode from "vscode";
import { getNonce } from "./utils/getNonce";
import { escapeHtmlAttr } from "./webviewHtml";
import { postToDiffView } from "./webviewMessaging";
import { resolveBaseContent, type GitRunner } from "./gitBaseContent";
import { reportError } from "./errorSink";
import { isDocumentPath } from "../shared/documentExtensions";
import type { FromDiffViewMessage } from "../shared/diffMessages";

/** The panel's view type; `webviewId` for menu contributions keys off it. */
export const DIFF_VIEW_TYPE = "birta.diff";

/**
 * A refresh coalescing window. Typing in the editor fires a document change
 * per keystroke and each one would re-render both sides, so changes settle
 * before the panel re-reads. Long enough to skip a burst, short enough that a
 * pause in typing shows up as an updated diff.
 */
const REFRESH_DEBOUNCE_MS = 400;

/** One panel per file: asking twice reveals the first rather than stacking. */
const open = new Map<string, DiffPanel>();

/**
 * The URI a diff command should act on, from whatever the invoker passed.
 *
 * Three callers with three shapes: the palette passes nothing, the editor
 * title bar passes the active resource's URI, and the SCM context menu passes
 * a resource state object. The check is structural rather than
 * `instanceof vscode.Uri` on purpose - an SCM resource state is built by
 * another extension, so the only thing we can rely on is its shape.
 */
export function diffTargetFromArg(arg: unknown, fallback?: vscode.Uri): vscode.Uri | undefined {
    const direct = asUri(arg);
    if (direct) { return direct; }
    const nested = asUri((arg as { resourceUri?: unknown } | null | undefined)?.resourceUri);
    if (nested) { return nested; }
    return fallback;
}

function asUri(value: unknown): vscode.Uri | undefined {
    const candidate = value as vscode.Uri | undefined;
    return typeof candidate?.fsPath === "string" && typeof candidate?.scheme === "string"
        ? candidate
        : undefined;
}

/**
 * The file's live content: the open buffer when there is one, disk otherwise.
 *
 * The buffer is what makes the diff live. Under the custom editor the webview
 * syncs into the backing `TextDocument` on a typing pause, so reading the
 * document here shows unsaved work - which is the state a writer most wants to
 * review, and the reason this does not simply read the file.
 */
export async function readWorkingContent(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    const buffer = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (buffer) { return buffer.getText(); }
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(bytes);
}

/** Open (or reveal) the rendered diff for `uri`. */
export async function openDiffPanel(
    context: vscode.ExtensionContext,
    uri: vscode.Uri,
    run?: GitRunner,
): Promise<void> {
    if (!isDocumentPath(uri.path)) {
        void vscode.window.showInformationMessage(
            vscode.l10n.t("Birta Writer can only diff Markdown files."),
        );
        return;
    }

    const key = uri.toString();
    const existing = open.get(key);
    if (existing) {
        existing.reveal();
        await existing.refresh();
        return;
    }

    const panel = new DiffPanel(context, uri, run);
    open.set(key, panel);
    panel.onDisposed(() => open.delete(key));
}

class DiffPanel {
    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    /** Set once the page answers `diffReady`; nothing is posted before that. */
    private ready = false;
    private disposedHandlers: Array<() => void> = [];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly uri: vscode.Uri,
        private readonly run?: GitRunner,
    ) {
        this.panel = vscode.window.createWebviewPanel(
            DIFF_VIEW_TYPE,
            vscode.l10n.t("Changes: {0}", basename(uri.path)),
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
            },
        );
        this.panel.webview.html = this.buildHtml();

        this.disposables.push(
            this.panel.webview.onDidReceiveMessage((msg: FromDiffViewMessage) => {
                if (msg?.type === "diffReady") {
                    this.ready = true;
                    void this.refresh();
                } else if (msg?.type === "diffFailed") {
                    reportError("diffPanel", new Error(msg.message));
                }
            }),
            // The working side is whatever the buffer says, so both editing it
            // and saving it move the diff. Saving matters on its own because a
            // save can rewrite bytes the buffer never held (a will-save
            // participant, a formatter).
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === this.uri.toString()) { this.scheduleRefresh(); }
            }),
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (doc.uri.toString() === this.uri.toString()) { this.scheduleRefresh(); }
            }),
            // The BASE side moves too, and nothing in the workspace reports a
            // commit or a checkout. Rather than watch `.git`, re-read when the
            // panel comes back into view: the gesture that changes HEAD always
            // ends with the reader returning here, and a stale left-hand side
            // is the one error this panel cannot show its way out of.
            this.panel.onDidChangeViewState((e) => {
                if (e.webviewPanel.visible) { this.scheduleRefresh(); }
            }),
        );

        this.panel.onDidDispose(() => this.dispose());
    }

    reveal(): void {
        this.panel.reveal(this.panel.viewColumn, false);
    }

    onDisposed(handler: () => void): void {
        this.disposedHandlers.push(handler);
    }

    private scheduleRefresh(): void {
        if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.refresh();
        }, REFRESH_DEBOUNCE_MS);
    }

    async refresh(): Promise<void> {
        if (!this.ready) { return; }
        try {
            const [base, working] = await Promise.all([
                resolveBaseContent(this.uri.fsPath, this.run),
                readWorkingContent(this.uri),
            ]);
            if (!base.ok) {
                postToDiffView(this.panel.webview, { type: "diffUnavailable", reason: base.reason });
                return;
            }
            postToDiffView(this.panel.webview, {
                type: "diffContent",
                base: base.text,
                working,
                label: vscode.workspace.asRelativePath(this.uri),
                baseOrigin: base.origin,
            });
        } catch (err) {
            // A disposed panel throws from the post, and a deleted file throws
            // from the read. Neither is worth a notification: the panel is
            // either gone or showing its last good render.
            reportError("diffPanel.refresh", err);
        }
    }

    private buildHtml(): string {
        const webview = this.panel.webview;
        const nonce = getNonce();
        const script = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, "dist", "diffView.js"),
        );
        const style = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, "dist", "diffView.css"),
        );
        // `default-src 'none'` with nothing added back for network: the page
        // renders images as their path rather than fetching them, so no
        // img-src host is needed and none is granted.
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}';
             font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${escapeHtmlAttr(style.toString())}">
  <title>Changes</title>
</head>
<body>
  <div id="diff-root"></div>
  <script type="module" nonce="${nonce}" src="${escapeHtmlAttr(script.toString())}"></script>
</body>
</html>`;
    }

    private dispose(): void {
        if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
        for (const d of this.disposables) { d.dispose(); }
        this.disposables.length = 0;
        for (const handler of this.disposedHandlers) { handler(); }
        this.disposedHandlers = [];
    }
}

function basename(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx === -1 ? path : path.slice(idx + 1);
}
