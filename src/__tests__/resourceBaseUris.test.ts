/**
 * The bases a relative resource URL in rendered raw HTML resolves against.
 *
 * The trailing slash is the whole contract: `new URL("images/a.png", base)`
 * drops the base's last segment without one, so a missing slash resolves every
 * image into the document's PARENT directory and fails quietly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { getResourceBaseUris } from "../webviewHtml";

/**
 * A webview whose asWebviewUri has the real one's shape: a host that is not
 * the document's, and the file path carried through as the URL path.
 */
const HOST = "https://resource.example";
function fakeWebview(): vscode.Webview {
    return {
        asWebviewUri: (uri: vscode.Uri) => vscode.Uri.parse(`${HOST}${uri.path}`),
    } as unknown as vscode.Webview;
}

describe("getResourceBaseUris", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined);
    });

    it("a file document should give its own directory, slash-terminated", () => {
        const { resourceBaseUri } = getResourceBaseUris(
            fakeWebview(),
            vscode.Uri.file("/Users/x/notes/post.md"),
        );

        expect(resourceBaseUri).toBe(`${HOST}/Users/x/notes/`);
        expect(new URL("images/cats.jpeg", resourceBaseUri).toString()).toBe(
            `${HOST}/Users/x/notes/images/cats.jpeg`,
        );
    });

    it("a document in a workspace should give that root as the @/ base", () => {
        vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue({
            uri: vscode.Uri.file("/Users/x"),
        } as never);

        const { resourceBaseUri, workspaceBaseUri } = getResourceBaseUris(
            fakeWebview(),
            vscode.Uri.file("/Users/x/notes/post.md"),
        );

        expect(resourceBaseUri).toBe(`${HOST}/Users/x/notes/`);
        expect(workspaceBaseUri).toBe(`${HOST}/Users/x/`);
    });

    it("a document outside any workspace should fall back to its own directory", () => {
        const { resourceBaseUri, workspaceBaseUri } = getResourceBaseUris(
            fakeWebview(),
            vscode.Uri.file("/tmp/scratch/post.md"),
        );

        expect(workspaceBaseUri).toBe(resourceBaseUri);
    });

    it("a document with no directory should give no base at all", () => {
        const { resourceBaseUri, workspaceBaseUri } = getResourceBaseUris(
            fakeWebview(),
            vscode.Uri.parse("untitled:Untitled-1"),
        );

        expect(resourceBaseUri).toBe("");
        expect(workspaceBaseUri).toBe("");
    });
});
