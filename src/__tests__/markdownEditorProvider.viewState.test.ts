/**
 * The per-URI view-state echo: the webview mirrors its state bag (fold
 * anchors, scroll, frontmatter collapse, per-block widths/wrap) via
 * `viewState` messages; a LATER webview for the same document gets it back
 * in `init`. This is what makes the raw-editor round trip — which CLOSES
 * the custom tab and destroys VS Code's own webview state — lossless for
 * view state. The echo is backed by `workspaceState` (birta.viewState.v1),
 * so it also survives window reloads and full restarts, LRU-capped.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import {
    makeFakeTextDocument,
    resetTextDocumentMocks,
} from "../../__mocks__/vscode";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";

/** An in-memory Memento standing in for context.workspaceState, shared
 * between provider instances to model an extension-host restart. */
function makeMemento() {
    const store = new Map<string, unknown>();
    return {
        get: vi.fn((key: string) => store.get(key)),
        update: vi.fn((key: string, value: unknown) => {
            store.set(key, value);
            return Promise.resolve();
        }),
        keys: () => [...store.keys()],
    };
}

const makeContext = (workspaceState?: ReturnType<typeof makeMemento>) =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
        ...(workspaceState ? { workspaceState } : {}),
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

async function resolve(provider: MarkdownEditorProvider, doc: unknown) {
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        doc as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        { isCancellationRequested: false } as vscode.CancellationToken,
    );
    const handler = panel.webview.onDidReceiveMessage.mock
        .calls[0][0] as (msg: Record<string, unknown>) => Promise<void>;
    return { panel, handler };
}

function lastInit(panel: ReturnType<typeof makePanel>): Record<string, unknown> | undefined {
    const inits = panel.webview.postMessage.mock.calls
        .map((c) => c[0] as { type: string })
        .filter((m) => m.type === "init");
    return inits[inits.length - 1] as Record<string, unknown> | undefined;
}

describe("MarkdownEditorProvider view-state echo", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    it("a bag posted by one webview should ride the NEXT webview's init for the same doc", async () => {
        const provider = new MarkdownEditorProvider(makeContext());
        const doc = makeFakeTextDocument("hello\n", vscode.Uri.file("/project/note.md"));

        const first = await resolve(provider, doc);
        await first.handler({ type: "ready" });
        await first.handler({ type: "viewState", state: { fmCollapsed: true, scrollY: 42 } });

        // The raw-editor switch closes the tab; reopening resolves a NEW panel.
        const second = await resolve(provider, doc);
        await second.handler({ type: "ready" });

        expect(lastInit(second.panel)?.["viewState"]).toEqual({ fmCollapsed: true, scrollY: 42 });
    });

    it("a document never echoed should init with no viewState", async () => {
        const provider = new MarkdownEditorProvider(makeContext());
        const doc = makeFakeTextDocument("hello\n", vscode.Uri.file("/project/other.md"));
        const { panel, handler } = await resolve(provider, doc);
        await handler({ type: "ready" });
        expect(lastInit(panel)?.["viewState"]).toBeUndefined();
    });

    it("a viewState echo should be persisted to workspaceState (birta.viewState.v1)", async () => {
        const memento = makeMemento();
        const provider = new MarkdownEditorProvider(makeContext(memento));
        const doc = makeFakeTextDocument("hello\n", vscode.Uri.file("/project/note.md"));
        const { handler } = await resolve(provider, doc);

        await handler({ type: "viewState", state: { blockWidths: { "table:H": "full" } } });

        const stored = memento.get("birta.viewState.v1") as Record<string, { t: number; s: unknown }>;
        const key = vscode.Uri.file("/project/note.md").toString();
        expect(stored[key]?.s).toEqual({ blockWidths: { "table:H": "full" } });
        expect(typeof stored[key]?.t).toBe("number");
    });

    it("a FRESH provider (extension-host restart) should hydrate init.viewState from the Memento", async () => {
        const memento = makeMemento();
        const doc = makeFakeTextDocument("hello\n", vscode.Uri.file("/project/note.md"));

        const before = new MarkdownEditorProvider(makeContext(memento));
        const first = await resolve(before, doc);
        await first.handler({ type: "viewState", state: { blockWidths: { "table:H": "full" } } });

        // New provider, same Memento — the in-memory map starts empty.
        const after = new MarkdownEditorProvider(makeContext(memento));
        const second = await resolve(after, doc);
        await second.handler({ type: "ready" });

        expect(lastInit(second.panel)?.["viewState"]).toEqual({ blockWidths: { "table:H": "full" } });
    });

    it("the Memento should evict the OLDEST documents beyond the cap", async () => {
        const memento = makeMemento();
        const provider = new MarkdownEditorProvider(makeContext(memento));
        vi.useFakeTimers();
        try {
            for (let i = 0; i < 101; i++) {
                vi.setSystemTime(1_000_000 + i * 1000);
                const doc = makeFakeTextDocument("x\n", vscode.Uri.file(`/project/n${i}.md`));
                const { handler } = await resolve(provider, doc);
                await handler({ type: "viewState", state: { scrollY: i } });
            }
        } finally {
            vi.useRealTimers();
        }
        const stored = memento.get("birta.viewState.v1") as Record<string, unknown>;
        expect(Object.keys(stored)).toHaveLength(100);
        expect(stored[vscode.Uri.file("/project/n0.md").toString()]).toBeUndefined();
        expect(stored[vscode.Uri.file("/project/n100.md").toString()]).toBeDefined();
    });

    it("an EMPTY bag should not be persisted", async () => {
        const memento = makeMemento();
        const provider = new MarkdownEditorProvider(makeContext(memento));
        const doc = makeFakeTextDocument("hello\n", vscode.Uri.file("/project/note.md"));
        const { handler } = await resolve(provider, doc);
        await handler({ type: "viewState", state: {} });
        expect(memento.update).not.toHaveBeenCalled();
    });

    it("a context WITHOUT workspaceState (older test stubs) should degrade to session scope, not throw", async () => {
        const provider = new MarkdownEditorProvider(makeContext());
        const doc = makeFakeTextDocument("hello\n", vscode.Uri.file("/project/note.md"));
        const first = await resolve(provider, doc);
        await first.handler({ type: "viewState", state: { scrollY: 7 } });
        const second = await resolve(provider, doc);
        await second.handler({ type: "ready" });
        expect(lastInit(second.panel)?.["viewState"]).toEqual({ scrollY: 7 });
    });
});
