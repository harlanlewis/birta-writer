/**
 * Workspace-root resolution (MAR-216).
 *
 * Every `@/…` path in a document resolves against "the workspace folder that
 * owns this document". Six call sites used to answer that two different ways:
 * `vscode.workspace.getWorkspaceFolder`, and a hand-rolled
 * `workspaceFolders.find(f => fsPath.startsWith(f.fsPath + sep))`.
 *
 * They agree until one workspace folder is NESTED inside another — `.find`
 * returns the first folder that is a prefix, `getWorkspaceFolder` returns the
 * most specific one. With `/repo` and `/repo/docs` both open, a document in
 * `/repo/docs` resolved to `/repo` on some paths and `/repo/docs` on others,
 * so the same `@/img.png` pointed at two different files depending on which
 * code path asked.
 *
 * These drive the real handlers through the nested-folder configuration and
 * assert they agree.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
        subscriptions: [],
    }) as unknown as vscode.ExtensionContext;

/** `/repo` added BEFORE `/repo/docs`, so `.find` would pick `/repo`. */
function nestedMultiRoot(): void {
    vscode.workspace.workspaceFolders = [
        { uri: vscode.Uri.file("/repo") },
        { uri: vscode.Uri.file("/repo/docs") },
    ];
    (vscode.workspace.getWorkspaceFolder as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (uri: vscode.Uri) => {
            // The real API returns the MOST SPECIFIC containing folder.
            const matches = (vscode.workspace.workspaceFolders ?? []).filter((f) =>
                uri.fsPath.startsWith(f.uri.fsPath + "/"),
            );
            return matches.sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
        },
    );
}

describe("workspace-root resolution is consistent across call sites (MAR-216)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        nestedMultiRoot();
    });

    it("a document in a nested folder should resolve to the MOST SPECIFIC folder", () => {
        const provider = new MarkdownEditorProvider(makeContext());
        const doc = makeFakeTextDocument("body\n", vscode.Uri.file("/repo/docs/note.md"));

        const root = (provider as unknown as {
            _workspaceRootFor: (d: vscode.TextDocument) => string | undefined;
        })._workspaceRootFor(doc);

        // The hand-rolled `.find` would have returned "/repo" here — the first
        // folder that is a prefix — which is the whole bug.
        expect(root).toBe("/repo/docs");
    });

    it("no call site should hand-roll a second workspace-root algorithm", () => {
        // Once every site funnels through `_workspaceRootFor`, a WRONG root is
        // self-cancelling end-to-end: `_handleResolveLinkTarget` resolves the
        // absolute path and then relativises it against the same root, so the
        // reply is identical either way. That makes a behavioural test here
        // pass for the wrong reason — the only thing that can actually
        // regress is someone reintroducing the second algorithm, so that is
        // what this guards.
        const sources = ["MarkdownEditorProvider.ts", "webviewHtml.ts"].map((f) =>
            readFileSync(join(__dirname, "..", f), "utf8"),
        );
        for (const src of sources) {
            expect(
                src.match(/workspaceFolders\?\.find\(/g) ?? [],
                "use _workspaceRootFor — `.find` picks the FIRST prefix folder, not the most specific",
            ).toEqual([]);
        }
    });

    it("a document outside every workspace folder should fall back to the first", () => {
        const provider = new MarkdownEditorProvider(makeContext());
        const doc = makeFakeTextDocument("body\n", vscode.Uri.file("/elsewhere/note.md"));

        const root = (provider as unknown as {
            _workspaceRootFor: (d: vscode.TextDocument) => string | undefined;
        })._workspaceRootFor(doc);

        expect(root).toBe("/repo");
    });
});
