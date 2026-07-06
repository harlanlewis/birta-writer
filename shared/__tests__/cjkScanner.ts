/**
 * Test helper for the CJK-literal guard (see noCjkLiterals.test.ts).
 *
 * Strips comments from TS/CSS source with a small state machine that is
 * string-, template-literal- and regex-aware, so that a `//` inside a string
 * (e.g. a URL) never starts a comment. Comments may legitimately contain CJK
 * during the ongoing Chinese-to-English migration; code (including string
 * literals) must not.
 */
import * as fs from "fs";
import * as path from "path";

export interface StripCommentsOptions {
    /** Treat `//` as a line comment and `/.../` as regex literals (true for TS, false for CSS). */
    lineComments?: boolean;
}

/** Characters after which a `/` in code starts a regex literal rather than division. */
function isRegexStart(lastCode: string): boolean {
    return lastCode === "" || "([{,;:=!&|?+-*%<>~^".includes(lastCode);
}

/**
 * Removes line (`//`) and block comments from source while preserving newlines,
 * so line numbers in the output match the input. String, template-literal
 * (including `${...}` interpolations) and regex-literal contents are kept
 * verbatim and never treated as comment starts.
 */
export function stripComments(source: string, options: StripCommentsOptions = {}): string {
    const lineComments = options.lineComments ?? true;
    let out = "";
    // Context stack: "code" frames track brace depth so a bare `}` can close a
    // `${...}` interpolation; "template" frames resume when the interpolation ends.
    const stack: Array<{ mode: "code"; braceDepth: number } | { mode: "template" }> = [
        { mode: "code", braceDepth: 0 },
    ];
    let lastCode = ""; // last significant code character (regex-vs-division heuristic)
    let i = 0;
    const n = source.length;

    while (i < n) {
        const top = stack[stack.length - 1];
        const ch = source[i];
        const nx = source[i + 1];

        if (top.mode === "template") {
            if (ch === "\\") {
                out += ch + (nx ?? "");
                i += 2;
            } else if (ch === "`") {
                stack.pop();
                out += ch;
                i++;
            } else if (ch === "$" && nx === "{") {
                stack.push({ mode: "code", braceDepth: 0 });
                out += "${";
                i += 2;
            } else {
                out += ch;
                i++;
            }
            continue;
        }

        // --- code mode ---
        if (lineComments && ch === "/" && nx === "/") {
            i += 2;
            while (i < n && source[i] !== "\n") i++;
            continue; // the newline itself is emitted on the next iteration
        }
        if (ch === "/" && nx === "*") {
            i += 2;
            while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
                if (source[i] === "\n") out += "\n"; // keep line numbers stable
                i++;
            }
            i += 2; // skip the closing */
            continue;
        }
        if (ch === '"' || ch === "'") {
            out += ch;
            i++;
            while (i < n && source[i] !== ch && source[i] !== "\n") {
                if (source[i] === "\\") {
                    out += source[i] + (source[i + 1] ?? "");
                    i += 2;
                } else {
                    out += source[i];
                    i++;
                }
            }
            out += source[i] ?? "";
            i++;
            lastCode = ch;
            continue;
        }
        if (ch === "`") {
            stack.push({ mode: "template" });
            out += ch;
            i++;
            continue;
        }
        if (lineComments && ch === "/" && isRegexStart(lastCode)) {
            // Regex literal: consume so quotes inside it don't open string mode.
            out += ch;
            i++;
            let inClass = false;
            while (i < n) {
                const c = source[i];
                if (c === "\\") {
                    out += c + (source[i + 1] ?? "");
                    i += 2;
                    continue;
                }
                out += c;
                i++;
                if (c === "[") inClass = true;
                else if (c === "]") inClass = false;
                else if (c === "/" && !inClass) break;
                else if (c === "\n") break; // unterminated: not a regex after all
            }
            lastCode = "/";
            continue;
        }
        if (ch === "{") {
            top.braceDepth++;
        } else if (ch === "}") {
            if (top.braceDepth === 0 && stack.length > 1) {
                stack.pop(); // end of a `${...}` interpolation, back to the template
                out += ch;
                i++;
                continue;
            }
            top.braceDepth--;
        }
        out += ch;
        if (!/\s/.test(ch)) lastCode = ch;
        i++;
    }

    return out;
}

/**
 * CJK ranges the guard rejects: CJK Symbols & Punctuation (。、「」…),
 * Hiragana/Katakana, CJK Ext-A, CJK Unified Ideographs, CJK Compatibility
 * Ideographs, Halfwidth & Fullwidth Forms (！？（）…), and Hangul Syllables.
 * Kept wide so a stripped literal that survives as only fullwidth punctuation
 * or an Ext-A/compat character is still caught.
 *
 * Scope is the BMP only (no `u` flag): supplementary-plane ideographs such as
 * CJK Ext-B (U+20000+) are intentionally out of scope — they don't appear in
 * this codebase and adding astral ranges would need surrogate-aware matching.
 */
export const CJK_RE =
    /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\uAC00-\uD7A3]/;

/** Returns the 1-based line numbers that still contain CJK after comment stripping. */
export function findCjkLines(source: string, options: StripCommentsOptions = {}): number[] {
    const stripped = stripComments(source, options);
    const hits: number[] = [];
    stripped.split("\n").forEach((line, idx) => {
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
