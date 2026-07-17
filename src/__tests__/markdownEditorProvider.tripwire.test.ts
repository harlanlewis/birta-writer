/**
 * Destructive-change tripwire + Restore Previous Content (MAR-114, fidelity
 * layer 4): a webview content replacement that removes a large share of the
 * document's significant lines arms a one-slot store of the prior text, and
 * `restorePreviousContent` swaps it back. Threshold logic itself is covered
 * in destructiveGuard.test.ts; this suite pins the provider behavior the
 * user depends on — the slot arms on the real update/flush paths, survives
 * panel disposal, and the restore command actually recovers the bytes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import {
    makeFakeTextDocument,
    resetTextDocumentMocks,
    fireWillSaveTextDocument,
    type FakeTextDocument,
} from "../../__mocks__/vscode";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
    }) as unknown as vscode.ExtensionContext;

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
        onDidDispose: vi.fn((cb: () => void) => { disposeHandlers.push(cb); return { dispose: vi.fn() }; }),
        onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
        dispose: vi.fn(() => { disposeHandlers.forEach((cb) => cb()); }),
    };
};
const makeCancellation = () => ({ isCancellationRequested: false }) as vscode.CancellationToken;

/** A document body of `n` distinct significant lines. */
const doc = (n: number): string =>
    Array.from({ length: n }, (_, i) => `paragraph line ${i}`).join("\n") + "\n";

const FILE = "/project/note.md";

describe("MarkdownEditorProvider destructive-change tripwire (MAR-114)", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        vi.useFakeTimers();
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
    });

    afterEach(() => {
        warnSpy.mockRestore();
        vi.useRealTimers();
        (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = undefined;
    });

    async function setup(content = doc(40)) {
        const provider = new MarkdownEditorProvider(makeContext());
        const document = makeFakeTextDocument(content, vscode.Uri.file(FILE));
        const panel = makePanel();
        await provider.resolveCustomTextEditor(
            document as unknown as vscode.TextDocument,
            panel as unknown as vscode.WebviewPanel,
            makeCancellation(),
        );
        const handler = panel.webview.onDidReceiveMessage.mock
            .calls[0][0] as (msg: Record<string, unknown>) => Promise<void>;
        await handler({ type: "ready" });
        panel.webview.postMessage.mockClear();
        // The palette command targets the active custom-editor tab.
        vscode.window.tabGroups.activeTabGroup.activeTab = {
            input: new vscode.TabInputCustom(document.uri, "birta.editor"),
        };
        return { provider, document, panel, handler };
    }

    describe("arming on the update path", () => {
        it("an update that wipes most of the document should be restorable to the exact prior bytes", async () => {
            const original = doc(40);
            const { provider, document, handler } = await setup(original);

            await handler({ type: "update", content: "paragraph line 0\n", baseSyncVersion: 0, seq: 1 });
            await vi.advanceTimersByTimeAsync(1);
            expect(document.getText()).toBe("paragraph line 0\n");

            await provider.restorePreviousContent();
            expect(document.getText()).toBe(original);
        });

        it("running restore twice should swap back to the replaced content (self-inverse)", async () => {
            const original = doc(40);
            const { provider, document, handler } = await setup(original);
            await handler({ type: "update", content: "wiped\n", baseSyncVersion: 0, seq: 1 });
            await vi.advanceTimersByTimeAsync(1);

            await provider.restorePreviousContent();
            expect(document.getText()).toBe(original);
            await provider.restorePreviousContent();
            expect(document.getText()).toBe("wiped\n");
        });

        it("a destructive update should log one structured dev-console warning and no notification", async () => {
            const { handler } = await setup(doc(40));
            await handler({ type: "update", content: "wiped\n", baseSyncVersion: 0, seq: 1 });
            await vi.advanceTimersByTimeAsync(1);

            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(String(warnSpy.mock.calls[0][0])).toContain("destructive-change tripwire (update)");
            expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
            expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        });

        it("an ordinary edit should not arm the slot, and restore should report nothing stored", async () => {
            const original = doc(40);
            const { provider, document, handler } = await setup(original);

            const modest = original.split("\n").slice(0, -3).join("\n") + "\n";
            await handler({ type: "update", content: modest, baseSyncVersion: 0, seq: 1 });
            await vi.advanceTimersByTimeAsync(1);
            expect(warnSpy).not.toHaveBeenCalled();

            await provider.restorePreviousContent();
            expect(document.getText()).toBe(modest);
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining("No previous content"),
            );
        });
    });

    describe("arming on the save-flush path", () => {
        it("a save flush carrying wiped content should arm the slot", async () => {
            const original = doc(40);
            const { provider, document, panel, handler } = await setup(original);

            const willSave = fireWillSaveTextDocument(document as unknown as FakeTextDocument);
            const flushMsg = panel.webview.postMessage.mock.calls
                .map((c) => c[0] as { type: string; id?: string })
                .find((m) => m.type === "flushSave");
            expect(flushMsg?.id).toBeTruthy();
            await handler({ type: "flushResult", id: flushMsg!.id, content: "wiped\n", baseSyncVersion: 0, seq: 1 });
            const [edits] = (await willSave) as vscode.TextEdit[][];

            // Apply the returned TextEdits the way the real save machinery
            // would — the fake will-save event does not apply them itself, and
            // without this the document never wipes and the assertions below
            // hold with the tripwire deleted (verified red-check).
            let text = document.getText();
            for (const e of edits) {
                const s = document.offsetAt(e.range.start);
                const en = document.offsetAt(e.range.end);
                text = text.slice(0, s) + e.newText + text.slice(en);
            }
            document.setTextExternally(text);
            expect(document.getText()).toBe("wiped\n");

            // The slot must already hold the pre-flush text.
            await provider.restorePreviousContent();
            expect(document.getText()).toBe(original);
        });
    });

    describe("slot lifetime", () => {
        it("the slot should survive panel disposal and restore via the raw text editor", async () => {
            const original = doc(40);
            const { provider, document, panel, handler } = await setup(original);
            await handler({ type: "update", content: "wiped\n", baseSyncVersion: 0, seq: 1 });
            await vi.advanceTimersByTimeAsync(1);

            panel.dispose();
            // The custom tab is gone; the user has the file open as raw text.
            vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
            (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = { document };

            await provider.restorePreviousContent();
            expect(document.getText()).toBe(original);
        });

        it("restore with no editor at all should report nothing stored and touch no document", async () => {
            const { provider, document, panel, handler } = await setup(doc(40));
            await handler({ type: "update", content: "wiped\n", baseSyncVersion: 0, seq: 1 });
            await vi.advanceTimersByTimeAsync(1);

            // No custom tab, no live panel, no text editor: no target document.
            panel.dispose();
            vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
            await provider.restorePreviousContent();
            expect(document.getText()).toBe("wiped\n");
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining("No previous content"),
            );
        });
    });

    describe("restore integrates with the sync pipeline", () => {
        it("a document with frontmatter should restore byte-exact, frontmatter included", async () => {
            // The update path reattaches the stored frontmatter in file space
            // (_prepareContentForSave); the slot must hold — and the restore
            // return — the full file bytes, not the body-space content.
            const original = "---\ntitle: Test\ntags: [a, b]\n---\n\n" + doc(40);
            const { provider, document, handler } = await setup(original);

            await handler({ type: "update", content: "wiped\n", baseSyncVersion: 0, seq: 1 });
            await vi.advanceTimersByTimeAsync(1);
            expect(document.getText()).toBe("---\ntitle: Test\ntags: [a, b]\n---\nwiped\n");

            await provider.restorePreviousContent();
            expect(document.getText()).toBe(original);
        });

        it("a restore issued while an update's applyEdit is in flight should serialize after it", async () => {
            // Regression: restore used to bypass the per-document edit queue,
            // so it read the pre-update text, concluded "identical to the
            // slot", and silently did nothing while the destructive update
            // landed afterwards (or worse, spliced a stale range).
            const original = doc(40);
            const { provider, document, handler } = await setup(original);

            const applyEditMock = vi.mocked(vscode.workspace.applyEdit);
            const real = applyEditMock.getMockImplementation()!;
            let release!: () => void;
            const gate = new Promise<void>((r) => { release = r; });
            applyEditMock.mockImplementationOnce(async (edit) => {
                await gate;
                return real(edit) as Promise<boolean>;
            });

            await handler({ type: "update", content: "wiped\n", baseSyncVersion: 0, seq: 1 });
            await Promise.resolve(); // let the queued update start and park on the gate
            const restore = provider.restorePreviousContent();
            release();
            await restore;
            await vi.advanceTimersByTimeAsync(1);

            expect(document.getText()).toBe(original);
        });

        it("a restore should re-base an open webview via an externalUpdate push", async () => {
            const original = doc(40);
            const { provider, panel, handler } = await setup(original);
            await handler({ type: "update", content: "wiped\n", baseSyncVersion: 0, seq: 1 });
            await vi.advanceTimersByTimeAsync(1);
            panel.webview.postMessage.mockClear();

            await provider.restorePreviousContent();
            await vi.advanceTimersByTimeAsync(500);

            const pushes = panel.webview.postMessage.mock.calls
                .map(([msg]) => msg as { type: string; content?: string })
                .filter((m) => m.type === "externalUpdate");
            expect(pushes).toHaveLength(1);
            expect(pushes[0].content).toBe(original);
        });
    });
});
