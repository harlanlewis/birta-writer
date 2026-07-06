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
 * Hiragana/Katakana (U+3040-30FF), CJK Ext-A (U+3400-4DBF), CJK Unified
 * Ideographs (U+4E00-9FFF), CJK Compatibility Ideographs (U+F900-FAFF),
 * Halfwidth & Fullwidth Forms (U+FF00-FFEF), and Hangul Syllables
 * (U+AC00-D7A3).
 *
 * Written with explicit `\u` escapes rather than literal characters. Literal
 * range bounds are a homoglyph trap: the *unified* ideograph U+8C48 and the
 * *compatibility* ideograph U+F900 are visually identical, so a literal range
 * meant to start at the compatibility block can silently start ~29,000 code
 * points lower and swallow the Private Use Area (where VS Code codicon glyphs
 * live), flagging harmless icon literals as "CJK". Escapes keep the bounds
 * exact and keep this matcher free of the very characters the guard bans.
 *
 * Scope is the BMP only (no `u` flag): supplementary-plane ideographs such as
 * CJK Ext-B (U+20000+) are intentionally out of scope — they don't appear in
 * this codebase and adding astral ranges would need surrogate-aware matching.
 */
export const CJK_RE =
    /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\uAC00-\uD7A3]/;

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
