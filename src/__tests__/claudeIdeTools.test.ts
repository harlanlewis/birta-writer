/**
 * The IDE endpoint's tool semantics over a fake host: payload shapes (as
 * observed from the official server), the getLatestSelection cache, openFile
 * argument plumbing, and the openFile text-pattern selection resolver.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    buildIdeTools,
    resolveTextSelection,
    type IdeHost,
    type IdeSelectionPayload,
    type OpenFileArgs,
} from "../agentBridge/claudeIde/tools";
import type { McpTool } from "../agentBridge/claudeIde/protocol";

const SELECTION: IdeSelectionPayload = {
    text: "picked",
    filePath: "/w/doc.md",
    fileUrl: "file:///w/doc.md",
    selection: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 }, isEmpty: false },
};

function makeHost(overrides: Partial<IdeHost> = {}): IdeHost {
    return {
        getSelection: vi.fn(async () => SELECTION),
        listOpenEditors: vi.fn(() => []),
        workspaceFolders: vi.fn(() => ({ folders: [], rootPath: null })),
        openFile: vi.fn(async () => ({ success: true, message: "ok" })),
        documentDirty: vi.fn(() => null),
        saveDocument: vi.fn(async () => ({ success: true, message: "ok" })),
        diagnostics: vi.fn(() => []),
        ...overrides,
    };
}

function tool(tools: McpTool[], name: string): McpTool {
    const found = tools.find((t) => t.name === name);
    expect(found, name).toBeDefined();
    return found!;
}

describe("buildIdeTools", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("getCurrentSelection with an active editor should answer success plus the payload", async () => {
        const tools = buildIdeTools(makeHost());
        expect(await tool(tools, "getCurrentSelection").run({})).toEqual({
            success: true,
            ...SELECTION,
        });
    });

    it("getCurrentSelection without an active editor should answer the observed failure message", async () => {
        const tools = buildIdeTools(makeHost({ getSelection: vi.fn(async () => null) }));
        expect(await tool(tools, "getCurrentSelection").run({})).toEqual({
            success: false,
            message: "No active editor found",
        });
    });

    it("getLatestSelection should fall back to the last observed selection when the editor went away", async () => {
        const getSelection = vi
            .fn<[], Promise<IdeSelectionPayload | null>>()
            .mockResolvedValueOnce(SELECTION)
            .mockResolvedValue(null);
        const tools = buildIdeTools(makeHost({ getSelection }));
        await tool(tools, "getCurrentSelection").run({}); // seeds the cache
        expect(await tool(tools, "getLatestSelection").run({})).toEqual(SELECTION);
    });

    it("getLatestSelection with nothing ever selected should answer the observed failure message", async () => {
        const tools = buildIdeTools(makeHost({ getSelection: vi.fn(async () => null) }));
        expect(await tool(tools, "getLatestSelection").run({})).toEqual({
            success: false,
            message: "No selection available",
        });
    });

    it("openFile should default makeFrontmost true and pass patterns through", async () => {
        const openFile = vi.fn(async (_args: OpenFileArgs) => ({ success: true, message: "ok" }));
        const tools = buildIdeTools(makeHost({ openFile }));
        await tool(tools, "openFile").run({ filePath: "/w/doc.md", startText: "abc" });
        expect(openFile).toHaveBeenCalledWith({
            filePath: "/w/doc.md",
            preview: false,
            startText: "abc",
            endText: undefined,
            selectToEndOfLine: false,
            makeFrontmost: true,
        });
    });

    it("openFile without a filePath should fail without touching the host", async () => {
        const host = makeHost();
        const tools = buildIdeTools(host);
        expect(await tool(tools, "openFile").run({})).toEqual({
            success: false,
            message: "filePath is required",
        });
        expect(host.openFile).not.toHaveBeenCalled();
    });

    it("checkDocumentDirty for an unopened document should fail with the path named", async () => {
        const tools = buildIdeTools(makeHost());
        expect(await tool(tools, "checkDocumentDirty").run({ filePath: "/w/a.md" })).toEqual({
            success: false,
            message: "Document not open: /w/a.md",
        });
    });

    it("checkDocumentDirty for an open document should answer the observed shape", async () => {
        const tools = buildIdeTools(
            makeHost({ documentDirty: vi.fn(() => ({ isDirty: true, isUntitled: false })) }),
        );
        expect(await tool(tools, "checkDocumentDirty").run({ filePath: "/w/a.md" })).toEqual({
            success: true,
            filePath: "/w/a.md",
            isDirty: true,
            isUntitled: false,
        });
    });

    it("getWorkspaceFolders should answer the observed envelope", async () => {
        const folders = [{ name: "w", uri: "file:///w", path: "/w", index: 0 }];
        const tools = buildIdeTools(
            makeHost({ workspaceFolders: vi.fn(() => ({ folders, rootPath: "/w" })) }),
        );
        expect(await tool(tools, "getWorkspaceFolders").run({})).toEqual({
            success: true,
            folders,
            rootPath: "/w",
            workspaceFile: null,
        });
    });
});

describe("resolveTextSelection", () => {
    const TEXT = "alpha beta\ngamma delta\nepsilon zeta\n";

    it("no startText should resolve null", () => {
        expect(resolveTextSelection(TEXT, { selectToEndOfLine: false })).toBeNull();
    });

    it("an unmatched startText should resolve null", () => {
        expect(
            resolveTextSelection(TEXT, { startText: "missing", selectToEndOfLine: false }),
        ).toBeNull();
    });

    it("startText alone should select exactly its first match", () => {
        expect(resolveTextSelection(TEXT, { startText: "gamma", selectToEndOfLine: false })).toEqual({
            start: { line: 1, character: 0 },
            end: { line: 1, character: 5 },
        });
    });

    it("endText should extend the selection to the end of its match on a later line", () => {
        expect(
            resolveTextSelection(TEXT, {
                startText: "beta",
                endText: "epsilon",
                selectToEndOfLine: false,
            }),
        ).toEqual({ start: { line: 0, character: 6 }, end: { line: 2, character: 7 } });
    });

    it("an unmatched endText should fall back to the startText match", () => {
        expect(
            resolveTextSelection(TEXT, {
                startText: "gamma",
                endText: "missing",
                selectToEndOfLine: false,
            }),
        ).toEqual({ start: { line: 1, character: 0 }, end: { line: 1, character: 5 } });
    });

    it("selectToEndOfLine should extend the end to its line end", () => {
        expect(resolveTextSelection(TEXT, { startText: "gamma", selectToEndOfLine: true })).toEqual({
            start: { line: 1, character: 0 },
            end: { line: 1, character: 11 },
        });
    });
});
