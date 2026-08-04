/**
 * Guard for the ui-* chrome token system (webview/ui/chrome.css).
 *
 * "Webview CSS" below means CSS wherever it is authored — `.css` files, and the
 * CSS that lives in `.ts`: injected stylesheets and literal inline style writes
 * (`helpers/cssSources.ts`). Scanning stylesheets only made every rule here a
 * property of the file extension rather than of the code, so `el.style.fontSize
 * = "11px"` from a NodeView passed while the identical declaration in a
 * stylesheet failed immediately (MAR-260).
 *
 * Every border-radius in webview CSS must compose the radius scale
 * (--ui-radius-s/m/l/xl/pill) instead of minting a new pixel value, chrome
 * text sizes below 14px must come from the --ui-fs-* scale, and a
 * shadow must take its ink from --ui-card-shadow / -overlay rather than mixing
 * its own — neither a hand-tuned rgba() nor a per-theme --vscode-*-shadow.
 * This is a ratchet, not a style preference: the pre-token codebase had six
 * radius values and four hand-rolled 12px button families that drifted
 * apart precisely because nothing failed when a new value appeared.
 *
 * Deliberate exceptions are listed explicitly WITH their reason — extend the
 * lists only for a value that is genuinely tuned, not for convenience.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { cssSourcesInFile, cssSourcesInTypeScript } from "./helpers/cssSources";

const WEBVIEW_DIR = join(__dirname, "..");

function cssFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...cssFiles(p));
        else if (name.endsWith(".css")) out.push(p);
    }
    return out;
}

function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...tsFiles(p));
        else if (name.endsWith(".ts")) out.push(p);
    }
    return out;
}

/**
 * CSS text → declarations of one property, with line numbers, comments stripped.
 *
 * A declaration ends at `;` **or at the rule's closing `}`**. Requiring the
 * semicolon — which this did until MAR-260 — silently exempted the last
 * declaration in any rule that omits it, which is legal CSS and the form a
 * minifier and several hand-written rules use. That is the same failure MAR-261
 * fixed in `noColorLiterals.test.ts`'s scanner (whose `DECLARATION_RE` has
 * terminated on `[;}]` since): a rule that is really a property of the
 * *formatting* rather than of the code. Verified before fixing —
 * `a { border-radius: 7px }` returned nothing while `a { border-radius: 7px; }`
 * returned `7px`.
 *
 * `{}` are excluded from the value so a match can never run past its own rule,
 * and an empty value (`color: ;`, or the `el.style.display = ""` reset once
 * synthesized) declares nothing rather than a violation-shaped blank.
 */
function declarationsIn(text: string, prop: string): Array<{ line: number; value: string }> {
    const src = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    const out: Array<{ line: number; value: string }> = [];
    const re = new RegExp(`${prop}\\s*:\\s*([^;{}]+)(?=[;}])`, "g");
    for (let m = re.exec(src); m; m = re.exec(src)) {
        const value = m[1].trim();
        if (value === "") continue;
        out.push({ line: src.slice(0, m.index).split("\n").length, value });
    }
    return out;
}

/**
 * One chunk of CSS to scan, wherever it was authored: a `.css` file, or CSS
 * living in a `.ts` — an injected stylesheet or a literal inline style write
 * (MAR-260; `helpers/cssSources.ts` explains what is and is not extracted).
 * `label` and `startLine` exist so a violation names a line you can go and edit.
 */
interface CssUnit {
    label: string;
    text: string;
    startLine: number;
}

/** Declarations of one property across a unit, in the SOURCE file's line numbers. */
function declarations(unit: CssUnit, prop: string): Array<{ line: number; value: string }> {
    return declarationsIn(unit.text, prop).map((d) => ({
        ...d,
        line: d.line + unit.startLine - 1,
    }));
}

// Radius values allowed OUTSIDE the token scale: none/hairline detail and
// true circles. Everything else must reference var(--ui-radius-*).
const RADIUS_LITERAL_OK = new Set(["0", "1px", "2px", "50%", "inherit"]);

// Chrome font sizes that legitimately bypass the --ui-fs-* scale.
const FONT_EXCEPTIONS: Array<{ file: string; value: string; reason: string }> = [
    { file: "components/toc/toc.css", value: "11.5px", reason: "TOC tree + review-list optical tuning (dense outline)" },
    { file: "components/toc/toc.css", value: "10.5px", reason: "review-list row action (dense list)" },
    { file: "components/toc/toc.css", value: "9.5px", reason: "review-list tag chip (uppercase micro-label)" },
    { file: "components/toolbar/toolbar.css", value: "10px", reason: "A− glyph of the font-size stepper (optical pair with the 14px A+)" },
];

describe("chrome design tokens (ui/chrome.css)", () => {
    const files = cssFiles(WEBVIEW_DIR).filter(
        (f) => !f.endsWith(join("ui", "chrome.css")),
    );

    // `.css` files plus the CSS that lives in `.ts`. Scanning stylesheets only
    // made every rule below a property of the file extension rather than of the
    // code — `el.style.borderRadius = "7px"` was green while `border-radius: 7px`
    // failed immediately, and two whole stylesheets had already moved into
    // template literals for launch-cost reasons, out of this guard's sight.
    const fromTs = cssSourcesInTypeScript(WEBVIEW_DIR);
    const units: CssUnit[] = [
        ...files.map((f) => ({
            label: relative(WEBVIEW_DIR, f).split(sep).join("/"),
            text: readFileSync(f, "utf8"),
            startLine: 1,
        })),
        ...fromTs.map((s) => ({ label: s.file, text: s.text, startLine: s.startLine })),
    ];

    it("webview CSS should exist to guard", () => {
        expect(files.length).toBeGreaterThan(10);
    });

    it("the sweep should reach the CSS that lives in .ts, not only .css files", () => {
        // Every rule below reports an empty array when it finds nothing — which
        // is also what it returns if the TS extraction silently stops working
        // (a moved directory, a parse that throws, a renamed helper). Pin the
        // reach so a vacuous pass cannot masquerade as a clean one.
        //
        // A CONTAINMENT check, not an exact list: a third injected stylesheet
        // should be picked up and guarded automatically, which is the entire
        // point — it must not have to be registered here first.
        const stylesheets = fromTs.filter((s) => s.kind === "stylesheet").map((s) => s.file);
        expect(stylesheets).toEqual(expect.arrayContaining([
            "components/findBar/highlightStyles.ts",
            "components/lineNumbers/styles.ts",
        ]));
        expect(fromTs.filter((s) => s.kind === "inline").length).toBeGreaterThan(50);
    });

    it("every border-radius should compose the --ui-radius-* scale", () => {
        const violations: string[] = [];
        for (const unit of units) {
            for (const { line, value } of declarations(unit, "border-radius")) {
                // Compound values ("0 0 var(--ui-radius-m) var(--ui-radius-m)")
                // are checked token by token.
                const parts = value.split(/\s+/);
                for (const part of parts) {
                    if (part.startsWith("var(--ui-radius-")) continue;
                    if (RADIUS_LITERAL_OK.has(part)) continue;
                    violations.push(`${unit.label}:${line} — border-radius: ${value}`);
                    break;
                }
            }
        }
        expect(violations, violations.join("\n")).toEqual([]);
    });

    it("chrome font sizes below 14px should compose the --ui-fs-* scale", () => {
        const violations: string[] = [];
        for (const unit of units) {
            const rel = unit.label;
            for (const { line, value } of declarations(unit, "font-size")) {
                const m = /^([0-9.]+)px$/.exec(value);
                if (!m) continue; // em/calc/var sizing is the content domain
                const px = parseFloat(m[1]);
                // ≥14px literals are glyph/display tuning (a 14px ×, a 22px ⤢),
                // not text-scale drift. There is NO lower bound: the band used
                // to start at 9px on the reasoning that "below 9px nothing
                // exists" — which described the codebase rather than the rule,
                // so an 8px literal was the one chrome size that could be
                // added freely. Nothing sits below 9px today, so the floor
                // cost nothing to remove.
                if (px >= 14) continue;
                const excepted = FONT_EXCEPTIONS.some(
                    (e) => rel.endsWith(e.file) && e.value === value,
                );
                if (!excepted) {
                    violations.push(`${rel}:${line} — font-size: ${value}`);
                }
            }
        }
        expect(violations, violations.join("\n")).toEqual([]);
    });

    // The size band above is the ratchet on the --ui-fs-* TOKENS. This is the
    // ratchet on the type-scale CLASSES, which is a different failure: a
    // surface can be perfectly token-clean on size and still drift on weight
    // or ink, because it restates the whole triple instead of composing the
    // grade. .ui-label and .ui-caption sat with ZERO adopters for months
    // (MAR-193) — dead CSS reads exactly like a scale nobody needed, and the
    // next surface then has no reason to compose it either. A grade with no
    // adopter is either dead or a design decision; both deserve a failing
    // test rather than silence.
    it("every grade in the ui-* type scale should have at least one adopter", () => {
        const scale = readFileSync(join(WEBVIEW_DIR, "ui", "typography.css"), "utf8");
        const grades = [...scale.matchAll(/^\.(ui-[\w-]+)\s*\{/gm)].map((m) => m[1]);
        expect(grades.length, "ui/typography.css declares no grades").toBeGreaterThan(0);

        // Comments are stripped first: several files NAME a grade while
        // explaining why they compose it, and a prose mention is not an
        // adopter — counting one would let the last real use be deleted with
        // the guard still green.
        const sources = tsFiles(WEBVIEW_DIR).map((f) =>
            readFileSync(f, "utf8")
                .replace(/\/\*[\s\S]*?\*\//g, "")
                .replace(/(^|\s)\/\/.*$/gm, "$1"),
        );
        const orphans = grades.filter(
            (grade) => !sources.some((src) => new RegExp(`\\b${grade}(?![\\w-])`).test(src)),
        );
        expect(
            orphans,
            `Type grades with no adopter: ${orphans.join(", ")}. Either compose ` +
                "the grade at a real creation site, or delete it from " +
                "ui/typography.css — an unused grade is dead CSS that quietly " +
                "argues the scale isn't worth composing.",
        ).toEqual([]);
    });

    it("no shadow should mix its own ink instead of taking it from --ui-card-shadow*", () => {
        // Two ways a shadow escapes the scale, both of which shipped before:
        //
        //   1. A raw rgba()/hsl() ink — tuned by eye, retunable by nobody. That
        //      is how five one-off alphas (0.25/0.45/0.6) ended up beside the
        //      tokens while the tokens themselves were far too heavy.
        //   2. A THEME shadow variable (--vscode-widget-shadow and friends).
        //      Those invert per theme, so a panel using one lifted to a light
        //      cast that read as a glow on dark themes — the bug #115 fixed by
        //      moving four surfaces onto the always-dark tokens. Nothing uses
        //      one today; this keeps it that way.
        //
        // Rings and hairlines drawn WITH box-shadow (focus rings, drop-target
        // rings, inset 1px lines) are not elevation and pass untouched: their
        // color comes from a themed var() or color-mix(), never mixed ink — so
        // this rule needs no exception list. `filter` is scanned too, since
        // drop-shadow() is the same effect by another property; the one that
        // existed was shadowing a mermaid diagram's own strokes (drop-shadow
        // traces the svg's opaque pixels) and was deleted, not excepted.
        const RAW_INK = /\b(?:rgba?|hsla?)\s*\(/;
        const THEME_SHADOW_VAR = /var\(\s*--vscode-[\w-]*shadow/i;
        const violations: string[] = [];
        for (const unit of units) {
            const scanned = [
                ...declarations(unit, "box-shadow").map((d) => ({ ...d, prop: "box-shadow" })),
                ...declarations(unit, "filter")
                    .filter((d) => d.value.includes("drop-shadow("))
                    .map((d) => ({ ...d, prop: "filter" })),
            ];
            for (const { line, value, prop } of scanned) {
                if (!RAW_INK.test(value) && !THEME_SHADOW_VAR.test(value)) continue;
                violations.push(`${unit.label}:${line} — ${prop}: ${value}`);
            }
        }
        expect(violations, violations.join("\n")).toEqual([]);
    });
});

// MAR-260. The repo-wide rules above are clean today and would have stayed
// clean on their first run with the `.ts` sweep added — which would have told
// nobody anything. These cases pin the matcher itself: each was verified to
// FAIL with the `cssSourcesInTypeScript` entry removed from `units`.
describe("chrome design tokens in CSS authored from TypeScript", () => {
    /** Values of one property that a chunk of TypeScript declares. */
    const declared = (ts: string, prop: string) =>
        cssSourcesInFile(ts, "probe.ts").flatMap((s) =>
            declarationsIn(s.text, prop).map((d) => d.value),
        );

    it("a raw radius or chrome font size written to a style property should be seen", () => {
        expect(declared(`el.style.borderRadius = "7px";`, "border-radius")).toEqual(["7px"]);
        expect(declared(`el.style.fontSize = "11px";`, "font-size")).toEqual(["11px"]);
        expect(declared(`el.style.cssText = "border-radius:7px";`, "border-radius")).toEqual(["7px"]);
        // …and the values a scan must NOT reject, so the rule stays about
        // minting rather than about writing a style at all.
        expect(declared(`el.style.borderRadius = "var(--ui-radius-m)";`, "border-radius"))
            .toEqual(["var(--ui-radius-m)"]);
    });

    it("a computed or interpolated size should not be read as a minted value", () => {
        // headingSticky.ts copies the heading's own size; the content font-size
        // preset interpolates a percentage. Neither mints a chrome token, and a
        // guard that cannot read the value must not guess at it.
        expect(declared(`sticky.style.fontSize = style.fontSize;`, "font-size")).toEqual([]);
        expect(declared("el.style.fontSize = `${pct}%`;", "font-size")).toEqual([]);
    });

    it("composing a radius token should not be read as minting one", () => {
        expect(declared(`el.style.setProperty("--ui-radius-s", "4px");`, "border-radius")).toEqual([]);
    });

    it("an injected stylesheet's declarations should be seen", () => {
        // The shape findBar/highlightStyles.ts and lineNumbers/styles.ts have.
        expect(declared("export const CSS = `\n.x {\n  border-radius: 7px;\n}\n`;", "border-radius"))
            .toEqual(["7px"]);
    });

    // MAR-260, found while extending the sweep: the scanner required a trailing
    // `;`, so the last declaration in a rule that omits one — legal CSS, in
    // `.css` files as much as in TypeScript — was exempt from all three rules
    // above. Reverting `(?=[;}])` to `;` in `declarationsIn` fails these.
    it("a declaration terminated by the rule's closing brace should be seen", () => {
        expect(declarationsIn("a { border-radius: 7px }", "border-radius")).toEqual([
            { line: 1, value: "7px" },
        ]);
        expect(declarationsIn("a { color: red; font-size: 11px }", "font-size")).toEqual([
            { line: 1, value: "11px" },
        ]);
        // A value can never run past its own rule into the next one.
        expect(declarationsIn("a { font-size: 11px }\nb { color: red }", "font-size")).toEqual([
            { line: 1, value: "11px" },
        ]);
        // An empty value declares nothing — `el.style.borderRadius = ""` is a
        // reset, not a minted radius.
        expect(declarationsIn(`a { border-radius: ; }`, "border-radius")).toEqual([]);
    });

    it("a violation should report the line it is on in the source file", () => {
        const unit = cssSourcesInFile("const a = 1;\nel.style.borderRadius = \"7px\";\n", "probe.ts");
        expect(declarations({ label: "probe.ts", text: unit[0].text, startLine: unit[0].startLine },
            "border-radius")).toEqual([{ line: 2, value: "7px" }]);
    });
});
