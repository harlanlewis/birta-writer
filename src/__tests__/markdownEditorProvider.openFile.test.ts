/**
 * openFile handling: the provider resolves a clicked local link through the
 * smart chain (linkResolver.ts) and opens the hit — .md in the WYSIWYG
 * editor, with line-number navigation — or warns non-modally on a miss.
 * The chain itself is unit-tested in linkResolver.test.ts; these tests cover
 * the wiring: config read, IO injection, dispatch, and the wiki flag.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import {
    makeFakeTextDocument,
    resetTextDocumentMocks,
} from "../../__mocks__/vscode";

import { MarkdownEditorProvider } from "../MarkdownEditorProvider";

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
    }) as unknown as vscode.ExtensionContext;

const makePanel = () => ({
    viewColumn: 1,
    active: true,
    visible: true,
    webview: {
        options: {},
        html: "",
        cspSource: "vscode-webview-resource:",
        postMessage: vi.fn(),
        asWebviewUri: vi.fn((uri: vscode.Uri) => uri),
        onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
});

const makeCancellation = () =>
    ({ isCancellationRequested: false }) as vscode.CancellationToken;

/** The workspace: a Hugo-shaped repo rooted at /repo. */
const DOC_PATH = "/repo/content/write/ai-playbook/index.md";

function setWorkspace(existingFiles: string[], opts: { smartLinks?: boolean } = {}): void {
    const files = new Set(existingFiles.map((f) => vscode.Uri.file(f).fsPath));

    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: vscode.Uri.file("/repo") },
    ];
    vi.mocked(vscode.workspace.fs.stat).mockImplementation(async (uri: vscode.Uri) => {
        if (files.has(uri.fsPath)) return { type: vscode.FileType.File } as vscode.FileStat;
        throw new Error("ENOENT");
    });
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue(
        existingFiles.map((f) => vscode.Uri.file(f)),
    );
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: unknown) =>
            key === "smartLinks" ? (opts.smartLinks ?? true) : defaultValue,
        ),
        inspect: vi.fn(() => undefined),
    } as unknown as vscode.WorkspaceConfiguration);
}

async function setup() {
    const provider = new MarkdownEditorProvider(makeContext());
    const document = makeFakeTextDocument("hello\n", vscode.Uri.file(DOC_PATH));
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        makeCancellation(),
    );
    const handler = panel.webview.onDidReceiveMessage.mock
        .calls[0][0] as (msg: Record<string, unknown>) => Promise<void>;
    await handler({ type: "ready" });
    return { provider, handler, panel };
}

function openWithCalls(): Array<[string, vscode.Uri]> {
    return vi
        .mocked(vscode.commands.executeCommand)
        .mock.calls.filter((c) => c[0] === "vscode.openWith")
        .map((c) => [c[0] as string, c[1] as vscode.Uri]);
}

describe("MarkdownEditorProvider openFile handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        (vscode.window.tabGroups as unknown as { all: unknown[] }).all = [];
    });

    it("resolves a Hugo root-relative link via the ancestor walk and opens it in WYSIWYG", async () => {
        setWorkspace([DOC_PATH, "/repo/content/write/uber/index.md"]);
        const { handler } = await setup();

        await handler({ type: "openFile", path: "/write/uber" });

        const calls = openWithCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0][1].fsPath).toBe(vscode.Uri.file("/repo/content/write/uber/index.md").fsPath);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it("passes a numeric fragment through to pending navigation", async () => {
        setWorkspace([DOC_PATH, "/repo/content/write/notes.md"]);
        const { provider, handler } = await setup();
        const spy = vi.spyOn(provider, "setPendingNavigation");

        await handler({ type: "openFile", path: "../notes.md#27" });

        expect(spy).toHaveBeenCalledWith(
            vscode.Uri.file("/repo/content/write/notes.md").fsPath,
            27,
        );
        expect(openWithCalls()).toHaveLength(1);
    });

    it("warns non-modally when nothing matches in smart mode", async () => {
        setWorkspace([DOC_PATH]);
        const { handler } = await setup();

        await handler({ type: "openFile", path: "/write/nonexistent" });

        expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce();
        const msg = vi.mocked(vscode.window.showWarningMessage).mock.calls[0][0] as string;
        expect(msg).toContain("/write/nonexistent");
        expect(openWithCalls()).toHaveLength(0);
    });

    it("routes a wiki target by filename across the workspace", async () => {
        setWorkspace([DOC_PATH, "/repo/notes/My-Page.md"]);
        const { handler } = await setup();

        await handler({ type: "openFile", path: "my-page", wiki: true });

        const calls = openWithCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0][1].fsPath).toBe(vscode.Uri.file("/repo/notes/My-Page.md").fsPath);
    });

    it("never reads a wiki fragment as a line number", async () => {
        setWorkspace([DOC_PATH, "/repo/notes/plan.md"]);
        const { provider, handler } = await setup();
        const spy = vi.spyOn(provider, "setPendingNavigation");

        await handler({ type: "openFile", path: "plan#12", wiki: true });

        expect(spy).not.toHaveBeenCalled();
        expect(openWithCalls()).toHaveLength(1);
    });

    it("resolves a heading fragment to the heading's line", async () => {
        setWorkspace([DOC_PATH, "/repo/content/write/notes.md"]);
        const { provider, handler } = await setup();
        makeFakeTextDocument(
            "intro\n\n# Top\n\ntext\n\n## Some Heading\n\nmore\n",
            vscode.Uri.file("/repo/content/write/notes.md"),
        );
        const spy = vi.spyOn(provider, "setPendingNavigation");

        await handler({ type: "openFile", path: "../notes.md#some-heading" });

        expect(spy).toHaveBeenCalledWith(
            vscode.Uri.file("/repo/content/write/notes.md").fsPath,
            7,
        );
        expect(openWithCalls()).toHaveLength(1);
    });

    it("matches a wikilink's raw heading text against the same slugs", async () => {
        setWorkspace([DOC_PATH, "/repo/notes/plan.md"]);
        const { provider, handler } = await setup();
        makeFakeTextDocument(
            "# Plan\n\n## Next Steps\n\nbody\n",
            vscode.Uri.file("/repo/notes/plan.md"),
        );
        const spy = vi.spyOn(provider, "setPendingNavigation");

        await handler({ type: "openFile", path: "plan#Next Steps", wiki: true });

        expect(spy).toHaveBeenCalledWith(vscode.Uri.file("/repo/notes/plan.md").fsPath, 3);
    });

    it("slugs headings containing inline links the way the webview renders them", async () => {
        setWorkspace([DOC_PATH, "/repo/content/write/notes.md"]);
        const { provider, handler } = await setup();
        makeFakeTextDocument(
            "# See [alpha](a.md) now\n\nbody\n",
            vscode.Uri.file("/repo/content/write/notes.md"),
        );
        const spy = vi.spyOn(provider, "setPendingNavigation");

        // The rendered heading is "See alpha now" → slug see-alpha-now.
        await handler({ type: "openFile", path: "../notes.md#see-alpha-now" });

        expect(spy).toHaveBeenCalledWith(
            vscode.Uri.file("/repo/content/write/notes.md").fsPath,
            1,
        );
    });

    it("opens without scrolling when the heading fragment matches nothing", async () => {
        setWorkspace([DOC_PATH, "/repo/content/write/notes.md"]);
        const { provider, handler } = await setup();
        makeFakeTextDocument("# Only\n", vscode.Uri.file("/repo/content/write/notes.md"));
        const spy = vi.spyOn(provider, "setPendingNavigation");

        await handler({ type: "openFile", path: "../notes.md#missing-heading" });

        expect(spy).not.toHaveBeenCalled();
        expect(openWithCalls()).toHaveLength(1);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it("resolveLinkTarget replies with the workspace-relative display path", async () => {
        setWorkspace([DOC_PATH, "/repo/content/write/uber/index.md"]);
        const { handler, panel } = await setup();

        await handler({ type: "resolveLinkTarget", id: "r1", path: "/write/uber#frag" });

        expect(panel.webview.postMessage).toHaveBeenCalledWith({
            type: "linkTargetResolved",
            id: "r1",
            resolved: "content/write/uber/index.md",
        });
    });

    it("resolveLinkTarget replies null on a smart-mode miss", async () => {
        setWorkspace([DOC_PATH]);
        const { handler, panel } = await setup();

        await handler({ type: "resolveLinkTarget", id: "r2", path: "/write/nonexistent" });

        expect(panel.webview.postMessage).toHaveBeenCalledWith({
            type: "linkTargetResolved",
            id: "r2",
            resolved: null,
        });
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it("non-smart mode opens the workspace-root path directly, without existence checks", async () => {
        setWorkspace([], { smartLinks: false });
        const { handler } = await setup();

        await handler({ type: "openFile", path: "/write/uber.md" });

        const calls = openWithCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0][1].fsPath).toBe(vscode.Uri.file("/repo/write/uber.md").fsPath);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        expect(vscode.workspace.fs.stat).not.toHaveBeenCalled();
    });
});
