/**
 * CI guard: no literal COLOR fallbacks in `var(--vscode-*, <literal>)` anywhere
 * under webview/ (CSS and inline TS styles).
 *
 * Inside VS Code the webview always receives the full resolved `--vscode-*`
 * palette — pinned/custom theme overrides were removed entirely (auto-only), so
 * a native variable is never absent. A literal fallback is therefore dead code
 * that never renders, and a grep trap: searching for a color turns up values
 * that don't apply. The rule (CLAUDE.md, "No custom colors") is now enforced
 * here so a fallback can't creep back in.
 *
 * Allowed and NOT flagged:
 * - variable-chain fallbacks: `var(--vscode-x, var(--vscode-y))` — they resolve
 *   to theme colors, not literals.
 * - CSS-wide keywords as the fallback (`transparent`, `currentColor`, `none`,
 *   `inherit`, `initial`, `unset`) — these are not custom theme colors. They are
 *   the correct fallback for OPTIONAL VS Code colors that a normal (non
 *   high-contrast) theme leaves undefined, e.g. `contrastActiveBorder` and
 *   `toolbar-hoverOutline`, which must stay invisible unless the theme sets them.
 *   Without a fallback a bare `var()` on `border-color` would resolve to the
 *   property's initial value, `currentColor` — a visible border where none was
 *   intended.
 * - the four non-color font variables, whose literal fallbacks are a legitimate
 *   font stack / px size, not a color: --vscode-font-family, --vscode-font-size,
 *   --vscode-editor-font-family, --vscode-editor-font-size.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const webviewRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Non-color --vscode-* variables whose literal fallbacks are legitimate. */
const NON_COLOR_VARS = new Set([
    "--vscode-font-family",
    "--vscode-font-size",
    "--vscode-editor-font-family",
    "--vscode-editor-font-size",
]);

function collectFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === "__tests__" || name === "__mocks__") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) collectFiles(full, out);
        else if (/\.(ts|css)$/.test(name)) out.push(full);
    }
    return out;
}

/**
 * A `--vscode-*` var whose first fallback argument is a literal COLOR — i.e. not
 * a nested `var(` chain and not a CSS-wide keyword. The whitespace lives INSIDE
 * the negative lookahead: keeping a `\s*` before the lookahead would let it
 * backtrack to zero and see the space instead of the nested token, falsely
 * flagging variable-chain and keyword fallbacks.
 */
const LITERAL_FALLBACK_RE =
    /var\(\s*(--vscode-[\w-]+)\s*,(?!\s*(?:var\(|transparent\b|currentcolor\b|currentColor\b|inherit\b|initial\b|unset\b|none\b))/g;

function findLiteralColorFallbacks(): string[] {
    const violations: string[] = [];
    for (const file of collectFiles(webviewRoot)) {
        const text = readFileSync(file, "utf8");
        const lines = text.split("\n");
        lines.forEach((line, i) => {
            for (const m of line.matchAll(LITERAL_FALLBACK_RE)) {
                if (!NON_COLOR_VARS.has(m[1])) {
                    violations.push(`${relative(webviewRoot, file)}:${i + 1}  ${m[1]}`);
                }
            }
        });
    }
    return violations.sort();
}

describe("no literal --vscode-* color fallbacks in webview", () => {
    it("the matcher should flag a literal color fallback but not a chain, keyword, or font var", () => {
        // Sanity-check the regex + exclusion so the guard below isn't vacuous.
        const flag = (s: string) =>
            [...s.matchAll(LITERAL_FALLBACK_RE)].some((m) => !NON_COLOR_VARS.has(m[1]));
        expect(flag("color: var(--vscode-errorForeground, #f44)")).toBe(true);
        expect(flag("bg: var(--vscode-x, rgba(1,2,3,0.5))")).toBe(true);
        expect(flag("color: var(--vscode-foreground, var(--vscode-editor-foreground))")).toBe(false);
        expect(flag("border-color: var(--vscode-contrastActiveBorder, transparent)")).toBe(false);
        expect(flag("border-color: var(--vscode-x, currentColor)")).toBe(false);
        expect(flag("font: var(--vscode-font-family, -apple-system, sans-serif)")).toBe(false);
        expect(flag("color: var(--vscode-errorForeground)")).toBe(false);
    });

    it("every var(--vscode-*) color reference should have no literal fallback", () => {
        expect(findLiteralColorFallbacks()).toEqual([]);
    });
});
