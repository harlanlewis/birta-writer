import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { SuggestionProviders, type SuggestionHost } from "../suggestionProviders";

/**
 * The workspace file index that wikilink resolution and link-target
 * suggestions read. Above its cap it is a cut, and the cut has to be the
 * same on every open: `findFiles` with a `maxResults` keeps whichever files
 * the walk met first, in an order that is not stable between runs, so a
 * `[[Foo]]` could resolve on one open and dangle on the next (MAR-492's
 * shape, in the second place it lived).
 */
describe("getLinkFileIndex", () => {
    const findFiles = vscode.workspace.findFiles as unknown as ReturnType<typeof vi.fn>;
    const host: SuggestionHost = {
        workspaceRootFor: () => "/ws",
        imageUriMapFor: () => new Map(),
    };
    // Written here rather than read off the class: a test that takes its size
    // from the code under test enumerates nothing when that code has no such
    // constant, and then agrees with itself. Replayed against the pre-fix
    // provider, this file's first version passed that way.
    const cap = 2000;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("the cap this file enumerates past should be the one the index keeps", () => {
        expect(SuggestionProviders.LINK_FILE_CAP).toBe(cap);
    });

    function shuffled<T>(items: readonly T[], seed: number): T[] {
        const out = items.slice();
        let s = seed;
        for (let i = out.length - 1; i > 0; i--) {
            s = (s * 1103515245 + 12345) & 0x7fffffff;
            const j = s % (i + 1);
            [out[i], out[j]] = [out[j]!, out[i]!];
        }
        return out;
    }

    it("a workspace past the cap should keep the same files whatever order the walk lists them", async () => {
        const paths = Array.from({ length: cap + 300 }, (_, i) => `/ws/n${String(i).padStart(4, "0")}.md`);
        expect(paths.length).toBeGreaterThan(cap);
        const expected = paths.slice().sort().slice(0, cap);
        expect(expected).toHaveLength(cap);
        const seen: string[][] = [];
        for (const order of [paths, paths.slice().reverse(), shuffled(paths, 7)]) {
            findFiles.mockResolvedValueOnce(order.map((p) => vscode.Uri.file(p)));
            const index = await new SuggestionProviders(host).getLinkFileIndex();
            seen.push(index.map((u) => u.fsPath));
        }
        expect(seen).toHaveLength(3);
        expect(seen[0]).toEqual(expected);
        expect(seen[1]).toEqual(expected);
        expect(seen[2]).toEqual(expected);
    });

    it("the walk should be asked for everything, so the cut is the index's and not the walk's", async () => {
        findFiles.mockResolvedValueOnce([vscode.Uri.file("/ws/a.md")]);
        await new SuggestionProviders(host).getLinkFileIndex();
        expect(findFiles).toHaveBeenCalledTimes(1);
        expect(findFiles.mock.calls[0]).toHaveLength(2);
    });

    it("a workspace under the cap should keep every file", async () => {
        findFiles.mockResolvedValueOnce(["/ws/b.md", "/ws/a.md"].map((p) => vscode.Uri.file(p)));
        const index = await new SuggestionProviders(host).getLinkFileIndex();
        expect(index.map((u) => u.fsPath)).toEqual(["/ws/a.md", "/ws/b.md"]);
    });
});
