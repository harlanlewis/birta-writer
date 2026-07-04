/**
 * Shape tests for the zh-CN webview translation map: every key must be an
 * English base string actually passed to t() somewhere in webview/ source,
 * so a renamed or removed call site cannot leave orphaned translations.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { zhCn } from "../i18n/webviewTranslations";
import { walkFiles } from "../../shared/__tests__/cjkScanner";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Collects every string-literal key passed to t() in webview/ source (tests excluded). */
function collectTKeys(): Set<string> {
    const keys = new Set<string>();
    const files = walkFiles(path.join(REPO_ROOT, "webview"), [".ts"], ["__tests__"]);
    const callRe = /\bt\(\s*"((?:[^"\\]|\\.)+)"\s*\)/g;
    for (const file of files) {
        const source = fs.readFileSync(file, "utf8");
        for (const match of source.matchAll(callRe)) {
            keys.add(match[1]);
        }
    }
    return keys;
}

describe("zhCn translation map", () => {
    it("every zhCn key should match a t() call site in the webview source", () => {
        // Arrange
        const knownKeys = collectTKeys();
        // Act
        const orphans = Object.keys(zhCn).filter((key) => !knownKeys.has(key));
        // Assert
        expect(orphans, `zhCn keys with no matching t() call site:\n${orphans.join("\n")}`).toEqual([]);
    });

    it("every zhCn entry should map a non-empty key to a non-empty string value", () => {
        // Arrange / Act
        const entries = Object.entries(zhCn);
        // Assert
        expect(entries.length).toBeGreaterThan(0);
        for (const [key, value] of entries) {
            expect(key.length).toBeGreaterThan(0);
            expect(typeof value).toBe("string");
            expect(value.length).toBeGreaterThan(0);
        }
    });
});
