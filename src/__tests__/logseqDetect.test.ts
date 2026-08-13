/**
 * logseqDetect: the "is this file part of a Logseq graph?" signal.
 *
 * The load-bearing test here is the corpus sweep at the bottom. Every marker
 * Logseq uses is also ordinary Markdown somewhere, so the only way to know a
 * detector is not claiming ordinary documents is to run it over documents that
 * are not Logseq and count. The repo's fixture tree is exactly that corpus: it
 * exists to hold hostile and unusual Markdown, and it already contains an
 * ordinary tab-indented bullet outline and a Quarto file full of `{{...}}` —
 * the two shapes a naive detector claims first.
 *
 * The sweep asserts the count in BOTH directions and names the files, so it
 * fails whether a change makes the detector greedier or blinder, and it cannot
 * pass vacuously by enumerating nothing.
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import {
    detectLogseq,
    scoreLogseqContent,
    type LogseqIo,
    type LogseqContext,
} from "../utils/logseqDetect";

const ROOT = path.normalize("/graph-workspace");

/** Fake IO over fixed sets of existing files and directories. */
function makeIo(files: string[] = [], dirs: string[] = []): LogseqIo {
    const fileSet = new Set(files.map((f) => path.normalize(f)));
    const dirSet = new Set(dirs.map((d) => path.normalize(d)));
    return {
        isFile: async (p) => fileSet.has(path.normalize(p)),
        isDirectory: async (p) => dirSet.has(path.normalize(p)),
    };
}

function ctx(overrides: Partial<LogseqContext> = {}): LogseqContext {
    return {
        docFsPath: path.join(ROOT, "graph", "pages", "Atlas.md"),
        workspaceRootFsPath: ROOT,
        text: "# An ordinary heading\n\nAn ordinary paragraph.\n",
        ...overrides,
    };
}

describe("detectLogseq — the mode gate", () => {
    it("mode off should return null without touching the filesystem", async () => {
        let touched = false;
        const io: LogseqIo = {
            isFile: async () => { touched = true; return true; },
            isDirectory: async () => { touched = true; return true; },
        };
        const reason = await detectLogseq("off", ctx(), io);
        expect(reason).toBeNull();
        expect(touched, "off must not run any IO").toBe(false);
    });

    it("mode on should report `forced` without touching the filesystem", async () => {
        let touched = false;
        const io: LogseqIo = {
            isFile: async () => { touched = true; return true; },
            isDirectory: async () => { touched = true; return true; },
        };
        expect(await detectLogseq("on", ctx(), io)).toBe("forced");
        expect(touched, "on is a decision already made; nothing to look up").toBe(false);
    });
});

describe("detectLogseq — the filesystem signal", () => {
    it("an ancestor holding logseq/config.edn should report `graph`", async () => {
        const io = makeIo([path.join(ROOT, "graph", "logseq", "config.edn")]);
        expect(await detectLogseq("auto", ctx(), io)).toBe("graph");
    });

    it("an ancestor holding pages/ beside journals/ should report `graph`", async () => {
        const io = makeIo([], [
            path.join(ROOT, "graph", "pages"),
            path.join(ROOT, "graph", "journals"),
        ]);
        expect(await detectLogseq("auto", ctx(), io)).toBe("graph");
    });

    it("pages/ WITHOUT journals/ should not report a graph", async () => {
        const io = makeIo([], [path.join(ROOT, "graph", "pages")]);
        expect(await detectLogseq("auto", ctx(), io)).toBeNull();
    });

    it("a marker ABOVE the workspace root should not be reached", async () => {
        // The walk terminates at the workspace root, exactly as the link
        // resolver's does: a marker outside the workspace is not this
        // workspace's graph.
        const io = makeIo([path.join(ROOT, "..", "logseq", "config.edn")]);
        expect(await detectLogseq("auto", ctx(), io)).toBeNull();
    });

    it("a document outside any workspace should still walk its own ancestors", async () => {
        const docFsPath = path.normalize("/elsewhere/graph/journals/2026_08_13.md");
        const io = makeIo([path.normalize("/elsewhere/graph/logseq/config.edn")]);
        expect(
            await detectLogseq("auto", ctx({ docFsPath, workspaceRootFsPath: null }), io),
        ).toBe("graph");
    });

    it("an unrooted walk should stop climbing rather than reach the filesystem root", async () => {
        // Ten levels deep, marker at the very top: past the cap, so not found.
        const deep = path.normalize("/a/b/c/d/e/f/g/h/i/j/page.md");
        const io = makeIo([path.normalize("/a/logseq/config.edn")]);
        expect(
            await detectLogseq("auto", ctx({ docFsPath: deep, workspaceRootFsPath: null }), io),
        ).toBeNull();
    });
});

describe("detectLogseq — the content signal", () => {
    const noMarkers = makeIo();

    it("a stray page with block refs and an outliner shape should report `content`", async () => {
        const text = [
            "- Morning notes. Linked [[Project Atlas]].",
            "\t- A nested child block.",
            "- Reference: ((7f3e9a10-1234-5678-9abc-def012345678))",
            "- TODO Follow up",
        ].join("\n");
        expect(await detectLogseq("auto", ctx({ text }), noMarkers)).toBe("content");
    });

    it("a single strong signal with nothing corroborating should NOT fire", async () => {
        // One `key:: value` line in an otherwise ordinary document is not
        // enough to reclassify it: score 2, below the threshold of 3.
        const text = "# Notes\n\nkey:: value\n\nAn ordinary paragraph, and another.\n";
        const { strong, weak, fired } = scoreLogseqContent(text);
        expect(strong).toEqual(["properties"]);
        expect(weak).toEqual([]);
        expect(fired).toBe(false);
        expect(await detectLogseq("auto", ctx({ text }), noMarkers)).toBeNull();
    });

    it("weak signals alone should never fire, however many of them there are", async () => {
        // An ordinary tab-indented bullet outline with task-looking words:
        // every weak signal at once, no strong one. This is the ordinary
        // outline the detector must not claim.
        const text = [
            "- DONE Ship the thing",
            "\t- A nested child",
            "- TODO Write it up",
            "- LATER Review it",
        ].join("\n");
        const { strong, weak, score, fired } = scoreLogseqContent(text);
        expect(strong).toEqual([]);
        expect(weak.length).toBeGreaterThanOrEqual(2);
        expect(score).toBeGreaterThanOrEqual(3);
        expect(fired, "score alone must not be enough without a strong signal").toBe(false);
        expect(await detectLogseq("auto", ctx({ text }), noMarkers)).toBeNull();
    });

    it("a bare {{shortcode}} should not count as a Logseq macro", async () => {
        // Quarto, Hugo and Jinja all spell shortcodes `{{...}}`, so the macro
        // signal matches Logseq's macro NAMES rather than the braces.
        const generic = "- text\n- {{< video src=\"a.mp4\" >}}\n- {{ site.title }}\n\t- child\n";
        expect(scoreLogseqContent(generic).strong).toEqual([]);
        const logseq = "- text\n- {{query (and [[project]] (task TODO))}}\n\t- child\n";
        expect(scoreLogseqContent(logseq).strong).toEqual(["macro"]);
    });

    it("the filesystem signal should win over the content signal", async () => {
        const io = makeIo([path.join(ROOT, "graph", "logseq", "config.edn")]);
        const text = "- ((7f3e9a10-1234-5678-9abc-def012345678))\n\t- child\n- TODO x\n";
        expect(await detectLogseq("auto", ctx({ text }), io)).toBe("graph");
    });
});

/**
 * The measurement, as a test. Runs the content vote over every `.md` in the
 * fixture tree and pins exactly which files it claims. `fixtures/logseq/` holds
 * the two synthetic Logseq pages; everything else is not Logseq and must not
 * be claimed.
 *
 * `fixtures/logseq/README.md` is deliberately NOT expected to fire: it is
 * English prose ABOUT Logseq, not a Logseq page. A file that only mentions
 * `{{embed}}` in a sentence is exactly what the strong-plus-corroboration rule
 * exists to decline, and a real graph file is caught by the filesystem signal
 * regardless.
 */
describe("content detection over the whole fixture corpus", () => {
    const fixtureRoot = path.resolve(__dirname, "../../webview/__tests__/fixtures");

    function walk(dir: string): string[] {
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) return walk(p);
            return e.isFile() && e.name.endsWith(".md") ? [p] : [];
        });
    }

    const files = walk(fixtureRoot).sort();
    const claimed = files
        .filter((f) => scoreLogseqContent(fs.readFileSync(f, "utf8")).fired)
        .map((f) => path.relative(fixtureRoot, f).split(path.sep).join("/"));

    it("the corpus should be non-empty (a sweep that reached nothing passes vacuously)", () => {
        expect(files.length).toBeGreaterThan(30);
    });

    it("should claim exactly the two Logseq page fixtures and nothing else", () => {
        expect(claimed).toEqual(["logseq/journal.md", "logseq/page.md"]);
    });

    it("should decline the ordinary outline and the Quarto shortcodes by name", () => {
        // The two files a naive detector claims first; named so a regression
        // says which shape broke rather than only that the count moved.
        for (const name of ["outline-tables.md", "tools/quarto.md"]) {
            expect(claimed, `${name} is not a Logseq page`).not.toContain(name);
        }
    });
});
