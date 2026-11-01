/**
 * Export fixture provenance (MAR-341). A one-shot exporter changes its
 * output without notice, so an export fixture is only evidence when its
 * path says which exporter produced it and on what day:
 * `fixtures/exports/<exporter>/<YYYY-MM-DD>/...`. The convention and its
 * reasons live in fixtures/exports/README.md.
 *
 * The second rule is the trap the first exists for: a fixture named after
 * an exporter but written by hand reads as coverage of that exporter
 * forever. Outside `exports/`, a file whose name carries an exporter's name
 * must be declared in SYNTHETIC with the reason it is not an export.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, type Dirent } from "fs";
import { join, resolve } from "path";
import { isCorpusFile } from "./helpers/moveFuzz";

const FIXTURES_DIR = resolve(__dirname, "fixtures");

/**
 * The exporters a capture may be filed under, and whose name anywhere else
 * in a fixture's path claims an export. A new exporter is added here in the
 * commit that lands its first capture, so a misspelt directory is refused
 * rather than starting a second history beside the real one.
 */
const EXPORTERS = ["notion", "craft", "evernote", "apple-notes", "confluence", "google-docs"];

/** Vendor-named fixtures that are hand-authored, and why. */
const SYNTHETIC: Record<string, string> = {
    "notion-asides.md":
        "the <aside> callout in its documented spellings, written by hand; no Notion exporter produced it",
};

const DATED_CAPTURE = /^exports\/([a-z0-9-]+)\/(\d{4})-(\d{2})-(\d{2})\/./;

/**
 * A day an export can have been taken: a real calendar date, and no later
 * than tomorrow in UTC, which admits a capture dated in a timezone ahead of
 * UTC and nothing further out.
 */
function isCaptureDate(y: string, m: string, d: string, today = new Date()): boolean {
    const date = new Date(Date.UTC(+y, +m - 1, +d));
    const real = date.getUTCFullYear() === +y && date.getUTCMonth() === +m - 1 && date.getUTCDate() === +d;
    const latest = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1);
    return real && date.getTime() <= latest;
}

/** Every problem with one fixture path (relative to fixtures/), or none. */
function provenanceProblems(rel: string): string[] {
    if (rel === "exports/README.md") return [];
    if (rel.startsWith("exports/")) {
        // A capture's own README.md is part of the export and held like any page.
        const match = DATED_CAPTURE.exec(rel);
        if (!match || !EXPORTERS.includes(match[1]) || !isCaptureDate(match[2], match[3], match[4])) {
            return [`${rel}: an export fixture sits at exports/<exporter>/<YYYY-MM-DD>/, the exporter one of EXPORTERS and the date a day already past`];
        }
        return [];
    }
    if (rel.split("/").pop() === "README.md") return [];
    // The whole path, not only the file name: fixtures/notion/Page.md claims
    // Notion as loudly as notion-page.md does.
    const path = rel.toLowerCase().replace(/\.[^./]+$/, "");
    const named = EXPORTERS.find((e) => new RegExp(`(^|[^a-z])${e}($|[^a-z])`).test(path));
    if (named && !(rel in SYNTHETIC)) {
        return [`${rel}: named for ${named} but not under exports/; capture a real export or declare it in SYNTHETIC`];
    }
    return [];
}

/** Every file under `dir`, skipping dotfiles: a Finder .DS_Store is no fixture. */
function walk(dir: string, rel = ""): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true }) as Dirent[]) {
        if (entry.name.startsWith(".")) continue;
        const relName = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), relName));
        else out.push(relName);
    }
    return out;
}

describe("provenanceProblems", () => {
    it("a capture under exporter and real date should pass", () => {
        expect(provenanceProblems("exports/notion/2026-11-01/Page abc123.md")).toEqual([]);
        expect(provenanceProblems("exports/apple-notes/2026-02-28/sub/dir/Note.md")).toEqual([]);
    });

    it("a capture missing its date, or with an impossible one, should be refused", () => {
        expect(provenanceProblems("exports/notion/Page.md")).toHaveLength(1);
        expect(provenanceProblems("exports/notion/2026-13-01/Page.md")).toHaveLength(1);
        expect(provenanceProblems("exports/notion/2026-02-30/Page.md")).toHaveLength(1);
        expect(provenanceProblems("exports/Page.md")).toHaveLength(1);
        expect(provenanceProblems("exports/Notion/2026-11-01/Page.md")).toHaveLength(1);
    });

    it("a capture under an exporter not in EXPORTERS should be refused", () => {
        expect(provenanceProblems("exports/notoin/2026-11-01/Page.md")).toHaveLength(1);
        expect(provenanceProblems("exports/obsidian/2026-11-01/vault.md")).toHaveLength(1);
    });

    it("a capture dated after tomorrow should be refused, and tomorrow admitted", () => {
        const today = new Date(Date.UTC(2026, 10, 1));
        expect(isCaptureDate("2026", "11", "02", today)).toBe(true);
        expect(isCaptureDate("2026", "11", "03", today)).toBe(false);
        expect(provenanceProblems("exports/notion/2999-01-01/Page.md")).toHaveLength(1);
    });

    it("a README.md inside a capture should be held as a page, and an undated one refused", () => {
        expect(provenanceProblems("exports/notion/2026-11-01/README.md")).toEqual([]);
        expect(provenanceProblems("exports/notion/README.md")).toHaveLength(1);
    });

    it("a vendor-named fixture outside exports/ should be refused unless declared synthetic", () => {
        expect(provenanceProblems("craft-blocks.md")).toHaveLength(1);
        expect(provenanceProblems("tools/evernote.md")).toHaveLength(1);
        expect(provenanceProblems("notion-asides.md")).toEqual([]);
    });

    it("a fixture under a vendor-named directory should be refused like a vendor-named file", () => {
        expect(provenanceProblems("notion/Database Page.md")).toHaveLength(1);
        expect(provenanceProblems("tools/craft/doc.md")).toHaveLength(1);
    });

    it("a name that merely contains an exporter's letters should pass", () => {
        expect(provenanceProblems("handcrafted.md")).toEqual([]);
        expect(provenanceProblems("aircraft-notes.md")).toEqual([]);
    });

    it("a README anywhere should pass", () => {
        expect(provenanceProblems("exports/README.md")).toEqual([]);
    });
});

describe("isCorpusFile", () => {
    it("a capture's own README.md should be a corpus member, and every other README.md not", () => {
        expect(isCorpusFile("exports/notion/2026-11-01/README.md", ".md")).toBe(true);
        expect(isCorpusFile("exports/README.md", ".md")).toBe(false);
        expect(isCorpusFile("tools/README.md", ".md")).toBe(false);
        expect(isCorpusFile("tools/obsidian.md", ".md")).toBe(true);
        expect(isCorpusFile("PRE-README.md", ".md")).toBe(true);
        expect(isCorpusFile("tools/org.org", ".md")).toBe(false);
    });
});

describe("the fixture tree", () => {
    const files = walk(FIXTURES_DIR);

    it("the walk should reach the corpus and the exports directory", () => {
        expect(files.filter((f) => f.endsWith(".md")).length).toBeGreaterThan(30);
        expect(existsSync(join(FIXTURES_DIR, "exports", "README.md"))).toBe(true);
    });

    it("every declared synthetic fixture should exist, so the list cannot outlive its files", () => {
        for (const rel of Object.keys(SYNTHETIC)) expect(files).toContain(rel);
    });

    it("every fixture should satisfy the provenance rules", () => {
        expect(files.flatMap(provenanceProblems)).toEqual([]);
    });
});
