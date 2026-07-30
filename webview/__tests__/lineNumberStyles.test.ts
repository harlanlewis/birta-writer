/**
 * Guards for the line-number gutter's lazily-injected CSS.
 *
 * The rules are kept out of a `.css` file on purpose: esbuild hoists every
 * reachable stylesheet — dynamic imports included — into the single
 * render-blocking `webview.css`, and `birta.lineNumbers` is OFF by default, so a
 * stylesheet would put a feature almost nobody enables on everybody's launch
 * path. That is invisible in a behavior test, so it needs a structural one.
 *
 * CSS parked in a template literal also escapes the repo-wide sweeps:
 * `chromeTokens.test.ts` and the bare-color-literal rule in
 * `noColorLiterals.test.ts` only walk `.css` files. Both are re-imposed here.
 * (The `--vscode-*`-with-a-literal-fallback rule does reach `.ts`, so it is not
 * duplicated.)
 *
 * The gutter's *behavior* is covered by `lineNumberLayout.test.ts` (placement
 * arithmetic) and `e2e/lineNumbers` (real geometry, which jsdom cannot have).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LINE_NUMBER_CSS, ensureLineNumberStyles } from "../components/lineNumbers/styles";

const WEBVIEW_DIR = join(__dirname, "..");

/** Declared values for one property across the CSS string. */
const values = (prop: string): string[] =>
    [...LINE_NUMBER_CSS.matchAll(new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;]+);`, "g"))]
        .map((m) => m[1].trim());

describe("line-number styles: injection", () => {
    beforeEach(() => {
        document.head.innerHTML = "";
    });

    it("importing the module should inject nothing on its own", () => {
        // The whole point: a launch that never enables the setting never pays.
        expect(document.getElementById("line-number-styles")).toBeNull();
    });

    it("the first call should inject the rules into the document head", () => {
        ensureLineNumberStyles();
        const style = document.getElementById("line-number-styles");
        expect(style?.tagName).toBe("STYLE");
        expect(style?.textContent).toBe(LINE_NUMBER_CSS);
    });

    it("repeated calls should leave exactly one style element", () => {
        ensureLineNumberStyles();
        ensureLineNumberStyles();
        ensureLineNumberStyles();
        expect(document.querySelectorAll("#line-number-styles")).toHaveLength(1);
    });
});

describe("line-number styles: the rules the .css sweeps cannot reach", () => {
    it("every color should come from a --vscode-* token, never a literal", () => {
        const colors = values("color");
        expect(colors.length).toBeGreaterThan(0);
        for (const value of colors) {
            expect(value, `color literal in the gutter CSS: ${value}`).toMatch(/^var\(--vscode-[\w-]+\)$/);
        }
        // And no color literal anywhere else in the string either.
        expect(LINE_NUMBER_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(LINE_NUMBER_CSS).not.toMatch(/\b(?:rgba?|hsla?)\(/);
    });

    it("the chrome font size should compose the --ui-fs-* scale, not a px literal", () => {
        const sizes = values("font-size");
        expect(sizes.length).toBeGreaterThan(0);
        for (const value of sizes) {
            expect(value, `raw font size in the gutter CSS: ${value}`).toMatch(/var\(--ui-fs-[\w-]+\)/);
        }
    });

    it("spacing should compose the --ui-space-* scale rather than mint pixel values", () => {
        // The only bare lengths allowed are the ones that are not spacing at
        // all: `top: 0`, `height: 0`, `inset-inline-end: 0`, and the TOC's own
        // documented default widths carried inside a var() fallback.
        const stripped = LINE_NUMBER_CSS
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/var\([^)]*\)/g, "var()");
        expect(stripped, "a raw px length escaped the space scale").not.toMatch(/\d+px/);
    });
});

describe("line-number styles: layout invariants", () => {
    it("the layer should be layout-neutral and non-interactive", () => {
        // Three properties the gutter cannot ship without. `height: 0` keeps it
        // from touching the document's scroll extent; `pointer-events: none`
        // keeps the start margin free for marquee block selection; `absolute`
        // (not `fixed`) is what makes scrolling cost no measurement.
        const layer = LINE_NUMBER_CSS.slice(
            LINE_NUMBER_CSS.indexOf(".line-number-layer {"),
            LINE_NUMBER_CSS.indexOf("}", LINE_NUMBER_CSS.indexOf(".line-number-layer {")),
        );
        expect(layer).toMatch(/position:\s*absolute;/);
        expect(layer).toMatch(/height:\s*0;/);
        expect(layer).toMatch(/pointer-events:\s*none;/);
        expect(layer).not.toMatch(/position:\s*fixed;/);
    });

    it("edges should be expressed logically so the gutter can follow text direction", () => {
        // The editor has no RTL support today; this keeps the gutter from being
        // the reason it can't get any. A physical `left`/`right` here would pin
        // the column to the wrong edge the moment `direction: rtl` appears.
        expect(LINE_NUMBER_CSS).toMatch(/inset-inline-start:/);
        expect(LINE_NUMBER_CSS).toMatch(/inset-inline-end:/);
        expect(LINE_NUMBER_CSS).toMatch(/text-align:\s*end;/);
        const declarations = LINE_NUMBER_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
        expect(declarations).not.toMatch(/(?:^|[;{\s])(?:left|right):/);
        expect(declarations).not.toMatch(/text-align:\s*(?:left|right);/);
    });
});

describe("line-number styles: no stylesheet crept back in", () => {
    it("the lineNumbers component should own no .css file", () => {
        // A `.css` file here would be eager bytes on every launch, including
        // the overwhelming majority that never enable the setting. If the rules
        // grow enough to want a real stylesheet, they need an esbuild entry
        // point of their own (the katex.css precedent), not a plain import.
        const dir = join(WEBVIEW_DIR, "components", "lineNumbers");
        const css = readdirSync(dir).filter((name) => name.endsWith(".css"));
        expect(css, `stylesheet(s) added under components/lineNumbers: ${css.join(", ")}`).toEqual([]);
    });

    it("no module should import a lineNumbers stylesheet", () => {
        const offenders: string[] = [];
        const walk = (dir: string): void => {
            for (const name of readdirSync(dir)) {
                if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) { continue; }
                const path = join(dir, name);
                if (statSync(path).isDirectory()) { walk(path); continue; }
                if (!name.endsWith(".ts")) { continue; }
                if (/import\s+["'][^"']*lineNumbers[^"']*\.css["']/.test(readFileSync(path, "utf8"))) {
                    offenders.push(path);
                }
            }
        };
        walk(WEBVIEW_DIR);
        expect(offenders).toEqual([]);
    });
});
