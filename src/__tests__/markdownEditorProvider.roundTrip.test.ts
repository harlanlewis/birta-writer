/**
 * Extension-side message round-trip tests: real MarkdownEditorProvider +
 * real MarkdownDocument, with the central vscode mock (__mocks__/vscode.ts)
 * standing in ONLY at the VS Code API boundary (fs, configuration, watcher).
 *
 * Covered seam: webview "ready" → init reply (frontmatter split, lineMap),
 * webview "update" → document.update → debounced autosave → the exact bytes
 * written to disk (frontmatter re-attached) → lineMapUpdate reply, and
 * "frontmatterUpdate" → new frontmatter + unchanged body saved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";

const mockFs = vscode.workspace.fs as unknown as {
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
};

import { MarkdownDocument } from "../MarkdownDocument";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
    }) as unknown as vscode.ExtensionContext;

/** Minimal WebviewPanel fake covering everything resolveCustomEditor touches */
const makePanel = () => {
    const disposeHandlers: Array<() => void> = [];
    return {
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
        onDidDispose: vi.fn((cb: () => void) => {
            disposeHandlers.push(cb);
            return { dispose: vi.fn() };
        }),
        onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
        dispose: vi.fn(() => {
            disposeHandlers.forEach((cb) => cb());
        }),
    };
};
type FakePanel = ReturnType<typeof makePanel>;

const makeCancellation = () =>
    ({ isCancellationRequested: false }) as vscode.CancellationToken;

/** All messages of the given type posted to the panel so far. */
function posted(panel: FakePanel, type: string): Array<Record<string, unknown>> {
    return panel.webview.postMessage.mock.calls
        .map(([msg]) => msg as Record<string, unknown>)
        .filter((msg) => msg.type === type);
}

/** The last content written to disk, decoded (null when nothing was written). */
function writtenBytes(): string | null {
    const call = mockFs.writeFile.mock.calls.at(-1);
    return call ? Buffer.from(call[1] as Uint8Array).toString("utf-8") : null;
}

const FM = "---\ntitle: Test\ntags: [a, b]\n---\n";
const BODY = "# Heading\n\ntext here\n";

describe("MarkdownEditorProvider webview message round trip", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function setup(content: string, filePath = "/project/note.md") {
        mockFs.readFile.mockResolvedValue(Buffer.from(content, "utf-8"));
        const provider = new MarkdownEditorProvider(makeContext());
        const document = await MarkdownDocument.create(vscode.Uri.file(filePath));
        const panel = makePanel();
        await provider.resolveCustomEditor(
            document,
            panel as unknown as vscode.WebviewPanel,
            makeCancellation(),
        );
        // The registered message handler IS the production routing switch.
        const handler = panel.webview.onDidReceiveMessage.mock
            .calls[0][0] as (msg: Record<string, unknown>) => Promise<void>;
        return { provider, document, panel, handler };
    }

    describe("ready → init", () => {
        it("should reply with the body only, the frontmatter split off, and a full-file line map", async () => {
            // Arrange
            const { handler, panel } = await setup(FM + BODY);

            // Act
            await handler({ type: "ready" });

            // Assert — the editor receives the BODY; the frontmatter travels
            // separately (for the fm panel); the lineMap covers the full file
            const inits = posted(panel, "init");
            expect(inits).toHaveLength(1);
            expect(inits[0].content).toBe(BODY);
            expect(inits[0].frontmatter).toBe(FM);
            expect(Array.isArray(inits[0].lineMap)).toBe(true);
        });

        it("a file without frontmatter should init with the whole content and no frontmatter", async () => {
            // Arrange
            const { handler, panel } = await setup(BODY);

            // Act
            await handler({ type: "ready" });

            // Assert
            const inits = posted(panel, "init");
            expect(inits[0].content).toBe(BODY);
            expect(inits[0].frontmatter).toBeUndefined();
        });
    });

    describe("update → autosave", () => {
        it("should re-attach the frontmatter and write the exact file bytes after the debounce", async () => {
            // Arrange
            const { handler, panel, document } = await setup(FM + BODY);
            await handler({ type: "ready" });
            const newBody = "# Heading\n\nedited text here\n";

            // Act — webview posts the edited BODY; autosave debounce = 1000ms
            await handler({ type: "update", content: newBody });
            expect(writtenBytes()).toBeNull(); // not yet — debounced
            await vi.advanceTimersByTimeAsync(1100);

            // Assert — the saved file is frontmatter + edited body, verbatim
            expect(writtenBytes()).toBe(FM + newBody);
            expect(document.getText()).toBe(FM + newBody);
            // ...and the webview got a fresh lineMap for the saved content
            expect(posted(panel, "lineMapUpdate")).toHaveLength(1);
        });

        it("an update identical to the current content should not schedule a save", async () => {
            // Arrange
            const { handler } = await setup(FM + BODY);
            await handler({ type: "ready" });

            // Act — echo of the current body (e.g. serializer no-op)
            await handler({ type: "update", content: BODY });
            await vi.advanceTimersByTimeAsync(2000);

            // Assert
            expect(mockFs.writeFile).not.toHaveBeenCalled();
        });

        it("rapid successive updates should debounce into a single write of the LAST content", async () => {
            // Arrange
            const { handler } = await setup(BODY);
            await handler({ type: "ready" });

            // Act — three updates inside one debounce window
            await handler({ type: "update", content: "one\n" });
            await vi.advanceTimersByTimeAsync(300);
            await handler({ type: "update", content: "two\n" });
            await vi.advanceTimersByTimeAsync(300);
            await handler({ type: "update", content: "three\n" });
            await vi.advanceTimersByTimeAsync(1100);

            // Assert
            expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
            expect(writtenBytes()).toBe("three\n");
        });
    });

    describe("frontmatterUpdate → autosave", () => {
        it("should keep the body and save with the NEW frontmatter", async () => {
            // Arrange
            const { handler, document } = await setup(FM + BODY);
            await handler({ type: "ready" });
            const newFm = "---\ntitle: Renamed\ntags: [a, b]\n---\n";

            // Act
            await handler({ type: "frontmatterUpdate", frontmatter: newFm });
            await vi.advanceTimersByTimeAsync(1100);

            // Assert
            expect(document.getText()).toBe(newFm + BODY);
            expect(writtenBytes()).toBe(newFm + BODY);
        });

        it("an unchanged frontmatter should not save", async () => {
            // Arrange
            const { handler } = await setup(FM + BODY);
            await handler({ type: "ready" });

            // Act
            await handler({ type: "frontmatterUpdate", frontmatter: FM });
            await vi.advanceTimersByTimeAsync(2000);

            // Assert
            expect(mockFs.writeFile).not.toHaveBeenCalled();
        });
    });
});
