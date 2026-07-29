/**
 * Guard for the ui-* chrome token system (webview/ui/chrome.css).
 *
 * Every border-radius in webview CSS must compose the radius scale
 * (--ui-radius-s/m/l/xl/pill) instead of minting a new pixel value, chrome
 * text sizes in the 9–13px band must come from the --ui-fs-* scale, and a
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

/** file → declarations, with line numbers, comments stripped per-line-ish. */
function declarations(file: string, prop: string): Array<{ line: number; value: string }> {
    const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) =>
        m.replace(/[^\n]/g, " "),
    );
    const out: Array<{ line: number; value: string }> = [];
    const re = new RegExp(`${prop}\\s*:\\s*([^;]+);`, "g");
    for (let m = re.exec(src); m; m = re.exec(src)) {
        out.push({
            line: src.slice(0, m.index).split("\n").length,
            value: m[1].trim(),
        });
    }
    return out;
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

    it("webview CSS should exist to guard", () => {
        expect(files.length).toBeGreaterThan(10);
    });

    it("every border-radius should compose the --ui-radius-* scale", () => {
        const violations: string[] = [];
        for (const file of files) {
            for (const { line, value } of declarations(file, "border-radius")) {
                // Compound values ("0 0 var(--ui-radius-m) var(--ui-radius-m)")
                // are checked token by token.
                const parts = value.split(/\s+/);
                for (const part of parts) {
                    if (part.startsWith("var(--ui-radius-")) continue;
                    if (RADIUS_LITERAL_OK.has(part)) continue;
                    violations.push(
                        `${relative(WEBVIEW_DIR, file)}:${line} — border-radius: ${value}`,
                    );
                    break;
                }
            }
        }
        expect(violations, violations.join("\n")).toEqual([]);
    });

    it("chrome font sizes in the 9-13px band should compose the --ui-fs-* scale", () => {
        const violations: string[] = [];
        for (const file of files) {
            const rel = relative(WEBVIEW_DIR, file).split(sep).join("/");
            for (const { line, value } of declarations(file, "font-size")) {
                const m = /^([0-9.]+)px$/.exec(value);
                if (!m) continue; // em/calc/var sizing is the content domain
                const px = parseFloat(m[1]);
                // ≥14px literals are glyph/display tuning (a 14px ×, a 22px ⤢),
                // not text-scale drift; below 9px nothing exists.
                if (px >= 14 || px < 9) continue;
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
        for (const file of files) {
            const rel = relative(WEBVIEW_DIR, file).split(sep).join("/");
            const scanned = [
                ...declarations(file, "box-shadow").map((d) => ({ ...d, prop: "box-shadow" })),
                ...declarations(file, "filter")
                    .filter((d) => d.value.includes("drop-shadow("))
                    .map((d) => ({ ...d, prop: "filter" })),
            ];
            for (const { line, value, prop } of scanned) {
                if (!RAW_INK.test(value) && !THEME_SHADOW_VAR.test(value)) continue;
                violations.push(`${rel}:${line} — ${prop}: ${value}`);
            }
        }
        expect(violations, violations.join("\n")).toEqual([]);
    });
});
