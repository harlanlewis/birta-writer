/**
 * ToC width + show/hide on the extension side. Both are ordinary `birta.*`
 * settings (like `tocPosition`): baked into the webview at resolve time
 * (`birta.tocWidth` as the `--toc-width` CSS var, `birta.tocVisibility` into
 * `window.__i18n`), and written back through `updateSettingRespectingScope`
 * when the panel is dragged or toggled. The live echo to other editors rides
 * the config-change listener (extension.ts); the webview-side apply/auto-open
 * behavior is covered by toc.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";

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

/** getConfiguration mock: `get` returns the user value or the default; `inspect`
 *  reports a globalValue only for keys present (so the write-back picks Global). */
function mockConfiguration(userValues: Record<string, unknown> = {}) {
    const cfg = {
        get: vi.fn((key: string, defaultValue?: unknown) =>
            key in userValues ? userValues[key] : defaultValue),
        inspect: vi.fn((key: string) =>
            key in userValues ? { key, globalValue: userValues[key] } : { key }),
        update: vi.fn(),
    };
    (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue(cfg);
    return cfg;
}

type Handler = (msg: Record<string, unknown>) => Promise<void> | void;
function handlerOf(panel: ReturnType<typeof makePanel>): Handler {
    return panel.webview.onDidReceiveMessage.mock.calls[0]![0] as unknown as Handler;
}

async function resolve(panel: ReturnType<typeof makePanel>) {
    const provider = new MarkdownEditorProvider(makeContext());
    await provider.resolveCustomTextEditor(
        makeFakeTextDocument("content\n", vscode.Uri.file("/project/note.md")) as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        makeCancellation(),
    );
}

describe("MarkdownEditorProvider ToC settings injection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    async function htmlFor(userValues: Record<string, unknown>): Promise<string> {
        mockConfiguration(userValues);
        const panel = makePanel();
        await resolve(panel);
        return panel.webview.html;
    }

    it("the default visibility should inject tocVisibility:auto", async () => {
        expect(await htmlFor({})).toContain('"tocVisibility":"auto"');
    });

    it("a hidden setting should inject tocVisibility:hidden", async () => {
        expect(await htmlFor({ tocVisibility: "hidden" })).toContain('"tocVisibility":"hidden"');
    });

    it("a shown setting should inject tocVisibility:shown", async () => {
        expect(await htmlFor({ tocVisibility: "shown" })).toContain('"tocVisibility":"shown"');
    });

    it("the tocWidth setting should drive the --toc-width CSS variable", async () => {
        expect(await htmlFor({ tocWidth: 320 })).toContain("--toc-width: 320px");
    });

    it("an out-of-range tocWidth should be clamped in the CSS variable", async () => {
        expect(await htmlFor({ tocWidth: 9000 })).toContain("--toc-width: 600px");
    });
});

describe("MarkdownEditorProvider ToC settings write-back", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    it("a tocVisibility:shown message should write tocVisibility=shown", async () => {
        mockConfiguration();
        const panel = makePanel();
        await resolve(panel);
        const cfg = mockConfiguration();

        await handlerOf(panel)({ type: "tocVisibility", visibility: "shown" });

        expect(cfg.update).toHaveBeenCalledWith("tocVisibility", "shown", vscode.ConfigurationTarget.Global);
    });

    it("a tocVisibility:hidden message should write tocVisibility=hidden", async () => {
        mockConfiguration();
        const panel = makePanel();
        await resolve(panel);
        const cfg = mockConfiguration();

        await handlerOf(panel)({ type: "tocVisibility", visibility: "hidden" });

        expect(cfg.update).toHaveBeenCalledWith("tocVisibility", "hidden", vscode.ConfigurationTarget.Global);
    });

    it("a malformed tocVisibility message should be normalized to auto before the write", async () => {
        mockConfiguration();
        const panel = makePanel();
        await resolve(panel);
        const cfg = mockConfiguration();

        await handlerOf(panel)({ type: "tocVisibility", visibility: "garbage" });

        expect(cfg.update).toHaveBeenCalledWith("tocVisibility", "auto", vscode.ConfigurationTarget.Global);
    });

    it("a tocWidth message should write the clamped width to tocWidth", async () => {
        mockConfiguration();
        const panel = makePanel();
        await resolve(panel);
        const cfg = mockConfiguration();

        await handlerOf(panel)({ type: "tocWidth", width: 9000 });

        expect(cfg.update).toHaveBeenCalledWith("tocWidth", 600, vscode.ConfigurationTarget.Global);
    });
});
