/**
 * The webview entry's EAGER module graph: every `.ts` module reached from
 * `webview/index.ts` through static relative imports, in ES evaluation order.
 * A dynamic `import()` is not followed, which is the point: a test that needs
 * to say "this module is loaded lazily, never at launch" asks whether the
 * module is in this set. Not a test file; Vitest only collects `*.test.ts`.
 *
 * Resolution mirrors the bundler: extensionless specifiers try `.ts` then
 * `index.ts`, and the `@/` alias declared in `esbuild.mjs` maps to `webview/`.
 * Only relative and aliased specifiers are part of the local graph; a bare
 * package import is not followed. `cssImportOrder.test.ts` walks the same graph
 * for stylesheet order and states the matcher's shape in detail.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const WEBVIEW_DIR = resolve(__dirname, "..", "..");
export const WEBVIEW_ENTRY = join(WEBVIEW_DIR, "index.ts");

const RELATIVE_IMPORT_RE =
    /^\s*(?:import|export)\s+(?:[^;]*?\sfrom\s+)?["']((?:\.|@\/)[^"']*)["']/gm;

/** Blank out comments while preserving offsets, so a `;` in prose can't split a clause. */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

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
 * Every `.ts` module the entry reaches statically, as `webview/`-relative
 * POSIX paths, in evaluation order (the entry itself first).
 */
export function eagerModulesOf(entry: string = WEBVIEW_ENTRY): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const visit = (file: string): void => {
        if (seen.has(file)) return;
        seen.add(file);
        out.push(relative(WEBVIEW_DIR, file).split(/[\\/]/).join("/"));
        for (const m of stripComments(readFileSync(file, "utf8")).matchAll(RELATIVE_IMPORT_RE)) {
            const target = resolveModule(file, m[1]!);
            if (target?.endsWith(".ts")) visit(target);
        }
    };
    visit(entry);
    return out;
}
