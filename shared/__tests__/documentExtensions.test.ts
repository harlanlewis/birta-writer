/**
 * One list of the extensions this editor opens, and nowhere that re-derives it.
 *
 * The behavioural cases below are ordinary. The one that earns its place is the
 * last: a scan of the tree for a hand-written `(md|markdown...)` alternation.
 * The bug this file exists for was not a wrong regex, it was a right regex
 * copied four times and updated twice, so a check that only tested the shared
 * helper would have passed throughout.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
    DOCUMENT_EXTENSIONS,
    documentExtRegex,
    indexFileRegex,
    isDocumentPath,
} from "../documentExtensions";

const REPO_ROOT = join(__dirname, "..", "..");

/** Every `.ts` file under the given roots, tests and fixtures excluded. */
function sourceFiles(roots: string[]): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            if (entry === "node_modules" || entry === "dist" || entry === "__tests__") { continue; }
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) { walk(full); } else if (entry.endsWith(".ts")) { out.push(full); }
        }
    };
    for (const root of roots) { walk(join(REPO_ROOT, root)); }
    return out;
}

describe("document extensions", () => {
    it("every opened format should match, and a plain file should not", () => {
        expect(DOCUMENT_EXTENSIONS.length, "formats enumerated").toBeGreaterThanOrEqual(3);
        for (const ext of DOCUMENT_EXTENSIONS) {
            expect(isDocumentPath(`/a/b/page.${ext}`), ext).toBe(true);
            expect(isDocumentPath(`/a/b/page.${ext.toUpperCase()}`), `${ext} uppercase`).toBe(true);
        }
        for (const other of ["txt", "json", "mdxx", "markdownish", "md.bak"]) {
            expect(isDocumentPath(`/a/b/page.${other}`), other).toBe(false);
        }
    });

    it("the extension list and the regex should never disagree", () => {
        // The regex is BUILT from the list, so this pins the construction
        // rather than a duplicate spelling of it.
        const re = documentExtRegex();
        for (const ext of DOCUMENT_EXTENSIONS) {
            expect(re.test(`x.${ext}`), ext).toBe(true);
        }
        expect(re.global, "no `g` flag, or lastIndex would leak between callers").toBe(false);
        expect(documentExtRegex()).not.toBe(documentExtRegex());
    });

    it("an index file should be recognized in every format, with or without the underscore", () => {
        for (const ext of DOCUMENT_EXTENSIONS) {
            expect(indexFileRegex().test(`index.${ext}`), ext).toBe(true);
            expect(indexFileRegex().test(`_index.${ext}`), `_${ext}`).toBe(true);
            expect(indexFileRegex().test(`notindex.${ext}`), `not ${ext}`).toBe(false);
        }
    });

    it("no source file should spell the extension alternation out for itself", () => {
        // The failure this guards: `.mdx` was added to two of four copies, so a
        // .mdx file opened from the explorer stayed in the raw text editor and
        // `[[a-page]]` offered .md targets only. A new copy here is that bug
        // being written again.
        const files = sourceFiles(["src", "webview", "shared", "packages"]);
        expect(files.length, "source files scanned").toBeGreaterThan(100);

        // Matches a hand-written alternation of two or more of our extensions,
        // e.g. `(md|markdown)` or `(md|markdown|mdx)`, however it is anchored.
        const handWritten = /\((?:md|markdown|mdx)(?:\|(?:md|markdown|mdx))+\)/;
        const offenders: string[] = [];
        for (const file of files) {
            if (file.endsWith("documentExtensions.ts")) { continue; }
            if (handWritten.test(readFileSync(file, "utf8"))) {
                offenders.push(file.slice(REPO_ROOT.length + 1));
            }
        }
        expect(offenders, "import from shared/documentExtensions instead").toEqual([]);
    });
});
