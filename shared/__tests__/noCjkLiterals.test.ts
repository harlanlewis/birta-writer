/**
 * CI guard: no CJK characters may appear anywhere — comments included — in
 * source under src/, webview/ or shared/. The Chinese-to-English migration is
 * complete, so this is now a hard rule; route any user-facing text through
 * t() with English base strings. Test fixtures and helpers under __tests__
 * dirs are exempt, since a few deliberately exercise CJK input handling.
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import { findCjkLines, walkFiles, CJK_RE } from "./cjkScanner";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCANNED_DIRS = ["src", "webview", "shared"];

describe("CJK_RE", () => {
    it("Chinese, kana and hangul should be detected", () => {
        expect(CJK_RE.test("中")).toBe(true);
        expect(CJK_RE.test("ひらがな")).toBe(true);
        expect(CJK_RE.test("カタカナ")).toBe(true);
        expect(CJK_RE.test("한글")).toBe(true);
    });

    it("fullwidth and CJK punctuation should be detected", () => {
        expect(CJK_RE.test("！")).toBe(true);
        expect(CJK_RE.test("。")).toBe(true);
    });

    it("plain ASCII should not be detected", () => {
        expect(CJK_RE.test("Hello, world! 123")).toBe(false);
    });
});

describe("findCjkLines", () => {
    it("CJK should be reported with its 1-based line number", () => {
        const src = 'const a = 1;\nconst s = "中文";\nconst b = 2;';
        expect(findCjkLines(src)).toEqual([2]);
    });

    it("CJK in a comment should also be reported (comments are no longer exempt)", () => {
        const src = "// 行注释\nconst a = 1;";
        expect(findCjkLines(src)).toEqual([1]);
    });

    it("ASCII-only source should report no lines", () => {
        expect(findCjkLines("const a = 1;\nconst b = 2;")).toEqual([]);
    });
});

describe("CJK guard", () => {
    it("source files under src/, webview/ and shared/ should contain no CJK", () => {
        const offenders: string[] = [];
        for (const dir of SCANNED_DIRS) {
            const files = walkFiles(path.join(REPO_ROOT, dir), [".ts", ".css"], ["__tests__"]);
            for (const file of files) {
                const source = fs.readFileSync(file, "utf8");
                for (const line of findCjkLines(source)) {
                    offenders.push(`${path.relative(REPO_ROOT, file)}:${line}`);
                }
            }
        }
        expect(
            offenders,
            `CJK characters found in source (comments included; route user-facing text through t()):\n${offenders.join("\n")}`,
        ).toEqual([]);
    });

    // package.json contributions and the NLS bundles are pure user-facing data
    // with no comment layer, so ANY CJK there is a shipped Chinese string. These
    // files sit outside SCANNED_DIRS, which is how a Chinese command title or
    // setting description could regress unnoticed.
    it("package.json and NLS bundles should contain no CJK", () => {
        const files = ["package.json", "package.nls.json", "l10n/bundle.l10n.json"]
            .map((rel) => path.join(REPO_ROOT, rel))
            .filter((f) => fs.existsSync(f));
        // Guard against a vacuous pass: if a future rename made every path
        // disappear, the empty-offenders assertion would still go green.
        expect(files.length).toBeGreaterThan(0);
        const offenders: string[] = [];
        for (const file of files) {
            const source = fs.readFileSync(file, "utf8");
            source.split("\n").forEach((line, idx) => {
                if (CJK_RE.test(line)) {
                    offenders.push(`${path.relative(REPO_ROOT, file)}:${idx + 1}`);
                }
            });
        }
        expect(
            offenders,
            `CJK characters found in user-facing JSON:\n${offenders.join("\n")}`,
        ).toEqual([]);
    });
});
