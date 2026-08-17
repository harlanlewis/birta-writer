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
import { readFileSync } from "node:fs";
import { walkFiles } from "./cjkScanner";
import { join } from "node:path";
import {
    DOCUMENT_EXTENSIONS,
    DOCUMENT_EXT_REGEX,
    INDEX_FILE_REGEX,
    isDocumentPath,
} from "../documentExtensions";

const REPO_ROOT = join(__dirname, "..", "..");

/** Every source file under the given roots, tests and fixtures excluded. */
function sourceFiles(roots: string[]): string[] {
    return roots.flatMap((root) =>
        walkFiles(join(REPO_ROOT, root), [".ts", ".mjs"], ["node_modules", "dist", "__tests__", "fixtures"]),
    );
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
        for (const ext of DOCUMENT_EXTENSIONS) {
            expect(DOCUMENT_EXT_REGEX.test(`x.${ext}`), ext).toBe(true);
        }
    });

    it("the shared regexes should carry no `g` flag, which is what makes sharing them safe", () => {
        // These are module constants reused across calls, and `wikiNameOf`
        // runs them over every workspace suggestion on every keystroke. A `g`
        // flag would give each one a `lastIndex` that survives between
        // callers, so the same input would start matching and not matching by
        // turns. This is the property the sharing rests on.
        for (const re of [DOCUMENT_EXT_REGEX, INDEX_FILE_REGEX]) {
            expect(re.global, `${re.source} must not be global`).toBe(false);
            expect(re.sticky, `${re.source} must not be sticky`).toBe(false);
        }
        // Repeated calls agree, which is the observable form of the above.
        for (let i = 0; i < 3; i++) {
            expect(DOCUMENT_EXT_REGEX.test("a/b/page.md"), `call ${i}`).toBe(true);
        }
    });

    it("an index file should be recognized in every format, with or without the underscore", () => {
        for (const ext of DOCUMENT_EXTENSIONS) {
            expect(INDEX_FILE_REGEX.test(`index.${ext}`), ext).toBe(true);
            expect(INDEX_FILE_REGEX.test(`_index.${ext}`), `_${ext}`).toBe(true);
            expect(INDEX_FILE_REGEX.test(`notindex.${ext}`), `not ${ext}`).toBe(false);
        }
    });

    it("no source file should spell the extension alternation out for itself", () => {
        // The failure this guards: `.mdx` was added to two of four copies, so a
        // .mdx file opened from the explorer stayed in the raw text editor and
        // `[[a-page]]` offered .md targets only. A new copy here is that bug
        // being written again.
        const files = sourceFiles(["src", "webview", "shared", "packages", "e2e", "scripts"]);
        expect(files.length, "source files scanned").toBeGreaterThan(100);

        // Three spellings of the same copy. A regex alternation
        // `(md|markdown|mdx)`; a quoted list `["*.md", "*.markdown"]` or
        // `[".md", ".mdx"]` (two adjacent quoted entries suffice); and a brace
        // glob `{md,markdown}`. Each is a list a caller re-derived for itself.
        const EXT = "(?:md|markdown|mdx)";
        const Q = "[\"'\`]";
        const forms: Array<{ name: string; re: RegExp }> = [
            { name: "regex alternation", re: new RegExp(`\\(${EXT}(?:\\|${EXT})+\\)`) },
            { name: "quoted list", re: new RegExp(`${Q}\\*?\\.${EXT}${Q}\\s*,\\s*${Q}\\*?\\.${EXT}${Q}`) },
            { name: "brace glob", re: new RegExp(`\\{${EXT}(?:,${EXT})+\\}`) },
        ];
        // The forms have to be able to fire, or a green run proves nothing.
        expect(forms[0]!.re.test("/\\.(md|markdown)$/")).toBe(true);
        expect(forms[1]!.re.test('["*.md", "*.markdown"]')).toBe(true);
        expect(forms[1]!.re.test("['.md', '.mdx']")).toBe(true);
        expect(forms[2]!.re.test("**/*.{md,markdown,mdx}")).toBe(true);

        const offenders: string[] = [];
        for (const file of files) {
            if (file.endsWith("documentExtensions.ts")) { continue; }
            const text = readFileSync(file, "utf8");
            for (const { name, re } of forms) {
                if (re.test(text)) {
                    offenders.push(`${file.slice(REPO_ROOT.length + 1)} (${name})`);
                }
            }
        }
        expect(offenders, "import from shared/documentExtensions instead").toEqual([]);
    });
});
