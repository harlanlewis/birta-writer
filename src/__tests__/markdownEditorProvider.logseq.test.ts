/**
 * The provider's Logseq seam (MAR-132): who calls the detector, and when.
 *
 * The detector itself is covered by logseqDetect.test.ts. What lives HERE is
 * the claim that `birta.logseq: off`, the default, costs nothing observable:
 * the short-circuit is in the provider, before the detector is reached, so a
 * detector-level test cannot pin it. The evidence is the absence of a `stat`
 * call and the absence of a message on the whole open path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
        subscriptions: [],
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

const makeCancellation = () => ({ isCancellationRequested: false }) as vscode.CancellationToken;

/** Point `birta.logseq` at `mode`; every other key keeps its contributed default. */
function setLogseqMode(mode: string): void {
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
        () =>
            ({
                get: vi.fn((key: string, defaultValue?: unknown) =>
                    key === "logseq" ? mode : defaultValue,
                ),
                inspect: vi.fn(() => undefined),
            }) as never,
    );
}

async function openAndReady(content: string, path = "/graph/pages/Atlas.md") {
    const provider = new MarkdownEditorProvider(makeContext());
    const document = makeFakeTextDocument(content, vscode.Uri.file(path));
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        makeCancellation(),
    );
    const handler = panel.webview.onDidReceiveMessage.mock
        .calls[0]![0] as (msg: Record<string, unknown>) => Promise<void>;
    await handler({ type: "ready" });
    // Detection is deliberately off the init path, so it settles a microtask
    // or two later; drain the queue rather than assert into the gap.
    await new Promise((resolve) => setImmediate(resolve));
    return { panel, provider, document };
}

/** The logseqState message the open posted, or undefined. */
function postedLogseq(panel: ReturnType<typeof makePanel>): Record<string, unknown> | undefined {
    return panel.webview.postMessage.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((m) => m["type"] === "logseqState");
}

const LOGSEQ_PAGE = [
    "- Morning notes, linked [[Project Atlas]].",
    "\t- A nested child block.",
    "- Reference: ((7f3e9a10-1234-5678-9abc-def012345678))",
    "- TODO Follow up",
].join("\n");

describe("provider Logseq detection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        vi.mocked(vscode.workspace.fs.stat).mockRejectedValue(new Error("ENOENT"));
    });

    it("the default (off) should cost no filesystem probe and no message", async () => {
        setLogseqMode("off");
        // A document that WOULD be detected, so a passing result means the gate
        // held rather than that there was nothing to find.
        const { panel } = await openAndReady(LOGSEQ_PAGE);

        expect(vscode.workspace.fs.stat).not.toHaveBeenCalled();
        expect(postedLogseq(panel)).toBeUndefined();
    });

    it("auto should report the reason for a page whose content is unmistakably Logseq", async () => {
        setLogseqMode("auto");
        const { panel } = await openAndReady(LOGSEQ_PAGE);

        expect(postedLogseq(panel)).toEqual({ type: "logseqState", reason: "content" });
    });

    it("auto should report no reason for an ordinary document", async () => {
        setLogseqMode("auto");
        const { panel } = await openAndReady("# Notes\n\nAn ordinary paragraph.\n");

        expect(postedLogseq(panel)).toEqual({ type: "logseqState", reason: null });
    });

    it("on should report `forced` even for a document with nothing Logseq about it", async () => {
        setLogseqMode("on");
        const { panel } = await openAndReady("# Notes\n\nAn ordinary paragraph.\n");

        expect(postedLogseq(panel)).toEqual({ type: "logseqState", reason: "forced" });
    });

    it("turning the setting off should tell an editor that was already told otherwise", async () => {
        // Withdrawal, not silence: a panel showing the badge has to be told the
        // badge is over, or it keeps asserting a mode that is no longer set.
        setLogseqMode("on");
        const { panel, provider, document } = await openAndReady("# Notes\n");
        expect(postedLogseq(panel)).toEqual({ type: "logseqState", reason: "forced" });

        setLogseqMode("off");
        panel.webview.postMessage.mockClear();
        provider.detectLogseqFor(
            document as unknown as vscode.TextDocument,
            panel as unknown as vscode.WebviewPanel,
            true,
        );
        await new Promise((resolve) => setImmediate(resolve));

        expect(postedLogseq(panel)).toEqual({ type: "logseqState", reason: null });
    });
});
