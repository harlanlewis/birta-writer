/**
 * MAR-346 inversion 3 at the host: the provider acts on the backend's
 * BaseRejection verdict instead of hard-coding drop-and-re-push. The default
 * backend's repush arm is pinned by textSync's "stale-update rejection"
 * suite; these tests inject non-default backends and pin that each verdict
 * produces ITS behavior — they go red if `_settleBaseRejection` collapses
 * back to an unconditional re-push.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";

import { MarkdownEditorProvider } from "../MarkdownEditorProvider";
import type { FlushBackend } from "../../shared/saveFlushController";

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
        subscriptions: [],
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

const makeCancellation = () => ({ isCancellationRequested: false }) as vscode.CancellationToken;

function posted(panel: FakePanel, type: string): Array<Record<string, unknown>> {
    return panel.webview.postMessage.mock.calls
        .map(([msg]) => msg as Record<string, unknown>)
        .filter((msg) => msg.type === type);
}

/** A backend that rejects every base and answers with the given verdict. */
const rejectingBackend = (
    onBaseRejected: FlushBackend["onBaseRejected"],
): FlushBackend => ({ isAdmissibleBase: () => false, onBaseRejected });

describe("MarkdownEditorProvider base-rejection outcomes (MAR-346)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    async function setup(backend: FlushBackend, content = "original\n") {
        const provider = new MarkdownEditorProvider(makeContext(), 1000, backend);
        const document = makeFakeTextDocument(content, vscode.Uri.file("/project/note.md"));
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
        return { provider, document, panel, handler };
    }

    it("a repush verdict should drop the content and re-push authoritative state", async () => {
        const { handler, document, panel } = await setup(
            rejectingBackend(() => ({ outcome: "repush" })),
        );

        await handler({ type: "update", content: "proposed\n", baseSyncVersion: 0, seq: 1 });
        await vi.advanceTimersByTimeAsync(500);

        expect(document.getText()).toBe("original\n");
        expect(posted(panel, "externalUpdate")).toHaveLength(1);
        expect(posted(panel, "syncConflict")).toHaveLength(0);
    });

    it("a defer verdict should change nothing and push nothing", async () => {
        const { handler, document, panel } = await setup(
            rejectingBackend(() => ({ outcome: "defer" })),
        );

        await handler({ type: "update", content: "proposed\n", baseSyncVersion: 0, seq: 1 });
        await vi.advanceTimersByTimeAsync(500);

        expect(document.getText()).toBe("original\n");
        expect(posted(panel, "externalUpdate"), "defer must not re-push").toHaveLength(0);
        expect(posted(panel, "syncConflict")).toHaveLength(0);
    });

    it("an escalate verdict should surface the conflict and change nothing", async () => {
        const { handler, document, panel } = await setup(
            rejectingBackend(() => ({ outcome: "escalate" })),
        );

        await handler({ type: "update", content: "proposed\n", baseSyncVersion: 0, seq: 1 });
        await vi.advanceTimersByTimeAsync(500);

        expect(document.getText()).toBe("original\n");
        expect(posted(panel, "externalUpdate"), "escalate must not re-push").toHaveLength(0);
        expect(posted(panel, "syncConflict")).toEqual([{ type: "syncConflict", state: "conflict" }]);
    });

    it("a rebase verdict should admit the carried-forward content in place of the proposal", async () => {
        const { handler, document, panel } = await setup(
            rejectingBackend(({ content }) => ({ outcome: "rebase", content: `rebased:${content}` })),
        );

        await handler({ type: "update", content: "proposed\n", baseSyncVersion: 0, seq: 1 });
        await vi.advanceTimersByTimeAsync(500);

        expect(document.getText()).toBe("rebased:proposed\n");
        expect(posted(panel, "externalUpdate"), "the admitted rebase is an echo, not a push").toHaveLength(0);
    });

    it("a frontmatter rebase verdict should degrade to a re-push, never a partial apply", async () => {
        const { handler, document, panel } = await setup(
            rejectingBackend(({ content }) => ({ outcome: "rebase", content })),
            "---\ntitle: a\n---\nbody\n",
        );

        await handler({ type: "frontmatterUpdate", frontmatter: "---\ntitle: b\n---\n", baseSyncVersion: 0 });
        await vi.advanceTimersByTimeAsync(500);

        expect(document.getText()).toBe("---\ntitle: a\n---\nbody\n");
        expect(posted(panel, "externalUpdate")).toHaveLength(1);
    });
});
