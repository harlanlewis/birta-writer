/**
 * hostPalette.test.ts — the palette a non-VS-Code host injects must cover
 * every `--vscode-*` variable the webview reads, and nothing else.
 *
 * `webview/ui/hostPalette.css` is what the Mac shell links so the editor
 * renders outside VS Code, where none of the 90-odd `--vscode-*` variables
 * exist. Nothing else looks at that file: it is not in the eager bundle and no
 * VS Code path loads it, so a variable added to a component and missed here
 * would fail only in the standalone host. This test is that look.
 *
 * "Referenced" is deliberately broad: any mention of a `--vscode-*` token in
 * shipping webview code, `.css` or `.ts`, `var()` or a string handed to
 * `getPropertyValue`, comments included. A comment naming a variable is a
 * cheap over-approximation and a rename that leaves a stale comment shows up
 * here as an unreferenced palette entry, which is a fair thing to be told.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const webviewRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PALETTE = join(webviewRoot, "ui", "hostPalette.css");

/** A `--vscode-*` token, ending at a non-identifier character. The lookahead
 *  keeps a prose fragment such as `--vscode-charts-*` from matching as
 *  `--vscode-charts`. */
const TOKEN_RE = /--vscode-[A-Za-z0-9-]*[A-Za-z0-9](?![A-Za-z0-9-])/g;

function collectShippingFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === "__tests__" || name === "__mocks__") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) collectShippingFiles(full, out);
        else if (/\.(ts|css)$/.test(name) && full !== PALETTE) out.push(full);
    }
    return out;
}

/** Every `--vscode-*` token mentioned anywhere in shipping webview code. */
export function referencedVscodeVars(): Set<string> {
    const found = new Set<string>();
    for (const file of collectShippingFiles(webviewRoot)) {
        for (const m of readFileSync(file, "utf8").matchAll(TOKEN_RE)) found.add(m[0]);
    }
    return found;
}

interface PaletteBlock {
    /** The selector text before the `{`. */
    selector: string;
    /** Declared custom properties, name to raw value. */
    vars: Map<string, string>;
}

/** Split a flat stylesheet of `selector { decls }` blocks. No nesting. */
export function parsePaletteBlocks(css: string): PaletteBlock[] {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const blocks: PaletteBlock[] = [];
    for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const vars = new Map<string, string>();
        for (const decl of m[2].split(";")) {
            const idx = decl.indexOf(":");
            if (idx === -1) continue;
            const name = decl.slice(0, idx).trim();
            if (!name.startsWith("--")) continue;
            vars.set(name, decl.slice(idx + 1).trim());
        }
        blocks.push({ selector: m[1].trim(), vars });
    }
    return blocks;
}

/** A value that is a concrete color, as opposed to a `var()` chain, a keyword
 *  such as `transparent`, a font stack or a length. Those cascade unchanged
 *  into the dark block; a color literal must be re-authored there. */
export function isColorLiteral(value: string): boolean {
    return !/var\(/.test(value) && /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(value);
}

describe("hostPalette.css", () => {
    const css = readFileSync(PALETTE, "utf8");
    const blocks = parsePaletteBlocks(css);
    const light = blocks.find((b) => b.selector === ":root");
    const dark = blocks.find((b) => b.selector.includes("vscode-dark"));

    it("should hold exactly one light block on :root and one dark block keyed on the body theme class", () => {
        expect(blocks.map((b) => b.selector)).toEqual([":root", ":root:has(body.vscode-dark)"]);
    });

    it("the light block should define every --vscode-* variable shipping code mentions, and nothing else", () => {
        const referenced = referencedVscodeVars();
        // Reach: a sweep that found a handful has not read the tree.
        expect(referenced.size).toBeGreaterThan(80);
        const defined = new Set([...light!.vars.keys()].filter((k) => k.startsWith("--vscode-")));
        const missing = [...referenced].filter((v) => !defined.has(v)).sort();
        const stale = [...defined].filter((v) => !referenced.has(v)).sort();
        expect(missing, "referenced in webview/ but not defined in the light block").toEqual([]);
        expect(stale, "defined in the light block but referenced nowhere in webview/").toEqual([]);
    });

    it("the dark block should redefine every light entry whose value is a color literal, and introduce nothing new", () => {
        const needsDark = [...light!.vars.entries()]
            .filter(([name, value]) => name.startsWith("--vscode-") && isColorLiteral(value))
            .map(([name]) => name);
        // Reach: the seeds and accents alone are more than this.
        expect(needsDark.length).toBeGreaterThan(40);
        const missing = needsDark.filter((v) => !dark!.vars.has(v)).sort();
        const extra = [...dark!.vars.keys()].filter((v) => v.startsWith("--vscode-") && !light!.vars.has(v)).sort();
        expect(missing, "color literal in light with no dark counterpart").toEqual([]);
        expect(extra, "defined in dark only").toEqual([]);
    });

    it("every var() inside the palette should point at a variable the palette defines", () => {
        const defined = new Set(light!.vars.keys());
        const dangling: string[] = [];
        for (const block of blocks) {
            for (const [name, value] of block.vars) {
                for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
                    if (!defined.has(m[1])) dangling.push(`${block.selector} ${name} -> ${m[1]}`);
                }
            }
        }
        expect(dangling).toEqual([]);
    });

    it("the palette must stay out of the eager bundle: no shipping module imports it", () => {
        const importers = collectShippingFiles(webviewRoot).filter((f) =>
            /hostPalette\.css/.test(readFileSync(f, "utf8")) && f.endsWith(".ts"),
        );
        expect(importers).toEqual([]);
    });
});

describe("hostPalette.test helpers", () => {
    it("parsePaletteBlocks should split flat blocks, ignore comments and non-custom declarations", () => {
        const blocks = parsePaletteBlocks(":root { /* c */ color-scheme: light; --a: #fff; --b: var(--a); }\nx.y { --c: 1px }");
        expect(blocks.map((b) => b.selector)).toEqual([":root", "x.y"]);
        expect([...blocks[0].vars]).toEqual([["--a", "#fff"], ["--b", "var(--a)"]]);
    });

    it("isColorLiteral should accept hex/rgb/hsl and reject var chains, keywords, fonts and lengths", () => {
        expect(isColorLiteral("#fff")).toBe(true);
        expect(isColorLiteral("rgba(0, 0, 0, 0.1)")).toBe(true);
        expect(isColorLiteral("var(--vscode-focusBorder)")).toBe(false);
        expect(isColorLiteral("transparent")).toBe(false);
        expect(isColorLiteral("Menlo, monospace")).toBe(false);
        expect(isColorLiteral("13px")).toBe(false);
    });

    it("the token regex should skip a prose fragment ending in a dash", () => {
        expect([..."see --vscode-charts-* and --vscode-charts-red".matchAll(TOKEN_RE)].map((m) => m[0]))
            .toEqual(["--vscode-charts-red"]);
    });
});
