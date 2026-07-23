/**
 * CI guard, two rules:
 *
 * 1. No literal COLOR fallbacks in `var(--vscode-*, <literal>)` anywhere under
 *    webview/ (CSS and inline TS styles).
 * 2. No bare color literals (hex, rgb()/rgba()/hsl()/hsla()/hwb(), named CSS
 *    colors) in webview CSS declaration values at all — theme colors come from
 *    `--vscode-*` variables (AGENTS.md, "No custom colors").
 *
 * Rule 2 exemptions (both documented at their definitions below):
 * - An explicit same-line CSS comment annotation "color-literal-ok: <reason>"
 *   with a non-empty reason — for surfaces that are deliberately theme-INDEPENDENT,
 *   e.g. the always-dark image/mermaid lightbox scrims and their white-on-dark
 *   chrome, and the fixed-white mermaid diagram canvas.
 * - Translucent MONOCHROME rgba() (r==g==b, alpha<1) inside shadow declarations
 *   (box-shadow / text-shadow / drop-shadow()): a translucent black shadow is a
 *   depth cue, not palette, and reads correctly on any theme. A tinted shadow
 *   is still flagged.
 * Comments are stripped before scanning, so prose mentioning colors never trips
 * the guard. The scan is line-based (declaration values in this codebase are
 * single-line).
 *
 * Rule 1 details:
 * Inside VS Code the webview always receives the full resolved `--vscode-*`
 * palette — pinned/custom theme overrides were removed entirely (auto-only), so
 * a native variable is never absent. A literal fallback is therefore dead code
 * that never renders, and a grep trap: searching for a color turns up values
 * that don't apply. The rule (AGENTS.md, "No custom colors") is now enforced
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

// ── Rule 2: bare color literals in webview CSS ──────────────────────────────

/**
 * Same-line exemption annotation. The reason is REQUIRED — an empty
 * `color-literal-ok:` does not exempt, so every exception carries its "why".
 */
const EXEMPT_ANNOTATION_RE = /\/\*\s*color-literal-ok:\s*[^\s*][\s\S]*?\*\//;

/** Bare hex color (#fff, #e0e0e0, #ffffff80, ...). */
const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/g;

/** Color-function literals. */
const COLOR_FN_RE = /\b(?:rgb|rgba|hsl|hsla|hwb)\(/g;

/**
 * Named CSS colors as standalone value words. `transparent` / `currentColor`
 * are CSS-wide-ish keywords, not palette choices, and are deliberately absent.
 * The trailing lookahead also excludes `(` so `tan(45deg)` (the trig function)
 * never matches.
 */
const NAMED_COLORS =
    ("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
        "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
        "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
        "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
        "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
        "ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
        "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
        "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
        "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
        "mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise " +
        "mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab " +
        "orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru " +
        "pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
        "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan " +
        "teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen").split(" ");
const NAMED_COLOR_RE = new RegExp(`(?<![\\w-])(?:${NAMED_COLORS.join("|")})(?![\\w(-])`, "gi");

/** Shadow-context detector: box-shadow/text-shadow declarations, drop-shadow(),
 *  and shadow-valued custom properties (`--ui-card-shadow:` — a token holding a
 *  shadow is still a depth cue; the monochrome-translucent rule applies to it
 *  the same way). */
const SHADOW_DECL_RE = /(?:^|[;{])\s*(?:box-shadow|text-shadow|--[\w-]*shadow[\w-]*)\s*:/;

/**
 * Translucent monochrome rgba() — allowed ONLY inside shadow declarations
 * (a depth cue, not palette). r==g==b and alpha < 1.
 */
const MONO_RGBA_RE = /rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0?\.\d+|0)\s*\)/g;

/** Blank out block comments while preserving line structure. */
function stripCssComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** Scan one CSS file's text; returns "<line-number>  <matched literal>" hits. */
function scanCssTextForColorLiterals(text: string): string[] {
    const hits: string[] = [];
    const rawLines = text.split("\n");
    const lines = stripCssComments(text).split("\n");
    lines.forEach((line, i) => {
        // The annotation lives in a comment, so test the RAW line for it.
        if (EXEMPT_ANNOTATION_RE.test(rawLines[i])) return;
        // Only declaration values can hold colors; skip pure-selector lines.
        const colon = line.indexOf(":");
        if (colon === -1) return;
        let value = line.slice(colon + 1);
        if (SHADOW_DECL_RE.test(line) || line.includes("drop-shadow(")) {
            value = value.replace(MONO_RGBA_RE, (m, r, g, b) =>
                r === g && g === b ? " ".repeat(m.length) : m,
            );
        }
        for (const re of [HEX_COLOR_RE, COLOR_FN_RE, NAMED_COLOR_RE]) {
            for (const m of value.matchAll(re)) hits.push(`${i + 1}  ${m[0]}`);
        }
    });
    return hits;
}

function findBareColorLiterals(): string[] {
    const violations: string[] = [];
    for (const file of collectFiles(webviewRoot)) {
        if (!file.endsWith(".css")) continue;
        for (const hit of scanCssTextForColorLiterals(readFileSync(file, "utf8"))) {
            violations.push(`${relative(webviewRoot, file)}:${hit}`);
        }
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

describe("no bare color literals in webview CSS", () => {
    // Sanity-check the scanner on synthetic CSS so the repo-wide guard below
    // isn't vacuous. Each case: <input condition> should <expected result>.
    it("a bare hex, rgb()/rgba()/hsl(), or named color value should be flagged", () => {
        expect(scanCssTextForColorLiterals("a { color: #fff; }")).toHaveLength(1);
        expect(scanCssTextForColorLiterals("a { color: #e0e0e0; }")).toHaveLength(1);
        expect(scanCssTextForColorLiterals("a { background: rgba(0, 0, 0, 0.5); }")).toHaveLength(1);
        expect(scanCssTextForColorLiterals("a { background: rgb(1, 2, 3); }")).toHaveLength(1);
        expect(scanCssTextForColorLiterals("a { border-color: hsl(0, 50%, 50%); }")).toHaveLength(1);
        expect(scanCssTextForColorLiterals("a { color: white; }")).toHaveLength(1);
        expect(scanCssTextForColorLiterals("a { outline-color: Red; }")).toHaveLength(1);
    });

    it("theme variables, keywords, and color-name-like words should not be flagged", () => {
        expect(scanCssTextForColorLiterals("a { color: var(--vscode-foreground); }")).toEqual([]);
        expect(scanCssTextForColorLiterals("a { background: transparent; }")).toEqual([]);
        expect(scanCssTextForColorLiterals("a { border-color: currentColor; }")).toEqual([]);
        expect(
            scanCssTextForColorLiterals(
                "a { background: color-mix(in srgb, var(--vscode-focusBorder) 15%, transparent); }",
            ),
        ).toEqual([]);
        // Hyphen-bound words and function names are not color values.
        expect(scanCssTextForColorLiterals("a { white-space: nowrap; }")).toEqual([]);
        expect(scanCssTextForColorLiterals("a { rotate: tan(45deg); }")).toEqual([]);
        // Prose in comments never trips the guard.
        expect(scanCssTextForColorLiterals("/* keep the white canvas #fff */")).toEqual([]);
    });

    it("a same-line color-literal-ok annotation WITH a reason should exempt, without one should not", () => {
        expect(
            scanCssTextForColorLiterals(
                "a { color: #fff; /* color-literal-ok: white-on-dark lightbox chrome */ }",
            ),
        ).toEqual([]);
        // A bare annotation carries no "why" and must not exempt.
        expect(
            scanCssTextForColorLiterals("a { color: #fff; /* color-literal-ok: */ }"),
        ).toHaveLength(1);
        // The annotation is line-scoped: the next line is still guarded.
        expect(
            scanCssTextForColorLiterals(
                "a { color: #fff; /* color-literal-ok: chrome */\n  background: #000; }",
            ),
        ).toHaveLength(1);
    });

    it("translucent monochrome rgba() in shadows should be exempt, tinted or opaque ones should not", () => {
        expect(
            scanCssTextForColorLiterals("a { box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35); }"),
        ).toEqual([]);
        expect(
            scanCssTextForColorLiterals("a { filter: drop-shadow(0 4px 24px rgba(0, 0, 0, 0.5)); }"),
        ).toEqual([]);
        // A shadow-valued token is still a shadow (ui/chrome.css --ui-card-shadow).
        expect(
            scanCssTextForColorLiterals(":root { --ui-card-shadow: 0 4px 12px rgba(0, 0, 0, 0.35); }"),
        ).toEqual([]);
        // Tier-suffixed shadow tokens count too (--ui-card-shadow-s).
        expect(
            scanCssTextForColorLiterals(":root { --ui-card-shadow-s: 0 2px 8px rgba(0, 0, 0, 0.3); }"),
        ).toEqual([]);
        // A tinted shadow is a palette choice and stays flagged.
        expect(
            scanCssTextForColorLiterals("a { box-shadow: 0 4px 12px rgba(255, 0, 0, 0.35); }"),
        ).toHaveLength(1);
        // The shadow carve-out does not extend to other properties.
        expect(
            scanCssTextForColorLiterals("a { background: rgba(0, 0, 0, 0.35); }"),
        ).toHaveLength(1);
    });

    it("webview CSS should contain no unexempted bare color literals", () => {
        expect(findBareColorLiterals()).toEqual([]);
    });
});
