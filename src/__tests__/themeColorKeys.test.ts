/**
 * THEME_COLOR_KEYS ⟷ webview usage sync invariant.
 *
 * THEME_COLOR_KEYS exists to serve the theme switcher: every `--vscode-*`
 * color variable the webview consumes must be overridable/backfillable by a
 * pinned theme, and the list must carry no dead keys. This test scans every
 * file under webview/ (CSS + TS, app code and tests excluded from neither —
 * only real variable references count) and asserts both directions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { THEME_COLOR_KEYS } from "../themeManager";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Non-color --vscode-* variables (fonts/sizes) — outside the invariant. */
const NON_COLOR_VARS = new Set([
    "font-family",
    "font-size",
    "editor-font-family",
    "editor-font-size",
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

function usedColorVars(): Set<string> {
    const vars = new Set<string>();
    for (const file of collectFiles(join(repoRoot, "webview"))) {
        const text = readFileSync(file, "utf8");
        // Match only real references — `var(--vscode-…` in CSS/TS and quoted
        // names in TS (getPropertyValue etc.) — never prose in comments.
        for (const m of text.matchAll(/(?:var\(\s*|["'`])--vscode-([a-zA-Z][a-zA-Z-]*[a-zA-Z])/g)) {
            if (!NON_COLOR_VARS.has(m[1])) vars.add(m[1]);
        }
    }
    return vars;
}

const keyToVar = (key: string): string => key.replace(/\./g, "-");

describe("THEME_COLOR_KEYS sync with webview usage", () => {
    const used = usedColorVars();
    const keyVars = new Set(THEME_COLOR_KEYS.map(keyToVar));

    it("every --vscode-* color the webview consumes should be pinned-theme overridable", () => {
        const unoverridable = [...used].filter((v) => !keyVars.has(v)).sort();
        expect(unoverridable).toEqual([]);
    });

    it("every THEME_COLOR_KEYS entry should be consumed somewhere in the webview", () => {
        const dead = THEME_COLOR_KEYS.filter((k) => !used.has(keyToVar(k))).sort();
        expect(dead).toEqual([]);
    });
});
