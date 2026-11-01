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

const FIXTURES_DIR = resolve(__dirname, "fixtures");

/** Exporters whose name in a fixture's file name claims an export. */
const EXPORTERS = ["notion", "craft", "evernote", "apple-notes", "confluence", "google-docs"];

/** Vendor-named fixtures that are hand-authored, and why. */
const SYNTHETIC: Record<string, string> = {
    "notion-asides.md":
        "the <aside> callout in its documented spellings, written by hand; no Notion exporter produced it",
};

const DATED_CAPTURE = /^exports\/[a-z0-9]+(?:-[a-z0-9]+)*\/(\d{4})-(\d{2})-(\d{2})\/./;

function isRealDate(y: string, m: string, d: string): boolean {
    const date = new Date(Date.UTC(+y, +m - 1, +d));
    return date.getUTCFullYear() === +y && date.getUTCMonth() === +m - 1 && date.getUTCDate() === +d;
}

/** Every problem with one fixture path (relative to fixtures/), or none. */
function provenanceProblems(rel: string): string[] {
    const name = rel.split("/").pop()!;
    if (name === "README.md") return [];
    if (rel.startsWith("exports/")) {
        const match = DATED_CAPTURE.exec(rel);
        if (!match || !isRealDate(match[1], match[2], match[3])) {
            return [`${rel}: an export fixture sits at exports/<exporter>/<YYYY-MM-DD>/`];
        }
        return [];
    }
    const tokens = name.toLowerCase().replace(/\.[^.]+$/, "");
    const named = EXPORTERS.find((e) => new RegExp(`(^|[^a-z])${e}($|[^a-z])`).test(tokens));
    if (named && !(rel in SYNTHETIC)) {
        return [`${rel}: named for ${named} but not under exports/; capture a real export or declare it in SYNTHETIC`];
    }
    return [];
}

function walk(dir: string, rel = ""): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true }) as Dirent[]) {
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

    it("a vendor-named fixture outside exports/ should be refused unless declared synthetic", () => {
        expect(provenanceProblems("craft-blocks.md")).toHaveLength(1);
        expect(provenanceProblems("tools/evernote.md")).toHaveLength(1);
        expect(provenanceProblems("notion-asides.md")).toEqual([]);
    });

    it("a name that merely contains an exporter's letters should pass", () => {
        expect(provenanceProblems("handcrafted.md")).toEqual([]);
        expect(provenanceProblems("aircraft-notes.md")).toEqual([]);
    });

    it("a README anywhere should pass", () => {
        expect(provenanceProblems("exports/README.md")).toEqual([]);
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
