/**
 * CI guard: no CJK characters may appear in code (including string literals)
 * under src/, webview/ or shared/. Comments are exempt while the
 * Chinese-to-English migration is in progress, as are test fixtures
 * (__tests__ dirs) and the dedicated translation data file
 * src/i18n/webviewTranslations.ts.
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import { stripComments, findCjkLines, walkFiles, CJK_RE } from "./cjkScanner";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCANNED_DIRS = ["src", "webview", "shared"];
const EXEMPT_FILES = new Set([path.join(REPO_ROOT, "src", "i18n", "webviewTranslations.ts")]);

describe("stripComments", () => {
    it("Chinese in a line comment should be removed", () => {
        const stripped = stripComments('const a = 1; // 中文注释');
        expect(stripped).toBe("const a = 1; ");
    });

    it("Chinese in a block comment should be removed and newlines preserved", () => {
        const stripped = stripComments("/* 第一行\n第二行 */\nconst a = 1;");
        expect(stripped).toBe("\n\nconst a = 1;");
    });

    it("Chinese in a string literal should be kept", () => {
        const stripped = stripComments('const s = "中文";');
        expect(stripped).toBe('const s = "中文";');
    });

    it("a // inside a double-quoted string should not start a comment", () => {
        const src = 'const url = "https://example.com/路径"; // 注释';
        expect(stripComments(src)).toBe('const url = "https://example.com/路径"; ');
    });

    it("a // URL inside a template literal should not start a comment", () => {
        const src = "const u = `https://example.com/${id}/中文`;";
        expect(stripComments(src)).toBe(src);
    });

    it("a comment after a template interpolation should still be removed", () => {
        const src = "const u = `a${x + 1}b`; // 尾注";
        expect(stripComments(src)).toBe("const u = `a${x + 1}b`; ");
    });

    it("an escaped quote should not end the string", () => {
        const src = 'const s = "he said \\"hi\\" // not a comment";';
        expect(stripComments(src)).toBe(src);
    });

    it("a regex literal containing quotes should not open string mode", () => {
        const src = 'const re = /["\']/g; // 注释\nconst b = "kept";';
        expect(stripComments(src)).toBe('const re = /["\']/g; \nconst b = "kept";');
    });

    it("a division expression should not be mistaken for a regex", () => {
        const src = "const r = a / b / c; // 注释";
        expect(stripComments(src)).toBe("const r = a / b / c; ");
    });

    it("CSS mode should not treat // inside url() as a comment", () => {
        const src = "a { background: url(https://x.y/img.png); }";
        expect(stripComments(src, { lineComments: false })).toBe(src);
    });

    it("CSS mode should still remove block comments", () => {
        const src = "/* 中文注释 */\na { color: red; }";
        expect(stripComments(src, { lineComments: false })).toBe("\na { color: red; }");
    });
});

describe("findCjkLines", () => {
    it("CJK in code should be reported with its 1-based line number", () => {
        const src = 'const a = 1;\nconst s = "中文";\nconst b = 2;';
        expect(findCjkLines(src)).toEqual([2]);
    });

    it("CJK only in comments should report no lines", () => {
        const src = "// 行注释\n/* 块注释\n跨行 */\nconst a = 1;";
        expect(findCjkLines(src)).toEqual([]);
    });

    it("hiragana, katakana and hangul in code should all be flagged", () => {
        expect(findCjkLines('const a = "ひらがな";')).toEqual([1]);
        expect(findCjkLines('const b = "カタカナ";')).toEqual([1]);
        expect(findCjkLines('const c = "한글";')).toEqual([1]);
    });

    it("line numbers after a multi-line block comment should stay accurate", () => {
        const src = "/* 一\n二\n三 */\nconst s = `中文`;";
        expect(findCjkLines(src)).toEqual([4]);
    });
});

describe("CJK literal guard", () => {
    it("source files under src/, webview/ and shared/ should contain no CJK outside comments", () => {
        const offenders: string[] = [];
        for (const dir of SCANNED_DIRS) {
            const files = walkFiles(path.join(REPO_ROOT, dir), [".ts", ".css"], ["__tests__"]);
            for (const file of files) {
                if (EXEMPT_FILES.has(file)) continue;
                const source = fs.readFileSync(file, "utf8");
                const lineComments = !file.endsWith(".css");
                for (const line of findCjkLines(source, { lineComments })) {
                    offenders.push(`${path.relative(REPO_ROOT, file)}:${line}`);
                }
            }
        }
        expect(
            offenders,
            `CJK characters found in code (comments are exempt; route user-facing text through t()):\n${offenders.join("\n")}`,
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
        const offenders: string[] = [];
        for (const file of files) {
            const source = fs.readFileSync(file, "utf8");
            // JSON has no code comments; every line is data, scan verbatim.
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
