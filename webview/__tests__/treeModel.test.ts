/**
 * The file explorer's tree model (components/fileExplorer/treeModel.ts): what
 * it asks the host to list and what rows it draws, with no DOM. The invariant
 * the panel's cost rests on is here: listings are requested for expanded
 * folders and nothing else, and the dotfile switch never triggers one.
 */
import { describe, it, expect } from "vitest";
import { ancestorsOf, createTreeModel, parentPath } from "../components/fileExplorer/treeModel";
import type { ProjectEntry } from "../../shared/messages";

const dir = (name: string, hidden = false): ProjectEntry => ({ name, kind: "dir", openable: true, hidden });
const file = (name: string, openable = true, hidden = false): ProjectEntry => ({ name, kind: "file", openable, hidden });

describe("sortEntries", () => {
    it("folders should come first, then names in natural, case-insensitive order", () => {
        const model = createTreeModel();
        const sorted = model.sortEntries([
            file("zeta.md"), file("Chapter 10.md"), dir("src"), file("chapter 2.md"),
            dir("Assets"), file("alpha.md"), file("chapter 1.md"),
        ]);
        expect(sorted.map((e) => e.name)).toEqual([
            "Assets", "src",
            "alpha.md", "chapter 1.md", "chapter 2.md", "Chapter 10.md", "zeta.md",
        ]);
    });
});

describe("paths", () => {
    it("parentPath should climb to the root and stop", () => {
        expect(parentPath("a/b/c")).toBe("a/b");
        expect(parentPath("a")).toBe("");
        expect(parentPath("")).toBeNull();
    });

    it("ancestorsOf should list every proper ancestor, root first", () => {
        expect(ancestorsOf("a/b/c.md")).toEqual(["", "a", "a/b"]);
        expect(ancestorsOf("top.md")).toEqual([""]);
    });
});

describe("visibleRows", () => {
    it("an unlisted root should be one loading row", () => {
        const model = createTreeModel();
        const rows = model.visibleRows(false);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: "loading", path: "", level: 1 });
    });

    it("a collapsed folder should contribute its own row and none of its children", () => {
        const model = createTreeModel();
        model.applyListing("", [dir("docs"), file("readme.md")]);
        model.applyListing("docs", [file("a.md")]);
        expect(model.visibleRows(false).map((r) => r.path)).toEqual(["docs", "readme.md"]);
    });

    it("expanding a folder should interleave its children, indented one level", () => {
        const model = createTreeModel();
        model.applyListing("", [dir("docs"), file("readme.md")]);
        model.applyListing("docs", [dir("deep"), file("a.md")]);
        model.applyListing("docs/deep", [file("z.md")]);
        model.expand("docs");
        model.expand("docs/deep");
        const rows = model.visibleRows(false);
        expect(rows.map((r) => [r.path, r.level])).toEqual([
            ["docs", 1], ["docs/deep", 2], ["docs/deep/z.md", 3], ["docs/a.md", 2], ["readme.md", 1],
        ]);
    });

    it("collapsing an ancestor should hide every descendant, an expanded grandchild included", () => {
        const model = createTreeModel();
        model.applyListing("", [dir("docs")]);
        model.applyListing("docs", [dir("deep")]);
        model.applyListing("docs/deep", [file("z.md")]);
        model.expand("docs");
        model.expand("docs/deep");
        expect(model.visibleRows(false)).toHaveLength(3);
        model.collapse("docs");
        expect(model.visibleRows(false).map((r) => r.path)).toEqual(["docs"]);
        // The grandchild's own state survives: reopening the parent shows it open.
        model.expand("docs");
        expect(model.visibleRows(false).map((r) => r.path)).toEqual(["docs", "docs/deep", "docs/deep/z.md"]);
    });

    it("an expanded folder with no listing should show a loading row under itself", () => {
        const model = createTreeModel();
        model.applyListing("", [dir("docs")]);
        model.expand("docs");
        const rows = model.visibleRows(false);
        expect(rows.map((r) => r.kind)).toEqual(["dir", "loading"]);
        expect(rows[1]!.level).toBe(2);
    });

    it("a folder the host could not read should show its error as a row", () => {
        const model = createTreeModel();
        model.applyListing("", [dir("locked")]);
        model.expand("locked");
        model.setError("locked", "Permission denied");
        const rows = model.visibleRows(false);
        expect(rows[1]).toMatchObject({ kind: "error", path: "locked", message: "Permission denied" });
    });

    it("the hidden switch should flip concealment on the same rows with no listing touched", () => {
        const model = createTreeModel();
        model.applyListing("", [dir(".git", true), file(".env", true, true), file("readme.md")]);
        model.applyListing(".git", [file("HEAD")]);
        model.expand(".git");
        const before = model.listedPaths();

        const off = model.visibleRows(false);
        const on = model.visibleRows(true);

        expect(off.map((r) => r.path)).toEqual(on.map((r) => r.path));
        expect(off.filter((r) => r.concealed).map((r) => r.path)).toEqual([".git", ".git/HEAD", ".env"]);
        expect(on.filter((r) => r.concealed)).toEqual([]);
        // A child of a hidden folder is hidden by descent, not by its own flag.
        expect(on.find((r) => r.path === ".git/HEAD")!.hidden).toBe(true);
        expect(model.listedPaths()).toEqual(before);
    });

    it("a non-openable file should keep openable false; a folder is always openable", () => {
        const model = createTreeModel();
        model.applyListing("", [dir("d"), file("notes.txt", false), file("a.md")]);
        const byPath = new Map(model.visibleRows(false).map((r) => [r.path, r.openable]));
        expect(byPath.get("notes.txt")).toBe(false);
        expect(byPath.get("a.md")).toBe(true);
        expect(byPath.get("d")).toBe(true);
    });
});

describe("what needs listing", () => {
    it("expand should name the folder exactly when it holds no listing", () => {
        const model = createTreeModel();
        expect(model.expand("docs")).toEqual(["docs"]);
        model.applyListing("docs", []);
        model.collapse("docs");
        expect(model.expand("docs")).toEqual([]);
    });

    it("toggle should collapse an open folder and ask for nothing", () => {
        const model = createTreeModel();
        model.expand("docs");
        expect(model.toggle("docs")).toEqual([]);
        expect(model.isExpanded("docs")).toBe(false);
        expect(model.toggle("docs")).toEqual(["docs"]);
    });

    it("revealPath should open every ancestor and name the unlisted ones root first", () => {
        const model = createTreeModel();
        model.applyListing("", [dir("a")]);
        expect(model.revealPath("a/b/c/file.md")).toEqual(["a", "a/b", "a/b/c"]);
        expect(["a", "a/b", "a/b/c"].every((p) => model.isExpanded(p))).toBe(true);
        // Asked again once the first two answered: only what is still missing.
        model.applyListing("a", [dir("b")]);
        model.applyListing("a/b", [dir("c")]);
        expect(model.revealPath("a/b/c/file.md")).toEqual(["a/b/c"]);
    });

    it("invalidate should drop a listing so the folder is asked for again when opened", () => {
        const model = createTreeModel();
        model.applyListing("docs", [file("a.md")]);
        model.invalidate("docs");
        expect(model.listing("docs")).toBeUndefined();
        expect(model.expand("docs")).toEqual(["docs"]);
    });

    /**
     * The cost invariant, over a generated tree rather than a hand-picked
     * one: however the folders are opened, the folders that need a listing
     * are exactly the open ones without one, so a listing is never asked for
     * a folder nobody can see into. The enumeration asserts its own size.
     */
    it("the folders needing a listing should be exactly the expanded ones without one", () => {
        const model = createTreeModel();
        // Three levels, three folders each: 3 + 9 + 27 folders, plus the root.
        const folders: string[] = [];
        const listingOf = (dirPath: string): ProjectEntry[] => {
            const depth = dirPath === "" ? 0 : dirPath.split("/").length;
            if (depth >= 3) { return [file("leaf.md")]; }
            return ["x", "y", "z"].map((n) => dir(n));
        };
        const walk = (dirPath: string): void => {
            for (const e of listingOf(dirPath)) {
                if (e.kind !== "dir") { continue; }
                const p = dirPath === "" ? e.name : `${dirPath}/${e.name}`;
                folders.push(p);
                walk(p);
            }
        };
        walk("");
        expect(folders).toHaveLength(39);

        // Open every third folder; list the root and every second opened one.
        const opened = folders.filter((_, i) => i % 3 === 0);
        for (const p of opened) { model.expand(p); }
        model.applyListing("", listingOf(""));
        const listed = opened.filter((_, i) => i % 2 === 0);
        for (const p of listed) { model.applyListing(p, listingOf(p)); }

        const needing = folders.filter((p) => model.needsListing(p));
        const expected = opened.filter((p) => !listed.includes(p));
        expect(expected.length).toBeGreaterThan(3);
        expect(needing.sort()).toEqual(expected.sort());
        // A closed folder never needs one, whatever it holds.
        for (const p of folders.filter((p) => !opened.includes(p))) {
            expect(model.needsListing(p), p).toBe(false);
        }
        // And the rows drawn only ever descend into expanded, listed folders.
        const rows = model.visibleRows(true);
        for (const row of rows) {
            const parent = parentPath(row.path);
            if (parent !== null && parent !== "" && (row.kind === "dir" || row.kind === "file")) {
                expect(model.isExpanded(parent), row.path).toBe(true);
                expect(model.listing(parent)?.kind, row.path).toBe("ready");
            }
        }
        expect(rows.length).toBeGreaterThan(3);
    });
});
