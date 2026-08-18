/**
 * CI guard, two rules:
 *
 * 1. No literal COLOR fallbacks in `var(--vscode-*, <literal>)` anywhere under
 *    webview/ (CSS and inline TS styles).
 * 2. No bare color literals (hex, rgb()/rgba()/hsl()/hsla()/hwb(), named CSS
 *    colors) in webview CSS declaration values at all — theme colors come from
 *    `--vscode-*` variables (AGENTS.md, "No custom colors").
 *
 * Rule 2 reads CSS wherever it is authored: `.css` files, and the CSS that lives
 * in `.ts` — injected stylesheets and literal inline style writes, extracted by
 * `helpers/cssSources.ts`. It used to walk `.css` only, which made the rule a
 * property of the file extension rather than of the code: `el.style.color =
 * "#ff0000"` was green while `color: #ff0000` failed immediately (MAR-260). Note
 * the asymmetry that gap had — rule 1 below always scanned `.ts`, so the file
 * was already reading TypeScript; only rule 2's sweep stopped at `.css`.
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
 * the guard. The scan is DECLARATION-based, so a value wrapped across lines is
 * still read (see DECLARATION_RE).
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
import { cssSourcesInFile, cssSourcesInTypeScript } from "./helpers/cssSources";

const webviewRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Non-color --vscode-* variables whose literal fallbacks are legitimate. */
const NON_COLOR_VARS = new Set([
    "--vscode-font-family",
    "--vscode-font-size",
    "--vscode-editor-font-family",
    "--vscode-editor-font-size",
]);

/**
 * The one stylesheet whose job IS literals: the palette a non-VS-Code host
 * injects in place of the workbench's --vscode-* variables. Inside VS Code it
 * is never loaded (hostPalette.test.ts pins that), so it is not a fallback and
 * cannot mask a theme. Its own guard checks its coverage.
 */
const HOST_PALETTE = "hostPalette.css";

function collectFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === "__tests__" || name === "__mocks__" || name === HOST_PALETTE) continue;
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

/**
 * One CSS declaration — `prop:` then a value running to `;` or the closing `}`.
 *
 * The value class spans NEWLINES, which is the entire point (MAR-261): the scan
 * used to walk one line at a time and skip any line without a `:`, so a value
 * broken across lines was invisible to it, and the guard's own header asserted
 * "declaration values in this codebase are single-line" — already false in five
 * places, three of them `box-shadow`, the exact construct the shadow carve-out
 * below exists for. A prettier config or one wrapped declaration would have
 * disarmed the rule silently, on files nobody edited.
 *
 * Excluding `{` from the value is what keeps NON-declarations out, without a
 * selector parser: `.tb-x:hover {`, `&:hover {` and `@media (min-width: 500px) {`
 * all reach a `{` before any terminator, so none can match. Custom properties
 * (`--ui-card-shadow:`) are declarations and are matched deliberately.
 */
const DECLARATION_RE = /(--[\w-]+|[a-zA-Z][\w-]*)\s*:([^;{}]*)(?=[;}])/g;

/** 1-based line number of an offset, via the file's newline positions. */
function lineNumberAt(newlineOffsets: number[], offset: number): number {
    let lo = 0, hi = newlineOffsets.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (newlineOffsets[mid] < offset) lo = mid + 1;
        else hi = mid;
    }
    return lo + 1;
}

/** Scan one CSS file's text; returns "<line-number>  <matched literal>" hits. */
function scanCssTextForColorLiterals(text: string): string[] {
    const hits: string[] = [];
    // Comments are blanked in place (same length, same newlines), so every
    // offset below indexes both the stripped and the RAW text identically.
    const stripped = stripCssComments(text);
    const newlineOffsets: number[] = [];
    for (let i = 0; i < text.length; i++) { if (text[i] === "\n") newlineOffsets.push(i); }

    // Annotations live in comments, so they are read off the RAW text.
    const annotations = [...text.matchAll(new RegExp(EXEMPT_ANNOTATION_RE.source, "g"))]
        .map((m) => m.index ?? 0);

    for (const decl of stripped.matchAll(DECLARATION_RE)) {
        const [, prop, rawValue] = decl;
        const declStart = decl.index ?? 0;
        const valueStart = declStart + decl[0].length - rawValue.length;
        const declEnd = declStart + decl[0].length;

        // An annotation exempts the declaration it sits INSIDE, or the one it
        // directly follows on the same line — which is the shape every existing
        // annotation has (`color: #fff; /* color-literal-ok: … */`). Deliberately
        // not "anywhere on a line the declaration touches": that would let an
        // annotation leak onto the next declaration of a multi-line rule, and
        // the non-leak guarantee has its own test below.
        const exempt = annotations.some((a) =>
            (a >= declStart && a < declEnd)
            || (a >= declEnd && lineNumberAt(newlineOffsets, a) === lineNumberAt(newlineOffsets, declEnd)),
        );
        if (exempt) continue;

        let value = rawValue;
        // The shadow carve-out now asks the PROPERTY, not the line — a wrapped
        // `box-shadow:` used to take its own value out of scope by accident.
        if (SHADOW_DECL_RE.test(`;${prop}:`) || value.includes("drop-shadow(")) {
            value = value.replace(MONO_RGBA_RE, (m, r, g, b) =>
                r === g && g === b ? " ".repeat(m.length) : m,
            );
        }
        for (const re of [HEX_COLOR_RE, COLOR_FN_RE, NAMED_COLOR_RE]) {
            // Report the line the LITERAL is on, not the line the declaration
            // opens on — for a wrapped value those differ, and the literal's is
            // the one you need to go fix.
            for (const m of value.matchAll(re)) {
                hits.push(`${lineNumberAt(newlineOffsets, valueStart + (m.index ?? 0))}  ${m[0]}`);
            }
        }
    }
    return hits;
}

/**
 * Every unit the bare-literal rule scans: `.css` files, plus the CSS authored
 * in `.ts`.
 *
 * Extracted so the sweep's REACH can be asserted. The rule reports violations
 * by returning an empty array and the tree is clean, so disconnecting the `.ts`
 * half is entirely silent — a test over the returned violations cannot tell a
 * clean scan from an absent one. A test over the INPUTS can.
 */
function colorScanUnits(): { label: string; text: string; startLine: number }[] {
    const units: { label: string; text: string; startLine: number }[] = [];
    for (const file of collectFiles(webviewRoot)) {
        if (!file.endsWith(".css")) continue;
        units.push({ label: relative(webviewRoot, file), text: readFileSync(file, "utf8"), startLine: 1 });
    }
    // `scanCssTextForColorLiterals` reports a line number relative to the text
    // it was handed, so `startLine` rebases it onto the source file — a hit has
    // to name a line you can go and edit.
    for (const source of cssSourcesInTypeScript(webviewRoot)) {
        units.push({ label: source.file, text: source.text, startLine: source.startLine });
    }
    return units;
}

function findBareColorLiterals(): string[] {
    const violations: string[] = [];
    for (const unit of colorScanUnits()) {
        for (const hit of scanCssTextForColorLiterals(unit.text)) {
            // One rebasing path for both kinds: a `.css` unit has `startLine`
            // 1, and `line + 1 - 1` is the identity, so a `.css` hit comes out
            // exactly as it did before this was unified.
            const [, line, literal] = /^(\d+)  (.*)$/.exec(hit) ?? [];
            violations.push(`${unit.label}:${Number(line) + unit.startLine - 1}  ${literal}`);
        }
    }
    return violations.sort();
}

describe("no literal --vscode-* color fallbacks in webview", () => {
    // Both rules below report violations by returning an EMPTY array when they
    // find nothing — which is also what they return if collectFiles stops
    // finding files at all (a moved directory, a changed extension filter).
    // Pin the sweep's reach so a vacuous pass can't masquerade as a clean one.
    it("the sweep should actually reach the webview source it claims to guard", () => {
        const files = collectFiles(webviewRoot);
        expect(files.filter((f) => f.endsWith(".css")).length).toBeGreaterThan(10);
        expect(files.filter((f) => f.endsWith(".ts")).length).toBeGreaterThan(50);
    });

    it("the BARE-LITERAL rule should reach CSS authored in .ts, not only .css files", () => {
        // The rule above pins `collectFiles`, which is only the `.css` half.
        // The `.ts` half is the one that can vanish silently — remove it and
        // every case in this file still passes — so it is asserted over the
        // scan's INPUTS rather than its output.
        //
        // Containment, not an exact list: a third injected stylesheet must be
        // picked up and guarded automatically rather than registered here first.
        const labels = colorScanUnits().map((u) => u.label);
        expect(labels).toEqual(expect.arrayContaining([
            "components/findBar/highlightStyles.ts",
            "components/lineNumbers/styles.ts",
        ]));
    });

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
        // The annotation exempts one declaration, not a region: the next one is
        // still guarded, wherever the line breaks fall.
        expect(
            scanCssTextForColorLiterals(
                "a { color: #fff; /* color-literal-ok: chrome */\n  background: #000; }",
            ),
        ).toHaveLength(1);
        // ...including when the exempted declaration is itself wrapped, so the
        // annotation sits inside it rather than after it.
        expect(
            scanCssTextForColorLiterals(
                "a {\n  background:\n    #fff; /* color-literal-ok: chrome */\n  color: #000;\n}",
            ),
        ).toEqual(["4  #000"]);
    });

    // MAR-261. The scan used to walk lines and skip any without a `:`, so a
    // value on a continuation line was invisible — and the precondition for that
    // ("declaration values in this codebase are single-line") was a property of
    // the current FORMATTING, not of the rule. Five declarations in the tree
    // already wrap, three of them `box-shadow`.
    it("a color literal on a value's continuation line should be flagged, not skipped", () => {
        expect(
            scanCssTextForColorLiterals("a {\n  background:\n    #ff0000;\n}"),
        ).toEqual(["3  #ff0000"]);
        // The line reported is the LITERAL's, not the declaration's opening line.
        expect(
            scanCssTextForColorLiterals("a {\n  box-shadow:\n    0 1px 2px rgba(255, 0, 0, 0.3);\n}"),
        ).toEqual(["3  rgba("]);
        // A wrapped shadow keeps its monochrome carve-out — the old scan gave it
        // one only by accident, having skipped the continuation line entirely.
        expect(
            scanCssTextForColorLiterals(
                "a {\n  box-shadow:\n    0 1px 3px rgba(0, 0, 0, 0.1),\n    0 5px 14px rgba(0, 0, 0, 0.11);\n}",
            ),
        ).toEqual([]);
        // A wrapped named color counts too.
        expect(
            scanCssTextForColorLiterals("a {\n  border:\n    1px solid crimson;\n}"),
        ).toEqual(["3  crimson"]);
    });

    it("selectors, at-rule preludes, and nesting should never be read as declarations", () => {
        // Each of these holds a `:` and a color-ish word outside any value.
        expect(scanCssTextForColorLiterals(".red:hover {\n  color: var(--vscode-foreground);\n}")).toEqual([]);
        expect(scanCssTextForColorLiterals("@media (min-width: 500px) {\n  a { color: var(--x); }\n}")).toEqual([]);
        expect(scanCssTextForColorLiterals("a {\n  &:hover { color: var(--x); }\n}")).toEqual([]);
        // ...and a real declaration inside them is still scanned.
        expect(scanCssTextForColorLiterals(".red:hover {\n  color: #fff;\n}")).toEqual(["2  #fff"]);
        expect(scanCssTextForColorLiterals("a {\n  &:hover { color: #fff; }\n}")).toEqual(["2  #fff"]);
    });

    it("translucent monochrome rgba() in shadows should be exempt, tinted or opaque ones should not", () => {
        expect(
            scanCssTextForColorLiterals("a { box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35); }"),
        ).toEqual([]);
        expect(
            scanCssTextForColorLiterals("a { filter: drop-shadow(0 4px 24px rgba(0, 0, 0, 0.5)); }"),
        ).toEqual([]);
        // A shadow-valued token is still a shadow (ui/chrome.css --ui-card-shadow),
        // including the multi-layer values the elevation tokens actually hold.
        expect(
            scanCssTextForColorLiterals(
                ":root { --ui-card-shadow: 0 1px 3px rgba(0, 0, 0, 0.1), 0 5px 14px rgba(0, 0, 0, 0.11); }",
            ),
        ).toEqual([]);
        // Tier-suffixed shadow tokens count too (--ui-card-shadow-overlay).
        expect(
            scanCssTextForColorLiterals(
                ":root { --ui-card-shadow-overlay: 0 2px 6px rgba(0, 0, 0, 0.12), 0 12px 32px rgba(0, 0, 0, 0.16); }",
            ),
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

// MAR-260. The scan above used to stop at `.css`, so the rule was a property of
// the file extension: the identical value written from TypeScript was green.
// These cases pin the extension itself — every one of them was verified to FAIL
// with the `.ts` sweep removed from `findBareColorLiterals`.
describe("bare color literals in CSS authored from TypeScript", () => {
    const scan = (ts: string) =>
        cssSourcesInFile(ts, "probe.ts").flatMap((s) => scanCssTextForColorLiterals(s.text));

    it("a color literal written to a style property should be flagged", () => {
        expect(scan(`el.style.color = "#ff0000";`)).toHaveLength(1);
        expect(scan(`el.style.backgroundColor = "rgb(1, 2, 3)";`)).toHaveLength(1);
        expect(scan(`el.style.borderColor = "crimson";`)).toHaveLength(1);
        // …however the write is spelled.
        expect(scan("el.style.color = `#ff0000`;")).toHaveLength(1);
        expect(scan(`el.style.cssText = "position:fixed;color:#ff0000";`)).toHaveLength(1);
        expect(scan(`el.style.setProperty("color", "#ff0000");`)).toHaveLength(1);
    });

    it("a color literal inside an injected stylesheet should be flagged", () => {
        // The shape two real modules already have (findBar/highlightStyles.ts,
        // lineNumbers/styles.ts): a whole stylesheet parked in a template
        // literal, which moving it out of a `.css` file silently unguarded.
        expect(scan("export const CSS = `\n.x {\n  color: #ff0000;\n}\n`;")).toHaveLength(1);
    });

    it("a themed or non-literal style write should not be flagged", () => {
        expect(scan(`el.style.color = "var(--vscode-foreground)";`)).toEqual([]);
        expect(scan(`el.style.backgroundColor = "transparent";`)).toEqual([]);
        // A value the guard cannot read is a value it must not guess at: copied
        // from a computed style, or interpolated.
        expect(scan(`sticky.style.color = other.style.color;`)).toEqual([]);
        expect(scan("el.style.color = `${theme.accent}`;")).toEqual([]);
        // Composing a token is not minting a value.
        expect(scan(`el.style.setProperty("--ui-radius-s", "4px");`)).toEqual([]);
    });

    it("a color word in TypeScript that is not a style write should not be flagged", () => {
        // The sweep reads CSS, not prose or identifiers — an extension that
        // simply grepped `.ts` for `#rrggbb` would flag all of these.
        expect(scan(`const red = "#ff0000"; // a plain constant`)).toEqual([]);
        expect(scan(`/* the white canvas is #ffffff */`)).toEqual([]);
        expect(scan(`el.setAttribute("data-tint", "#ff0000");`)).toEqual([]);
        // Brand-colored SVG marks (components/pathLink/fileIcons.ts) are
        // theme-independent by design and stay out of scope.
        expect(scan('export const icon = `<svg><path style="fill:#c09553"/></svg>`;')).toEqual([]);
    });

    it("a color-literal-ok line comment WITH a reason should exempt, without one should not", () => {
        expect(
            scan(`el.style.color = "#fff"; // color-literal-ok: white-on-dark lightbox chrome`),
        ).toEqual([]);
        expect(scan(`el.style.color = "#fff"; // color-literal-ok:`)).toHaveLength(1);
    });

    it("a flagged literal should report the line it is on in the source file", () => {
        const sources = cssSourcesInFile(
            "const a = 1;\nconst b = 2;\nel.style.color = \"#ff0000\";\n",
            "probe.ts",
        );
        expect(sources).toHaveLength(1);
        expect(sources[0].startLine).toBe(3);
    });
});
