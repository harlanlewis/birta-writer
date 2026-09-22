import { describe, it, expect } from "vitest";
import { backlinksOf, relativeNotePath, type FolderIndex } from "../folderIndex";

const edge = (from: string, to: string | null) => ({ from, to, target: to ?? "x", kind: "link" as const, text: "", line: 1 });

describe("backlinksOf", () => {
    it("only references resolving to the note should count, and a note naming itself should not", () => {
        const index: FolderIndex = {
            rootName: "v",
            nodes: [],
            truncated: false,
            edges: [edge("a.md", "b.md"), edge("b.md", "b.md"), edge("c.md", null), edge("d.md", "e.md"), edge("f.md", "b.md")],
        };
        expect(backlinksOf(index, "b.md").map((e) => e.from)).toEqual(["a.md", "f.md"]);
    });
});

describe("relativeNotePath", () => {
    it("a sibling should be reached from the note's own directory", () => {
        expect(relativeNotePath("a.md", "b.md")).toBe("./b.md");
        expect(relativeNotePath("dir/a.md", "dir/b.md")).toBe("./b.md");
    });

    it("a note elsewhere should be reached by climbing to the shared directory", () => {
        expect(relativeNotePath("x/y/a.md", "x/z/b.md")).toBe("../z/b.md");
        expect(relativeNotePath("x/a.md", "b.md")).toBe("../b.md");
        expect(relativeNotePath("a.md", "x/y/b.md")).toBe("./x/y/b.md");
    });

    it("a directory and a file sharing a name should not be mistaken for each other", () => {
        expect(relativeNotePath("notes/a.md", "notes.md")).toBe("../notes.md");
        expect(relativeNotePath("notes.md", "notes/a.md")).toBe("./notes/a.md");
        // The same NAME as a directory and as the target note: the target's
        // last segment is a file, never a directory the two paths share.
        expect(relativeNotePath("x.md/inner.md", "x.md")).toBe("../x.md");
    });
});
