/**
 * CI guard: OPTIONAL `--vscode-*` colors must never be used bare.
 *
 * Most VS Code workbench colors carry a base-theme default, so a bare
 * `var(--vscode-x)` always resolves — that's the norm and is correct. But a
 * handful are registered with a NULL default in normal (non high-contrast)
 * dark/light themes; VS Code only defines them under high contrast, or leaves
 * them to the individual theme. For those, a bare `var()` resolves to the CSS
 * property's *initial* value — and for `border-color`/`border` that initial
 * value is `currentColor`, which paints a visible border in the text color
 * where none was intended (see webview/__tests__/… history: this regressed the
 * find bar, toolbar menus, and inputs).
 *
 * So every one of these MUST carry a fallback: either a CSS keyword
 * (`transparent` for the "invisible unless high-contrast" ones) or a
 * variable-chain to a definitely-defaulted sibling (e.g. `--vscode-panel-border`,
 * `--vscode-toolbar-hoverBackground`). This test fails the build if any is used
 * bare — the mechanical backstop that `noColorLiterals` (which only checks for
 * literal fallbacks) structurally cannot provide.
 *
 * Sources: VS Code `src/vs/platform/theme/common/colorRegistry.ts` — each of
 * these `registerColor` calls passes `{ dark: null, light: null, hcDark: … }`
 * (or only an hc value), i.e. no default outside high contrast.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const webviewRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** VS Code colors with a null default in normal dark/light themes. */
const KNOWN_OPTIONAL = [
    "--vscode-input-border", // input.border: null dark/light, contrastBorder in HC
    "--vscode-contrastActiveBorder", // only defined in high-contrast themes
    "--vscode-toolbar-hoverOutline", // null dark/light
    "--vscode-toolbar-activeBackground", // null dark/light
    "--vscode-widget-border", // null dark/light
    "--vscode-editorSuggestWidget-border", // null dark/light
];

/** Matches a bare use: `var(--vscode-<optional>)` with no fallback argument. */
const BARE_OPTIONAL_RE = new RegExp(
    `var\\(\\s*(${KNOWN_OPTIONAL.map((v) => v.replace(/[-]/g, "\\$&")).join("|")})\\s*\\)`,
    "g",
);

function collectFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === "__tests__" || name === "__mocks__") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) collectFiles(full, out);
        else if (/\.(ts|css)$/.test(name)) out.push(full);
    }
    return out;
}

function findBareOptionals(): string[] {
    const violations: string[] = [];
    for (const file of collectFiles(webviewRoot)) {
        const text = readFileSync(file, "utf8");
        text.split("\n").forEach((line, i) => {
            for (const m of line.matchAll(BARE_OPTIONAL_RE)) {
                violations.push(`${relative(webviewRoot, file)}:${i + 1}  ${m[1]}`);
            }
        });
    }
    return violations.sort();
}

describe("optional --vscode-* colors must carry a fallback", () => {
    it("the matcher should flag a bare optional color but not one with a fallback", () => {
        const flag = (s: string) => BARE_OPTIONAL_RE.test(s);
        BARE_OPTIONAL_RE.lastIndex = 0;
        expect(flag("border: 1px solid var(--vscode-input-border)")).toBe(true);
        BARE_OPTIONAL_RE.lastIndex = 0;
        expect(flag("border-color: var(--vscode-contrastActiveBorder, transparent)")).toBe(false);
        BARE_OPTIONAL_RE.lastIndex = 0;
        expect(flag("border: 1px solid var(--vscode-input-border, var(--vscode-panel-border))")).toBe(false);
        BARE_OPTIONAL_RE.lastIndex = 0;
        // A defaulted color used bare is fine — only the known-optional set is flagged.
        expect(flag("border: 1px solid var(--vscode-panel-border)")).toBe(false);
    });

    it("no known-optional color should be used without a fallback", () => {
        expect(findBareOptionals()).toEqual([]);
    });
});
