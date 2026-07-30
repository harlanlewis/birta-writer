/**
 * Guards the chrome-primitive cascade order.
 *
 * The ui-* primitives (.ui-btn, .ui-menu-row, .ui-notice) and the surface
 * classes composed onto them (.tb-btn, .slash-menu-item, ...) tie on
 * specificity — a single class each — so WHICH rule wins is decided purely by
 * bundle order. chrome.css must therefore be the FIRST stylesheet in the
 * webview entry's import graph: every surface override (a menu's denser
 * padding, the fm chips' em font, .content-guard-notice's fixed anchoring)
 * silently loses the moment something is imported above it. esbuild orders
 * CSS by module evaluation order, so this is one moved line away from
 * breaking with no compile error.
 *
 * "First in the import GRAPH" is the claim, and it is not the same as "first
 * among index.ts's own import lines" — which is all this guard used to check.
 * `import "./perfBoot"` sits ABOVE the chrome.css line and is required to stay
 * there; one `import "./x.css"` inside perfBoot (or anything it reaches) would
 * evaluate first and take the base layer, with this file's line order
 * untouched and the guard still green. So the sweep below walks the eager
 * module graph in ES evaluation order — depth-first, source order, imports
 * before the importer's own body, which is also the order esbuild emits CSS in
 * — and asserts chrome.css is the first stylesheet reached.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const WEBVIEW_DIR = join(__dirname, "..");
const ENTRY = join(WEBVIEW_DIR, "index.ts");

/**
 * Static `import "./x"` / `import ... from "./x"` / `export ... from "./x"`.
 *
 * The import clause is `[^;]*?`, not `[\s\S]*?`: a clause may span lines (a
 * multi-line named-import list) but never crosses a statement terminator. With
 * `[\s\S]*?` the optional clause group happily reached PAST a bare
 * `import "./sideEffect";` to the next statement's ` from `, so every
 * side-effect import — which is exactly what a CSS import is — was skipped.
 */
// Both spellings the bundler resolves into `webview/`: relative (`./x`) AND the
// `@/` alias (`esbuild.mjs` maps `@` → `./webview`). Relative-only was NOT
// cosmetic — the repo has ~281 `@/` specifiers across 42 webview files, so a
// stylesheet pulled in via an aliased module was invisible to this walk and
// could land ahead of chrome.css with the guard still green. The bundle-order
// assertion below cannot backstop that in CI: the `unit-test` job never builds,
// so `dist/webview.css` does not exist there and that check self-skips.
const RELATIVE_IMPORT_RE =
    /^\s*(?:import|export)\s+(?:[^;]*?\sfrom\s+)?["']((?:\.|@\/)[^"']*)["']/gm;

/** Blank out comments while preserving offsets, so a `;` in prose can't split a clause. */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

/**
 * Resolve a specifier the way the bundler does (extensionless → .ts / index.ts),
 * honouring the `@/` → `webview/` alias declared in `esbuild.mjs`.
 */
function resolveModule(fromFile: string, spec: string): string | null {
    const base = spec.startsWith("@/")
        ? resolve(WEBVIEW_DIR, spec.slice(2))
        : resolve(dirname(fromFile), spec);
    for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
}

/**
 * Stylesheets in ES module evaluation order, starting at the entry. A module's
 * imports evaluate, in source order, before its own body — so a depth-first
 * pre-order walk over the import lists yields the order CSS lands in the
 * bundle. Only STATIC relative imports are followed: a dynamic `import()`
 * chunk is loaded later by definition and cannot occupy the base layer.
 */
function stylesheetsInEvalOrder(entry: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const visit = (file: string): void => {
        if (seen.has(file)) return;
        seen.add(file);
        for (const m of stripComments(readFileSync(file, "utf8")).matchAll(RELATIVE_IMPORT_RE)) {
            const target = resolveModule(file, m[1]!);
            if (!target) continue;
            if (target.endsWith(".css")) {
                if (!seen.has(target)) {
                    seen.add(target);
                    out.push(relative(WEBVIEW_DIR, target).split(/[\\/]/).join("/"));
                }
                continue;
            }
            if (target.endsWith(".ts")) visit(target);
        }
    };
    visit(entry);
    return out;
}

describe("chrome.css cascade position", () => {
    // A scan that finds NOTHING is indistinguishable from a scan that finds
    // nothing wrong, and a CSS import is always a bare side-effect statement —
    // the exact shape an over-reaching clause pattern skips. Pin the matcher.
    it("the relative-import matcher should see side-effect imports and multi-line clauses", () => {
        const specs = (src: string): string[] =>
            [...stripComments(src).matchAll(RELATIVE_IMPORT_RE)].map((m) => m[1]!);

        expect(specs('import "./perfBoot";\nimport { a } from "./mod";')).toEqual([
            "./perfBoot",
            "./mod",
        ]);
        // A trailing comment carries no `;`, so the clause must still not
        // reach into the following statement.
        expect(
            specs('import "./ui/chrome.css"; // tokens + primitives\nimport "./style.css";'),
        ).toEqual(["./ui/chrome.css", "./style.css"]);
        expect(specs('import {\n    a,\n    b,\n} from "./multi";')).toEqual(["./multi"]);
        expect(specs('export { x } from "./re-export";')).toEqual(["./re-export"]);
        // Bare package specifiers are not part of the local graph.
        expect(specs('import { Editor } from "@milkdown/core";')).toEqual([]);
    });

    it("chrome.css should be the first stylesheet import of the webview entry", () => {
        const src = readFileSync(ENTRY, "utf8");
        const cssImports = [...src.matchAll(/^import\s+"(\.[^"]+\.css)";/gm)].map(
            (m) => m[1],
        );
        expect(cssImports[0]).toBe("./ui/chrome.css");
    });

    it("chrome.css should be the first stylesheet in the entry's whole import graph", () => {
        const sheets = stylesheetsInEvalOrder(ENTRY);
        // Guard against a vacuous or truncated pass: a walk that silently
        // stopped resolving would find "no stylesheet above chrome.css" for
        // the wrong reason. Anchor on the sheets the entry imports directly.
        expect(sheets.length, "the graph walk found almost no stylesheets").toBeGreaterThan(15);
        for (const sheet of ["ui/chrome.css", "ui/typography.css", "style.css", "ui/suggestList.css"]) {
            expect(sheets, `the walk lost ${sheet}`).toContain(sheet);
        }
        expect(
            sheets[0],
            "The first stylesheet reached from webview/index.ts is not ui/chrome.css. " +
                "Something imported above it — directly, or transitively through a module " +
                "imported above it — pulls in CSS, so that file now owns the base layer and " +
                `every ui-* primitive loses its specificity ties. Evaluation order: ${sheets.slice(0, 5).join(", ")}`,
        ).toBe("ui/chrome.css");
    });

    it("the built bundle should emit the primitives before the surfaces", () => {
        // Belt-and-braces on the real artifact when a build exists. NOTE: this
        // assertion does not run in CI — the `unit-test` job runs before
        // `build`, so there is no dist/ — and it does not run on a clean
        // checkout either. The graph walk above is what actually holds the
        // invariant; this only adds confirmation locally after a build.
        const bundle = join(WEBVIEW_DIR, "..", "dist", "webview.css");
        if (!existsSync(bundle)) return;
        const css = readFileSync(bundle, "utf8");
        const uiBtn = css.indexOf(".ui-btn");
        const uiRow = css.indexOf(".ui-menu-row");
        const tbBtn = css.indexOf(".tb-btn");
        const slashItem = css.indexOf(".slash-menu-item");
        expect(uiBtn).toBeGreaterThanOrEqual(0);
        expect(uiRow).toBeGreaterThanOrEqual(0);
        expect(uiBtn).toBeLessThan(tbBtn);
        expect(uiRow).toBeLessThan(slashItem);
    });
});
