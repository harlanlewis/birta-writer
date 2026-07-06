/**
 * Test helper for the CJK guard (see noCjkLiterals.test.ts).
 *
 * The Chinese-to-English migration is complete, so CJK is now forbidden
 * everywhere in scanned source — comments included. This module just exposes
 * the CJK matcher and a file walker; the guard scans source verbatim.
 */
import * as fs from "fs";
import * as path from "path";

/**
 * CJK ranges the guard rejects: CJK Symbols & Punctuation (U+3000-303F),
 * Hiragana/Katakana, CJK Ext-A, CJK Unified Ideographs, CJK Compatibility
 * Ideographs, Halfwidth & Fullwidth Forms (U+FF00-FFEF), and Hangul Syllables.
 *
 * Scope is the BMP only (no `u` flag): supplementary-plane ideographs such as
 * CJK Ext-B (U+20000+) are intentionally out of scope — they don't appear in
 * this codebase and adding astral ranges would need surrogate-aware matching.
 */
export const CJK_RE =
    /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힣]/;

/** Returns the 1-based line numbers that contain any CJK character. */
export function findCjkLines(source: string): number[] {
    const hits: number[] = [];
    source.split("\n").forEach((line, idx) => {
        if (CJK_RE.test(line)) hits.push(idx + 1);
    });
    return hits;
}

/** Recursively lists files under root with one of the given extensions, skipping excluded dir names. */
export function walkFiles(root: string, exts: string[], excludeDirNames: string[] = []): string[] {
    const results: string[] = [];
    const visit = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!excludeDirNames.includes(entry.name)) visit(full);
            } else if (exts.some((ext) => entry.name.endsWith(ext))) {
                results.push(full);
            }
        }
    };
    visit(root);
    return results.sort();
}
