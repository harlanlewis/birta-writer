/**
 * VS Code's folder index producer over an in-memory folder: what an edge
 * resolves to, which references are left out, the cap, and the claim the
 * producer's header makes about its caches (a save re-reads one note, a
 * create or delete re-walks), counted rather than assumed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FOLDER_INDEX_CAP, FolderIndexer, isNotePath, type FolderIndexIo } from "../folderIndex";
import { backlinksOf } from "../../shared/folderIndex";

const ROOT = "/vault";

/** A folder as a path → text map; non-note files carry an empty string. */
function folder(files: Record<string, string>, opts: { outside?: string[]; smartLinks?: boolean } = {}) {
    const all = { ...files };
    const io = {
        listNotes: vi.fn(async (root: string, limit: number) =>
            Object.keys(all).filter((p) => p.startsWith(root + "/") && isNotePath(p)).slice(0, limit)),
        readText: vi.fn(async (fsPath: string) => all[fsPath] ?? null),
        fileIndex: vi.fn(async () => [...Object.keys(all), ...(opts.outside ?? [])]),
        smartLinks: () => opts.smartLinks ?? true,
    } satisfies FolderIndexIo;
    return { io, files: all };
}

describe("FolderIndexer: what an edge is", () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it("a markdown link, a wikilink and an OKF source should all be backlinks of the note they name", async () => {
        const { io } = folder({
            [`${ROOT}/b.md`]: "# B\n",
            [`${ROOT}/a.md`]: "See [b](b.md).\n",
            [`${ROOT}/sub/c.md`]: "As [[B]] says.\n",
            [`${ROOT}/d.md`]: "---\ntype: reference\nsources:\n  - resource: /b.md\n---\n\nBody.\n",
        });
        const index = await new FolderIndexer(io).indexFor(ROOT);
        expect(backlinksOf(index, "b.md").map((e) => [e.from, e.kind])).toEqual([
            ["a.md", "link"],
            ["d.md", "source"],
            ["sub/c.md", "wiki"],
        ]);
    });

    it("a reference to no file, or to a note outside the root, should be kept dangling", async () => {
        const { io } = folder({
            [`${ROOT}/a.md`]: "[[Nowhere]] and [out](../elsewhere/x.md)\n",
        }, { outside: ["/elsewhere/x.md"] });
        const index = await new FolderIndexer(io).indexFor(ROOT);
        expect(index.edges.map((e) => [e.target, e.to])).toEqual([
            ["Nowhere", null],
            ["../elsewhere/x.md", null],
        ]);
    });

    it("a reference that resolves to a file which is not a note should be left out", async () => {
        const { io } = folder({
            [`${ROOT}/a.md`]: "[diagram](img/d.png) and [[b]]\n",
            [`${ROOT}/img/d.png`]: "",
            [`${ROOT}/b.md`]: "",
        });
        const index = await new FolderIndexer(io).indexFor(ROOT);
        expect(index.edges.map((e) => e.target)).toEqual(["b"]);
    });

    it("a link should resolve the way a click does, extension inferred and fragment ignored", async () => {
        const { io } = folder({
            [`${ROOT}/notes/plan.md`]: "",
            [`${ROOT}/notes/a.md`]: "[p](plan#goals) [p2](./plan.md)\n",
        });
        const index = await new FolderIndexer(io).indexFor(ROOT);
        expect(index.edges.map((e) => e.to)).toEqual(["notes/plan.md", "notes/plan.md"]);
    });

    it("a node should be named by its frontmatter title, else by its file name", async () => {
        const { io } = folder({
            [`${ROOT}/titled.md`]: "---\ntitle: The Title\n---\n",
            [`${ROOT}/plain-name.md`]: "Nothing.\n",
        });
        const index = await new FolderIndexer(io).indexFor(ROOT);
        expect(index.nodes.map((n) => [n.path, n.name])).toEqual([
            ["plain-name.md", "plain-name"],
            ["titled.md", "The Title"],
        ]);
    });

    it("a note that cannot be read should still be a node, with no references", async () => {
        const { io } = folder({ [`${ROOT}/a.md`]: "[[b]]\n" });
        io.readText.mockResolvedValueOnce(null);
        const index = await new FolderIndexer(io).indexFor(ROOT);
        expect(index.nodes.map((n) => n.path)).toEqual(["a.md"]);
        expect(index.edges).toEqual([]);
    });
});

describe("FolderIndexer: the cap", () => {
    it("a folder holding exactly the cap should not be called truncated", async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < FOLDER_INDEX_CAP; i++) { files[`${ROOT}/n${i}.md`] = ""; }
        const index = await new FolderIndexer(folder(files).io).indexFor(ROOT);
        expect(index.nodes).toHaveLength(FOLDER_INDEX_CAP);
        expect(index.truncated).toBe(false);
    });

    it("a folder past the cap should index the cap and say it stopped", async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i <= FOLDER_INDEX_CAP; i++) { files[`${ROOT}/n${i}.md`] = ""; }
        const index = await new FolderIndexer(folder(files).io).indexFor(ROOT);
        expect(index.nodes).toHaveLength(FOLDER_INDEX_CAP);
        expect(index.truncated).toBe(true);
    });
});

describe("FolderIndexer: the caches", () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it("a second ask with nothing changed should read no file", async () => {
        const { io } = folder({ [`${ROOT}/a.md`]: "[[b]]\n", [`${ROOT}/b.md`]: "" });
        const indexer = new FolderIndexer(io);
        const first = await indexer.indexFor(ROOT);
        io.readText.mockClear();
        expect(await indexer.indexFor(ROOT)).toBe(first);
        expect(io.readText).not.toHaveBeenCalled();
    });

    it("two asks at once should walk and read once", async () => {
        const { io } = folder({ [`${ROOT}/a.md`]: "", [`${ROOT}/b.md`]: "" });
        const indexer = new FolderIndexer(io);
        await Promise.all([indexer.indexFor(ROOT), indexer.indexFor(ROOT)]);
        expect(io.listNotes).toHaveBeenCalledTimes(1);
        expect(io.readText).toHaveBeenCalledTimes(2);
    });

    it("a saved note should be re-read alone, and its new references indexed", async () => {
        const { io, files } = folder({ [`${ROOT}/a.md`]: "", [`${ROOT}/b.md`]: "" });
        const indexer = new FolderIndexer(io);
        await indexer.indexFor(ROOT);
        io.readText.mockClear();
        files[`${ROOT}/a.md`] = "[[b]]\n";
        expect(indexer.fileChanged(`${ROOT}/a.md`)).toBe(true);
        const index = await indexer.indexFor(ROOT);
        expect(io.readText.mock.calls.map((c) => c[0])).toEqual([`${ROOT}/a.md`]);
        expect(backlinksOf(index, "b.md").map((e) => e.from)).toEqual(["a.md"]);
        expect(io.listNotes).toHaveBeenCalledTimes(1);
    });

    it("a created note should make the folder walk again, and a dangling link resolve", async () => {
        const { io, files } = folder({ [`${ROOT}/a.md`]: "[[b]]\n" });
        const indexer = new FolderIndexer(io);
        expect((await indexer.indexFor(ROOT)).edges[0]!.to).toBeNull();
        files[`${ROOT}/b.md`] = "";
        expect(indexer.fileSetChanged(`${ROOT}/b.md`)).toBe(true);
        const index = await indexer.indexFor(ROOT);
        expect(index.edges[0]!.to).toBe("b.md");
        expect(io.listNotes).toHaveBeenCalledTimes(2);
    });

    it("a created file that is not a note should re-resolve the links that were waiting for it", async () => {
        // Missing, the image link is a dangling reference; present, it resolves
        // to a file that is not a note and leaves the note graph.
        const { io, files } = folder({ [`${ROOT}/a.md`]: "[d](img/d.png)\n" });
        const indexer = new FolderIndexer(io);
        expect((await indexer.indexFor(ROOT)).edges.map((e) => e.target)).toEqual(["img/d.png"]);
        files[`${ROOT}/img/d.png`] = "";
        expect(indexer.fileSetChanged(`${ROOT}/img/d.png`)).toBe(true);
        expect((await indexer.indexFor(ROOT)).edges).toEqual([]);
    });

    it("a note created in another indexed folder should re-resolve this folder's wikilinks", async () => {
        // [[Foo]] matches by name across the whole workspace, shortest path
        // first, so a Foo.md appearing in another folder takes the link.
        const { io, files } = folder({
            [`${ROOT}/a.md`]: "[[Foo]]\n",
            [`${ROOT}/deep/down/Foo.md`]: "",
            "/w2/other.md": "",
        });
        const indexer = new FolderIndexer(io);
        expect((await indexer.indexFor(ROOT)).edges[0]!.to).toBe("deep/down/Foo.md");
        await indexer.indexFor("/w2");
        files["/w2/Foo.md"] = "";
        expect(indexer.fileSetChanged("/w2/Foo.md")).toBe(true);
        expect((await indexer.indexFor(ROOT)).edges[0]!.to).toBeNull();
    });

    it("a folder should yield to the host between batches of fresh resolutions, and a save should keep every resolution already made", async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 500; i++) { files[`${ROOT}/n${i}.md`] = `[[n${(i + 1) % 500}]]\n`; }
        const { io } = folder(files);
        const yields = vi.fn(async () => {});
        const indexer = new FolderIndexer({ ...io, yieldToHost: yields });
        await indexer.indexFor(ROOT);
        expect(yields.mock.calls.length).toBeGreaterThanOrEqual(2);
        yields.mockClear();
        indexer.fileChanged(`${ROOT}/n0.md`);
        await indexer.indexFor(ROOT);
        expect(yields).not.toHaveBeenCalled();
    });

    it("a change outside every indexed root, or to a file that is not a note, should change nothing", async () => {
        const { io } = folder({ [`${ROOT}/a.md`]: "" });
        const indexer = new FolderIndexer(io);
        await indexer.indexFor(ROOT);
        expect(indexer.fileChanged("/other/x.md")).toBe(false);
        expect(indexer.fileChanged(`${ROOT}/image.png`)).toBe(false);
    });
});

describe("FolderIndexer.selfIn", () => {
    it("a document the index holds should be named by its root-relative path, and one it does not by null", async () => {
        const { io } = folder({ [`${ROOT}/dir/a.md`]: "" });
        const indexer = new FolderIndexer(io);
        const index = await indexer.indexFor(ROOT);
        expect(indexer.selfIn(ROOT, `${ROOT}/dir/a.md`, index)).toBe("dir/a.md");
        expect(indexer.selfIn(ROOT, `${ROOT}/dir/missing.md`, index)).toBeNull();
        expect(indexer.selfIn(ROOT, "/elsewhere/a.md", index)).toBeNull();
    });
});
