/**
 * linkResolver: the smart chain that lets links written for a site generator
 * resolve while editing — workspace-root paths, ancestor content roots (the
 * Hugo case), markdown suffix inference, index fallback — plus wikilink
 * target resolution. Pure: IO is a fake over a Set of paths.
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import {
    resolveLinkPath,
    resolveWikiTarget,
    type ResolveContext,
    type ResolverIo,
} from "../utils/linkResolver";

/** Fake IO over a fixed set of existing files (absolute posix-style paths). */
function makeIo(files: string[]): ResolverIo {
    const set = new Set(files.map((f) => path.normalize(f)));
    return {
        isFile: async (p) => set.has(path.normalize(p)),
        getFileIndex: async () => [...set],
    };
}

const ROOT = path.normalize("/repo");
const HUGO_DOC = path.join(ROOT, "content", "write", "ai-playbook", "index.md");

function ctx(overrides: Partial<ResolveContext> = {}): ResolveContext {
    return {
        docFsPath: HUGO_DOC,
        workspaceRootFsPath: ROOT,
        smartLinks: true,
        ...overrides,
    };
}

describe("resolveLinkPath — smart mode", () => {
    it("resolves the Hugo case: /write/uber → content/write/uber/index.md via the ancestor walk", async () => {
        const target = path.join(ROOT, "content", "write", "uber", "index.md");
        const io = makeIo([HUGO_DOC, target]);
        expect(await resolveLinkPath("/write/uber", ctx(), io)).toBe(target);
    });

    it("prefers the workspace root over an ancestor when both match (VS Code convention)", async () => {
        const atRoot = path.join(ROOT, "write", "uber.md");
        const atContent = path.join(ROOT, "content", "write", "uber", "index.md");
        const io = makeIo([HUGO_DOC, atRoot, atContent]);
        expect(await resolveLinkPath("/write/uber", ctx(), io)).toBe(atRoot);
    });

    it("resolves a document-relative link exactly, before any inference", async () => {
        const sibling = path.join(ROOT, "content", "write", "ai-playbook", "notes.md");
        const io = makeIo([HUGO_DOC, sibling]);
        expect(await resolveLinkPath("notes.md", ctx(), io)).toBe(sibling);
        expect(await resolveLinkPath("./notes.md", ctx(), io)).toBe(sibling);
    });

    it("infers .md and .markdown suffixes on a relative link", async () => {
        const md = path.join(ROOT, "content", "write", "ai-playbook", "notes.md");
        const io = makeIo([HUGO_DOC, md]);
        expect(await resolveLinkPath("notes", ctx(), io)).toBe(md);

        const markdown = path.join(ROOT, "content", "write", "ai-playbook", "other.markdown");
        const io2 = makeIo([HUGO_DOC, markdown]);
        expect(await resolveLinkPath("other", ctx(), io2)).toBe(markdown);
    });

    it("infers index.md and _index.md for directory links", async () => {
        const index = path.join(ROOT, "content", "write", "uber", "index.md");
        const io = makeIo([HUGO_DOC, index]);
        expect(await resolveLinkPath("../uber", ctx(), io)).toBe(index);

        const under = path.join(ROOT, "content", "write", "_index.md");
        const io2 = makeIo([HUGO_DOC, under]);
        expect(await resolveLinkPath("/write", ctx(), io2)).toBe(under);
    });

    it("treats a trailing slash as a directory link preferring index files", async () => {
        const index = path.join(ROOT, "content", "write", "uber", "index.md");
        const io = makeIo([HUGO_DOC, index]);
        expect(await resolveLinkPath("/write/uber/", ctx(), io)).toBe(index);
    });

    it("percent-decodes when the literal path is missing", async () => {
        const spaced = path.join(ROOT, "content", "write", "ai-playbook", "my notes.md");
        const io = makeIo([HUGO_DOC, spaced]);
        expect(await resolveLinkPath("my%20notes.md", ctx(), io)).toBe(spaced);
    });

    it("prefers a literally-percent-named file over the decoded form", async () => {
        const literal = path.join(ROOT, "content", "write", "ai-playbook", "my%20notes.md");
        const decoded = path.join(ROOT, "content", "write", "ai-playbook", "my notes.md");
        const io = makeIo([HUGO_DOC, literal, decoded]);
        expect(await resolveLinkPath("my%20notes.md", ctx(), io)).toBe(literal);
    });

    it("keeps @/ as workspace-root-relative, with suffix inference", async () => {
        const target = path.join(ROOT, "docs", "guide.md");
        const io = makeIo([HUGO_DOC, target]);
        expect(await resolveLinkPath("@/docs/guide.md", ctx(), io)).toBe(target);
        expect(await resolveLinkPath("@/docs/guide", ctx(), io)).toBe(target);
    });

    it("falls back to an index suffix match anywhere in the workspace", async () => {
        // Link written against a published URL structure that matches no
        // ancestor: only the index fallback can catch it.
        const doc = path.join(ROOT, "notes", "scratch.md");
        const target = path.join(ROOT, "site", "content", "write", "uber", "index.md");
        const io = makeIo([doc, target]);
        expect(
            await resolveLinkPath("/write/uber", ctx({ docFsPath: doc }), io),
        ).toBe(target);
    });

    it("index fallback strips leading ../ segments", async () => {
        const doc = path.join(ROOT, "a", "deep", "doc.md");
        const target = path.join(ROOT, "elsewhere", "guide.md");
        const io = makeIo([doc, target]);
        expect(
            await resolveLinkPath("../missing/elsewhere/guide.md", ctx({ docFsPath: doc }), io),
        ).toBe(null); // tail "missing/elsewhere/guide.md" matches nothing
        expect(
            await resolveLinkPath("../elsewhere/guide.md", ctx({ docFsPath: doc }), io),
        ).toBe(target); // exact relative already misses; tail matches
    });

    it("tiebreaks index-fallback matches: shortest path, then closest to the document", async () => {
        const doc = path.join(ROOT, "b", "doc.md");
        const shorter = path.join(ROOT, "x", "guide.md");
        const longer = path.join(ROOT, "deeply", "nested", "x", "guide.md");
        const io = makeIo([doc, shorter, longer]);
        expect(await resolveLinkPath("/x/guide", ctx({ docFsPath: doc }), io)).toBe(shorter);

        const inB = path.join(ROOT, "b", "y", "g.md");
        const inC = path.join(ROOT, "c", "y", "g.md");
        const io2 = makeIo([doc, inB, inC]);
        expect(await resolveLinkPath("/y/g", ctx({ docFsPath: doc }), io2)).toBe(inB);
    });

    it("never walks ancestors outside the workspace root", async () => {
        // Doc lives OUTSIDE the workspace: /write/foo must not resolve via
        // the doc's real filesystem ancestors (that walk leads toward `/`,
        // the exact bug the resolver exists to fix). The file EXISTS on disk
        // but — being outside the workspace — is not in the findFiles index.
        const doc = path.normalize("/Users/someone/notes/doc.md");
        const escaped = path.normalize("/Users/someone/write/foo.md");
        const onDisk = new Set([doc, escaped]);
        const io: ResolverIo = {
            isFile: async (p) => onDisk.has(path.normalize(p)),
            getFileIndex: async () => [], // workspace index never sees it
        };
        expect(
            await resolveLinkPath("/write/foo", ctx({ docFsPath: doc }), io),
        ).toBe(null);
    });

    it("returns null when nothing matches", async () => {
        const io = makeIo([HUGO_DOC]);
        expect(await resolveLinkPath("/write/nonexistent", ctx(), io)).toBe(null);
    });
});

describe("resolveLinkPath — Notion export ids", () => {
    const DIR = path.join(ROOT, "content", "write", "ai-playbook");
    // A Notion export's own bytes: `%20`-encoded, 32 lowercase hex on the file
    // and on the folder above it.
    const EXPORTED = "Room%201%207a6f70896bfc4e5e976d588412b74370.md";
    const EXPORTED_NESTED =
        "Private%20%26%20Shared%2019b8ecd8a5b3800c8c19c98b45c56de8/" + EXPORTED;

    it("an intact export resolves to the file that still carries its id", async () => {
        const target = path.join(DIR, "Room 1 7a6f70896bfc4e5e976d588412b74370.md");
        const io = makeIo([HUGO_DOC, target]);
        expect(await resolveLinkPath(EXPORTED, ctx(), io)).toBe(target);
    });

    it("a link whose file was renamed without its id resolves to the cleaned name", async () => {
        const target = path.join(DIR, "Room 1.md");
        const io = makeIo([HUGO_DOC, target]);
        expect(await resolveLinkPath(EXPORTED, ctx(), io)).toBe(target);
    });

    it("strips the id from a folder segment too, not just the filename", async () => {
        const target = path.join(DIR, "Private & Shared", "Room 1.md");
        const io = makeIo([HUGO_DOC, target]);
        expect(await resolveLinkPath(EXPORTED_NESTED, ctx(), io)).toBe(target);
    });

    it("cleans a path all at once, not one segment at a time", async () => {
        // The stated boundary: the retry strips EVERY segment or none, so a
        // tree cleaned unevenly (folder renamed, file not) still misses. The
        // per-segment product is exponential and no converter produces this.
        const target = path.join(
            DIR,
            "Private & Shared",
            "Room 1 7a6f70896bfc4e5e976d588412b74370.md",
        );
        const io = makeIo([HUGO_DOC, target]);
        expect(await resolveLinkPath(EXPORTED_NESTED, ctx(), io)).toBe(null);
    });

    it("prefers the file that still has its id over a cleaned twin", async () => {
        // The precedence that makes the fallback safe: a vault holding BOTH
        // must open the one the link literally names.
        const intact = path.join(DIR, "Room 1 7a6f70896bfc4e5e976d588412b74370.md");
        const cleaned = path.join(DIR, "Room 1.md");
        const io = makeIo([HUGO_DOC, intact, cleaned]);
        expect(await resolveLinkPath(EXPORTED, ctx(), io)).toBe(intact);
    });

    it("prefers an id-carrying file elsewhere in the workspace over a cleaned sibling", async () => {
        // The stripped form must lose to the intact form at the INDEX stage
        // too, not only at the exact-path stage. `cleaned` is both shorter and
        // nearer, so it wins every pickBest tiebreak: only trying the intact
        // form's tail FIRST can produce this answer.
        const doc = path.join(ROOT, "notes", "scratch.md");
        const intact = path.join(
            ROOT,
            "archive",
            "deep",
            "Room 1 7a6f70896bfc4e5e976d588412b74370.md",
        );
        const cleaned = path.join(ROOT, "Room 1.md");
        const io = makeIo([doc, intact, cleaned]);
        expect(await resolveLinkPath(EXPORTED, ctx({ docFsPath: doc }), io)).toBe(intact);
    });

    it("falls back to the folder's index document under a cleaned name", async () => {
        const target = path.join(DIR, "Room 1", "index.md");
        const io = makeIo([HUGO_DOC, target]);
        expect(
            await resolveLinkPath(
                "Room%201%207a6f70896bfc4e5e976d588412b74370",
                ctx(),
                io,
            ),
        ).toBe(target);
    });

    it("resolves the cleaned name through the workspace index when the path misses", async () => {
        // The export tree was moved AND cleaned: neither the document-relative
        // path nor the intact tail can match, so only the stripped tail can.
        const doc = path.join(ROOT, "notes", "scratch.md");
        const target = path.join(ROOT, "vault", "pages", "Room 1.md");
        const io = makeIo([doc, target]);
        expect(await resolveLinkPath(EXPORTED, ctx({ docFsPath: doc }), io)).toBe(target);
    });

    it("picks the nearest match when a cleaned name is ambiguous", async () => {
        // Nothing carries the id any more, so the retry is all there is; the
        // existing shortest-then-nearest tiebreak arbitrates rather than the
        // resolver refusing and opening nothing.
        const doc = path.join(ROOT, "notes", "scratch.md");
        const near = path.join(ROOT, "content", "Room 1.md");
        const far = path.join(ROOT, "archive", "2019", "old", "Room 1.md");
        const io = makeIo([doc, near, far]);
        expect(await resolveLinkPath(EXPORTED, ctx({ docFsPath: doc }), io)).toBe(near);
    });

    it("leaves a near-miss id alone: wrong length, uppercase, or no separator", async () => {
        // 31 hex, 33 hex, uppercase, and an id run onto the title with no
        // space. None is a Notion id, so none may be stripped.
        const cleaned = path.join(DIR, "Room 1.md");
        const io = makeIo([HUGO_DOC, cleaned]);
        for (const near of [
            "Room 1 7a6f70896bfc4e5e976d588412b7437.md", // 31
            "Room 1 7a6f70896bfc4e5e976d588412b743700.md", // 33
            "Room 1 7A6F70896BFC4E5E976D588412B74370.md", // uppercase
            "Room 17a6f70896bfc4e5e976d588412b74370.md", // no separator
        ]) {
            expect(await resolveLinkPath(near, ctx(), io)).toBe(null);
        }
    });

    it("never strips a segment down to a bare extension", async () => {
        // ` <id>.md` has no title left; cleaning it to `.md` would let the
        // retry match any dotfile named `.md` in the workspace.
        const dotfile = path.join(DIR, ".md");
        const io = makeIo([HUGO_DOC, dotfile]);
        expect(
            await resolveLinkPath("%207a6f70896bfc4e5e976d588412b74370.md", ctx(), io),
        ).toBe(null);
    });

    it("does not strip ids in non-smart mode", async () => {
        // Non-smart mode is pure path math with no existence checks, so a
        // rewritten target there would point at a file nobody asked for.
        const io = makeIo([]);
        expect(await resolveLinkPath(EXPORTED, ctx({ smartLinks: false }), io)).toBe(
            path.join(DIR, EXPORTED),
        );
    });
});

describe("resolveLinkPath — non-smart mode", () => {
    const off = () => ctx({ smartLinks: false });

    it("resolves relative paths against the document with no existence check", async () => {
        const io = makeIo([]);
        expect(await resolveLinkPath("missing.md", off(), io)).toBe(
            path.join(ROOT, "content", "write", "ai-playbook", "missing.md"),
        );
    });

    it("treats a leading / as workspace-root-relative (never the filesystem root)", async () => {
        const io = makeIo([]);
        expect(await resolveLinkPath("/write/uber", off(), io)).toBe(
            path.join(ROOT, "write", "uber"),
        );
    });

    it("keeps @/ workspace-root behavior", async () => {
        const io = makeIo([]);
        expect(await resolveLinkPath("@/docs/guide.md", off(), io)).toBe(
            path.join(ROOT, "docs", "guide.md"),
        );
    });

    it("does no suffix inference or decoding", async () => {
        const io = makeIo([]);
        expect(await resolveLinkPath("my%20notes", off(), io)).toBe(
            path.join(ROOT, "content", "write", "ai-playbook", "my%20notes"),
        );
    });
});

describe("resolveWikiTarget", () => {
    it("matches a bare name case-insensitively, without extension", async () => {
        const target = path.join(ROOT, "notes", "My-Page.md");
        const io = makeIo([HUGO_DOC, target]);
        expect(await resolveWikiTarget("my-page", ctx(), io)).toBe(target);
    });

    it("matches a bare name that includes the extension", async () => {
        const target = path.join(ROOT, "notes", "plan.md");
        const io = makeIo([HUGO_DOC, target]);
        expect(await resolveWikiTarget("plan.md", ctx(), io)).toBe(target);
    });

    it("prefers markdown files over other extensions", async () => {
        const png = path.join(ROOT, "images", "plan.png");
        const md = path.join(ROOT, "deeply", "nested", "dir", "plan.md");
        const io = makeIo([HUGO_DOC, png, md]);
        expect(await resolveWikiTarget("plan", ctx(), io)).toBe(md);
    });

    it("falls back to non-markdown files when no markdown matches", async () => {
        const png = path.join(ROOT, "images", "diagram.png");
        const io = makeIo([HUGO_DOC, png]);
        expect(await resolveWikiTarget("diagram", ctx(), io)).toBe(png);
    });

    it("tiebreaks duplicates by shortest path then closeness to the document", async () => {
        const near = path.join(ROOT, "content", "plan.md");
        const far = path.join(ROOT, "archive", "2019", "old", "plan.md");
        const io = makeIo([HUGO_DOC, near, far]);
        expect(await resolveWikiTarget("plan", ctx(), io)).toBe(near);
    });

    it("routes path-style targets through the smart chain", async () => {
        const target = path.join(ROOT, "content", "write", "uber", "index.md");
        const io = makeIo([HUGO_DOC, target]);
        expect(await resolveWikiTarget("write/uber", ctx(), io)).toBe(target);
        expect(await resolveWikiTarget("/write/uber", ctx(), io)).toBe(target);
    });

    it("returns null for an empty or unmatched target", async () => {
        const io = makeIo([HUGO_DOC]);
        expect(await resolveWikiTarget("", ctx(), io)).toBe(null);
        expect(await resolveWikiTarget("nonexistent-page", ctx(), io)).toBe(null);
    });

    it("retries a Notion-shaped bare name without its export id", async () => {
        const target = path.join(ROOT, "notes", "Room 1.md");
        const io = makeIo([HUGO_DOC, target]);
        expect(
            await resolveWikiTarget("Room 1 7a6f70896bfc4e5e976d588412b74370", ctx(), io),
        ).toBe(target);
    });

    it("prefers the name as written over its id-stripped form", async () => {
        const intact = path.join(
            ROOT,
            "deeply",
            "nested",
            "Room 1 7a6f70896bfc4e5e976d588412b74370.md",
        );
        const cleaned = path.join(ROOT, "Room 1.md");
        const io = makeIo([HUGO_DOC, intact, cleaned]);
        // `cleaned` wins every tiebreak pickBest has (shorter, nearer), so a
        // pass here can only come from trying the written name first.
        expect(
            await resolveWikiTarget("Room 1 7a6f70896bfc4e5e976d588412b74370", ctx(), io),
        ).toBe(intact);
    });
});
