/**
 * Workspace-index cache invalidation (MAR-208).
 *
 * Two provider caches answer "what files exist in this workspace": the link
 * target index (`**\/*`, 10s TTL) behind link autocomplete, and the frontmatter
 * value scan (`**\/*.md`, 30s TTL) behind the frontmatter "+" menu. Neither key
 * captured the on-disk file set, so a file created a moment ago did not
 * autocomplete and a deleted one kept being offered for the whole TTL window.
 *
 * A `**\/*` watcher now clears them on create/delete (which is also what a
 * rename fires). These tests assert the OBSERVABLE a user would lose — the
 * suggestions actually posted back to the webview — rather than the private
 * cache fields, and drive the real message handlers throughout.
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

/** The `invalidate` listeners the provider registered on its `**\/*` watcher. */
function watcherListeners(): {
    create: (uri: vscode.Uri) => void;
    remove: (uri: vscode.Uri) => void;
} {
    const watcher = (vscode.workspace.createFileSystemWatcher as unknown as ReturnType<typeof vi.fn>)
        .mock.results.at(-1)?.value;
    return {
        create: watcher.onDidCreate.mock.calls[0][0],
        remove: watcher.onDidDelete.mock.calls[0][0],
    };
}

const findFiles = vscode.workspace.findFiles as unknown as ReturnType<typeof vi.fn>;

/** Drive the real link-target-suggestion handler and return the posted paths. */
async function askLinkTargets(
    provider: MarkdownEditorProvider,
    panel: ReturnType<typeof makePanel>,
    doc: vscode.TextDocument,
    query: string,
): Promise<string> {
    panel.webview.postMessage.mockClear();
    await (provider as unknown as {
        _handleGetLinkTargetSuggestions: (
            d: vscode.TextDocument,
            p: unknown,
            id: string,
            q: string,
        ) => Promise<void>;
    })._handleGetLinkTargetSuggestions(doc, panel, "1", query);
    return JSON.stringify(panel.webview.postMessage.mock.calls.at(-1)?.[0] ?? {});
}

/** Drive the real frontmatter-suggestion handler. */
async function askFmSuggestions(
    provider: MarkdownEditorProvider,
    panel: ReturnType<typeof makePanel>,
    doc: vscode.TextDocument,
    key: string,
): Promise<void> {
    await (provider as unknown as {
        _handleRequestFmSuggestions: (
            d: vscode.TextDocument,
            p: unknown,
            k: string,
        ) => Promise<void>;
    })._handleRequestFmSuggestions(doc, panel, key);
}

describe("workspace index caches invalidate on file create/delete (MAR-208)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file("/ws") }];
    });

    it("a file created after the first lookup should appear in link suggestions immediately", async () => {
        findFiles.mockResolvedValue([vscode.Uri.file("/ws/keep.md")]);
        const provider = new MarkdownEditorProvider(makeContext());
        const panel = makePanel();
        const doc = makeFakeTextDocument("body\n", vscode.Uri.file("/ws/note.md"));

        // Prime the cache, then confirm a second lookup is served from it.
        await askLinkTargets(provider, panel, doc, "keep");
        const callsAfterPriming = findFiles.mock.calls.length;
        await askLinkTargets(provider, panel, doc, "keep");
        expect(findFiles.mock.calls.length).toBe(callsAfterPriming);

        // A new file lands on disk. Before MAR-208 it stayed invisible to
        // autocomplete for the whole 10s TTL.
        findFiles.mockResolvedValue([
            vscode.Uri.file("/ws/keep.md"),
            vscode.Uri.file("/ws/brand-new.md"),
        ]);
        watcherListeners().create(vscode.Uri.file("/ws/brand-new.md"));

        expect(await askLinkTargets(provider, panel, doc, "brand-new")).toContain("brand-new");
    });

    it("a deleted file should stop being offered on the next lookup", async () => {
        findFiles.mockResolvedValue([
            vscode.Uri.file("/ws/keep.md"),
            vscode.Uri.file("/ws/doomed.md"),
        ]);
        const provider = new MarkdownEditorProvider(makeContext());
        const panel = makePanel();
        const doc = makeFakeTextDocument("body\n", vscode.Uri.file("/ws/note.md"));

        expect(await askLinkTargets(provider, panel, doc, "doomed")).toContain("doomed");

        findFiles.mockResolvedValue([vscode.Uri.file("/ws/keep.md")]);
        watcherListeners().remove(vscode.Uri.file("/ws/doomed.md"));

        expect(await askLinkTargets(provider, panel, doc, "doomed")).not.toContain("doomed");
    });

    it("a non-markdown file event should not throw away the frontmatter scan", async () => {
        // The frontmatter scan is a 500-file read; only a `.md` create/delete can
        // change its answer, so an image or config file landing must not cost it.
        findFiles.mockResolvedValue([]);
        const provider = new MarkdownEditorProvider(makeContext());
        const cacheSlot = (): unknown =>
            (provider as unknown as { _fmScanCache: unknown })._fmScanCache;

        (provider as unknown as { _fmScanCache: unknown })._fmScanCache = {
            perFile: new Map(),
            expires: Date.now() + 30_000,
        };

        watcherListeners().create(vscode.Uri.file("/ws/photo.png"));
        expect(cacheSlot()).toBeDefined();

        watcherListeners().create(vscode.Uri.file("/ws/added.md"));
        expect(cacheSlot()).toBeUndefined();
    });

    it("an .mdx file event should invalidate the frontmatter scan too", async () => {
        // The scan reads `.mdx` because MDX is built from markdown's presets,
        // so its `---` block IS front matter. The glob and this predicate are
        // two halves of one fact, and `.mdx` is where they came apart: it does
        // NOT end with `.md`, so a scan that collected MDX files while the
        // watcher ignored them would serve stale suggestions for a whole TTL
        // window (MAR-350).
        findFiles.mockResolvedValue([]);
        const provider = new MarkdownEditorProvider(makeContext());
        const cacheSlot = (): unknown =>
            (provider as unknown as { _fmScanCache: unknown })._fmScanCache;
        const seedCache = (): void => {
            (provider as unknown as { _fmScanCache: unknown })._fmScanCache = {
                perFile: new Map(),
                expires: Date.now() + 30_000,
            };
        };

        seedCache();
        watcherListeners().create(vscode.Uri.file("/ws/page.mdx"));
        expect(cacheSlot(), "an .mdx create must clear it").toBeUndefined();

        seedCache();
        watcherListeners().remove(vscode.Uri.file("/ws/page.mdx"));
        expect(cacheSlot(), "an .mdx delete must clear it").toBeUndefined();

        // And the near miss stays a miss: `.mdxyz` is not a scanned extension,
        // so a prefix test rather than an extension test would wrongly fire.
        seedCache();
        watcherListeners().create(vscode.Uri.file("/ws/notes.mdxyz"));
        expect(cacheSlot(), "an unscanned extension must not clear it").toBeDefined();
    });

    it("the frontmatter scan should collect both markdown extensions", async () => {
        // Pins the GLOB half. Asserting the argument is the only way to see it:
        // the scan's answer over a mocked-empty workspace is the same whichever
        // glob it passed, so an observable-only test cannot tell them apart.
        findFiles.mockResolvedValue([]);
        const provider = new MarkdownEditorProvider(makeContext());
        const panel = makePanel();
        const doc = makeFakeTextDocument("---\ntags: [a]\n---\n", vscode.Uri.file("/ws/note.md"));

        await askFmSuggestions(provider, panel, doc, "tags");

        const globs = findFiles.mock.calls.map(([glob]) => glob);
        expect(globs, JSON.stringify(globs)).toContain("**/*.{md,mdx}");
    });

    it("the watcher and its listeners should be disposed with the extension", async () => {
        const context = makeContext();
        new MarkdownEditorProvider(context);
        // The watcher plus both listener subscriptions.
        expect(context.subscriptions.length).toBeGreaterThanOrEqual(3);
        for (const sub of context.subscriptions) {
            expect(typeof sub.dispose).toBe("function");
        }
    });
});
