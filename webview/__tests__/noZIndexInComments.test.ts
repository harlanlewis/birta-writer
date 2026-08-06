/**
 * Guard: a comment may describe the stacking order, but it may never quote a
 * z-index NUMBER.
 *
 * **Why this is a guard and not a style note.** A cited number is a copy of a
 * value that lives somewhere else, and nothing keeps the copy honest. Three
 * comments in this tree asserted the topbar sits at `z 1200`. It has been
 * `10002` for a long time. Nobody edited those comments and made them wrong;
 * they rotted in place when `.editor-topbar`'s declaration changed in a
 * different file. One of them (`.block-menu`, style.css) then read as a
 * guarantee the code did not have — the menu clears the bar geometrically, not
 * by z-order — which is precisely the sort of false assurance someone reasons
 * from at 2am.
 *
 * **Why a write-time hook cannot do this job.** A `PreToolUse` guard sees only
 * the edit in front of it. The drift here happened in the *declaration*, a file
 * away from the comment it invalidated, so there is no edit to intercept: the
 * comment was already written and already correct when it was authored. Only a
 * sweep over the whole tree catches a copy that has gone stale, which is why
 * this sits beside `noColorLiterals.test.ts` and `chromeTokens.test.ts` rather
 * than in the plugin's hook set.
 *
 * **The rule.** Any 3-to-5-digit integer that is ALSO a declared z-index value
 * somewhere in the webview is flagged when it appears in a comment. Deriving
 * the number set from the stylesheets rather than hard-coding it is what keeps
 * this guard from becoming the very thing it forbids: it has no copy of the
 * stack to go stale. Values below 100 are ignored — `z-index: 1` against a
 * comment that happens to say "1" is noise, and the meaningful stack in this
 * codebase starts in the hundreds.
 *
 * **The fix when it fires** is never to correct the number. Name the
 * relationship instead, because that is what the reader actually needs and it
 * cannot drift:
 *
 *     /* Above the topbar (10002) so a fullscreen preview is not covered. *\/   ✗
 *     /* Above the topbar so a fullscreen preview is not covered. *\/           ✓
 *
 * Where the ordering is load-bearing, assert it in a test rather than a
 * comment; `e2e/toolbarMenu/checks.mjs` already does this for the topbar.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { cssSourcesInFile, cssSourcesInTypeScript } from "./helpers/cssSources";

const webviewRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Below this, a bare integer in prose is far more likely to mean something else. */
const SIGNIFICANT_Z = 100;

function collectFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === "__tests__" || name === "__mocks__") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) collectFiles(full, out);
        else if (/\.(ts|css)$/.test(name)) out.push(full);
    }
    return out;
}

/** Every z-index value the webview actually declares, in CSS and in TS-authored CSS. */
export function declaredZIndexes(): Set<number> {
    const values = new Set<number>();
    const harvest = (text: string): void => {
        for (const m of text.matchAll(/z-index\s*:\s*(-?\d+)/g)) {
            const n = Number(m[1]);
            if (n >= SIGNIFICANT_Z) values.add(n);
        }
    };
    for (const file of collectFiles(webviewRoot)) {
        const text = readFileSync(file, "utf8");
        if (file.endsWith(".css")) {
            harvest(text);
        } else {
            for (const src of cssSourcesInFile(text, file)) harvest(src.text);
        }
    }
    for (const src of cssSourcesInTypeScript(webviewRoot)) harvest(src.text);
    return values;
}

/**
 * Comment spans in CSS or TypeScript, as `{ line, text }`.
 *
 * String and template literals are NOT stripped first: a z-index quoted inside
 * a runtime string is a different (and rarer) problem, and stripping literals
 * correctly needs a tokenizer this guard has no business carrying.
 */
export function commentsIn(text: string): { line: number; text: string }[] {
    const out: { line: number; text: string }[] = [];
    const lines = text.split("\n");
    let inBlock = false;
    lines.forEach((line, i) => {
        let comment = "";
        if (inBlock) {
            const end = line.indexOf("*/");
            comment = end === -1 ? line : line.slice(0, end);
            if (end !== -1) inBlock = false;
        } else {
            const block = line.indexOf("/*");
            const lineComment = line.indexOf("//");
            if (block !== -1 && (lineComment === -1 || block < lineComment)) {
                const end = line.indexOf("*/", block + 2);
                comment = end === -1 ? line.slice(block + 2) : line.slice(block + 2, end);
                if (end === -1) inBlock = true;
            } else if (lineComment !== -1) {
                comment = line.slice(lineComment + 2);
            }
        }
        if (comment.trim()) out.push({ line: i + 1, text: comment });
    });
    return out;
}

/** Below this a bare parenthesised number is far more often a weight or a percent. */
const BARE_CITATION_FLOOR = 500;
/** Words that mark a sentence as being about stacking rather than arithmetic. */
const STACKING_RE = /\b(above|below|over|under|paint|occlud|cover|stack|paints?)\b/i;

/**
 * Cited z-values in one comment line. Two shapes, because citations come in two
 * and matching every declared integer catches arithmetic instead:
 *
 * 1. Adjacent to a z token — `z-index: 1180`, `z 10002`, `(z 10000)`.
 * 2. Bare but parenthesised, or trailing an "is" — `the topbar (10002)`,
 *    `which is 10002`. Only counted when the line is talking about stacking,
 *    and only above `BARE_CITATION_FLOOR`, which is what separates these from
 *    `log(100)` and a `12px / 600` font weight.
 */
export function citedZValues(comment: string, declared: Set<number>): number[] {
    const hits: number[] = [];
    const seen = new Set<number>();
    const add = (raw: string): void => {
        const n = Number(raw);
        if (declared.has(n) && !seen.has(n)) { seen.add(n); hits.push(n); }
    };

    for (const m of comment.matchAll(/\bz(?:-index|-order)?\b[\s:=]*\(?([\d\s,/]{3,40})/gi)) {
        for (const num of m[1]!.matchAll(/(?<![\w.-])(\d{3,5})(?![\w.%-])/g)) add(num[1]!);
    }

    if (STACKING_RE.test(comment)) {
        for (const m of comment.matchAll(/(?:\((\d{3,5})\)|\bis\s+(\d{3,5})\b)(?![\w.%-])/g)) {
            const raw = m[1] ?? m[2]!;
            if (Number(raw) >= BARE_CITATION_FLOOR) add(raw);
        }
    }
    return hits;
}

function findCitations(): string[] {
    const declared = declaredZIndexes();
    const violations: string[] = [];
    for (const file of collectFiles(webviewRoot)) {
        const text = readFileSync(file, "utf8");
        for (const { line, text: comment } of commentsIn(text)) {
            for (const n of citedZValues(comment, declared)) {
                violations.push(`${relative(webviewRoot, file)}:${line} cites z-index ${n}`);
            }
        }
    }
    return violations;
}

describe("z-index values are never quoted in comments", () => {
    it("the sweep should actually reach the source it claims to guard", () => {
        expect(collectFiles(webviewRoot).length).toBeGreaterThan(50);
    });

    it("the declared set should be derived from the stylesheets, not hard-coded", () => {
        const declared = declaredZIndexes();
        // The topbar's own value, whatever it currently is, must be in the set —
        // if this guard ever stops seeing real declarations it would pass by
        // finding nothing, which is the failure mode worth pinning.
        expect(declared.size).toBeGreaterThan(5);
        expect([...declared].every((n) => n >= SIGNIFICANT_Z)).toBe(true);
    });

    it("a comment quoting a declared z-index should be flagged", () => {
        const declared = new Set([10002, 1100]);
        expect(citedZValues(" Above the topbar (10002) so it is not covered.", declared))
            .toEqual([10002]);
        expect(citedZValues(" topbar z 10002, sticky heading z 1100 cover this", declared))
            .toEqual([10002, 1100]);
    });

    it("a comment describing the relationship without a number should pass", () => {
        const declared = new Set([10002, 1100]);
        expect(citedZValues(" Above the topbar so a preview is not covered.", declared))
            .toEqual([]);
    });

    it("an integer that no stylesheet declares should not be flagged", () => {
        const declared = new Set([10002]);
        // Measurements, issue ids, and pixel counts are not the stack.
        expect(citedZValues(" costs 3400 nodes and 165 ms on MAR-317", declared)).toEqual([]);
    });

    it("a number welded to other characters should not be read as a citation", () => {
        const declared = new Set([1200]);
        expect(citedZValues(" a 1200px column, and rev-1200-final", declared)).toEqual([]);
    });

    it("a bare number should need BOTH stacking language and the floor to count", () => {
        const declared = new Set([100, 600, 1200]);
        // Arithmetic and typography, which happen to collide with real z values.
        expect(citedZValues(" So `log(100)` is 2 for half the world", declared)).toEqual([]);
        expect(citedZValues("   .ui-heading — 12px / 600 / foreground", declared)).toEqual([]);
        // Stacking language present, but the value is below the floor.
        expect(citedZValues(" painted above the row (100)", declared)).toEqual([]);
        // Both conditions met.
        expect(citedZValues(" sits above the palette (1200) so it wins", declared)).toEqual([1200]);
    });

    it("a z token should carry its number regardless of stacking language", () => {
        const declared = new Set([1180, 10000]);
        expect(citedZValues(" same top / right:16px / z-index:1180 band", declared)).toEqual([1180]);
        expect(citedZValues(" the ToC flyout (z 10000) never occludes it", declared)).toEqual([10000]);
    });

    it("both comment syntaxes should be read, and code outside them ignored", () => {
        const found = commentsIn("z-index: 1200;\n// a note\n/* block\n   continued */\ncode();");
        expect(found.map((c) => c.text.trim())).toEqual(["a note", "block", "continued"]);
    });

    it("webview comments should quote no z-index values", () => {
        expect(findCitations()).toEqual([]);
    });
});
