/**
 * Host purity guard for `shared/` (MAR-338).
 *
 * `shared/` is the one directory BOTH bundles compile: `dist/extension.js`
 * (Node) and `dist/webview.js` (browser). A module here may assume only what
 * both hosts provide. There are four ways to break that, and every one of them
 * passes `pnpm typecheck`:
 *
 * - `import * as vscode from "vscode"`. Both tsconfig projects resolve it
 *   through `@types/vscode`, so nothing objects until esbuild reaches the
 *   module from `webview/index.ts`. A `shared/` module only `src/` imports is
 *   never reached, so it carries the import indefinitely.
 * - `import * as path from "path"`, or any other package. Same shape, same
 *   silence, same condition on reachability.
 * - `import { readBirtaConfig } from "../src/config"`, which is relative and
 *   therefore looks innocent, while `src/config.ts` imports `vscode` on its
 *   first line. The same breakage, laundered through one hop.
 * - A Node global with no import at all: `process.env`, `Buffer`, `__dirname`.
 *   esbuild cannot catch this one even when the module IS reachable, because a
 *   free identifier is a valid browser reference. It bundles clean and throws
 *   `ReferenceError` in the webview at runtime.
 *
 * The import rule here is stricter and simpler than a list of banned package
 * names: every import specifier in `shared/` must be relative AND must resolve
 * to a file still inside `shared/`. `shared/` has no external dependencies of
 * any kind, so a legitimate type-only exception would go in
 * `ALLOWED_SPECIFIERS` with the reason it is safe in both hosts. Reaching the
 * other way, into `webview/`, is rejected today only because the extension
 * project cannot resolve what `webview/pm.ts` imports, which is a compiler
 * accident rather than a stated rule; this guard states it.
 *
 * `import.meta` needs no rule: the extension bundle is CommonJS, so the
 * compiler already rejects it here (TS1470).
 *
 * DOM types are held by the compiler rather than by a matcher, since
 * enumerating the DOM lexically is not tractable: `tsconfig.json` compiles
 * `shared/` with `lib: ["ES2020"]` and no `DOM`, so `HTMLElement` in a shared
 * module fails `pnpm typecheck`. The last test pins that arrangement so it
 * stays deliberate. One narrow hole is known and accepted: `@types/mocha`,
 * pulled in by `src/test/suite/index.ts`, forward-declares a global
 * `interface HTMLLIElement {}`. It has no members, so it grants a shared
 * module nothing.
 *
 * Globals present in BOTH hosts stay legal, which is why the ban below
 * enumerates Node-only names instead of everything outside `lib.es2020`:
 * `shared/embedProviders.ts` uses `URL`, and `URL` is a global in Node and in
 * the browser alike.
 *
 * Scope: every `.ts` under `shared/`, excluding `__tests__`. Test files run
 * under Vitest in Node, never in a bundle, and legitimately import `vitest`,
 * `fs` and `path`.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { walkFiles } from "./cjkScanner";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SHARED_ROOT = path.join(REPO_ROOT, "shared");

/**
 * Non-relative specifiers `shared/` may import. Empty, and the bar for adding
 * one is that the package resolves and behaves identically in the extension
 * host and in the webview, or that the import is erased entirely at build time
 * (`import type`). Record which, per entry.
 */
const ALLOWED_SPECIFIERS = new Set<string>([]);

/**
 * Every specifier-bearing form, matched as one alternation so a new syntax
 * cannot slip past by being the one the guard forgot: `from "x"` (static
 * import, `import type`, and re-`export ... from`), bare side-effect
 * `import "x"`, dynamic and type-position `import("x")`, and `require("x")`.
 *
 * A backtick counts as a quote so a template-literal specifier cannot slip
 * past. One that interpolates captures the `${...}` text, which does not start
 * with a dot and so reports as non-relative: correct, since a computed
 * specifier in `shared/` cannot be shown to stay inside it.
 */
const IMPORT_SPECIFIER =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)["'`]([^"'`]*)["'`]/g;

/**
 * Node-only globals. Each is matched in a usage shape rather than as a bare
 * word, because `process` and `global` are also ordinary English and the
 * scanner reads comments out but not string literals.
 */
const NODE_GLOBALS: { name: string; re: RegExp }[] = [
    { name: "process", re: /\bprocess\s*\./ },
    { name: "Buffer", re: /\bBuffer\s*[.(]/ },
    { name: "__dirname", re: /\b__dirname\b/ },
    { name: "__filename", re: /\b__filename\b/ },
    { name: "global", re: /\bglobal\s*\./ },
    { name: "setImmediate", re: /\bsetImmediate\s*\(/ },
    { name: "module.exports", re: /\bmodule\s*\.\s*exports\b/ },
];

/**
 * Blanks out comments while preserving line count and column-free line
 * identity, so a prose mention of "the save process." or an example import in
 * a doc comment is not judged as code. `//` preceded by `:` or `/` is left
 * alone: that is a URL inside a string, not a comment.
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
        .replace(/(^|[^:/])\/\/.*$/gm, "$1");
}

/** True when a relative specifier resolved from `fromDir` lands outside `shared/`. */
function escapesShared(specifier: string, fromDir: string): boolean {
    const rel = path.relative(SHARED_ROOT, path.resolve(fromDir, specifier));
    return rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`);
}

/**
 * Returns one human-readable offence per violation, prefixed with its 1-based
 * line. `fromDir` is the directory the source sits in, which is what makes the
 * escape check depth-aware rather than a textual hunt for `../`.
 */
function findPurityOffences(source: string, fromDir: string = SHARED_ROOT): string[] {
    const offences: string[] = [];
    stripComments(source)
        .split("\n")
        .forEach((line, idx) => {
            const lineNo = idx + 1;
            for (const match of line.matchAll(IMPORT_SPECIFIER)) {
                const specifier = match[1];
                if (specifier.startsWith(".")) {
                    if (escapesShared(specifier, fromDir)) {
                        offences.push(`${lineNo}: relative import "${specifier}" leaves shared/`);
                    }
                    continue;
                }
                if (ALLOWED_SPECIFIERS.has(specifier)) continue;
                offences.push(`${lineNo}: non-relative import "${specifier}"`);
            }
            for (const { name, re } of NODE_GLOBALS) {
                if (re.test(line)) offences.push(`${lineNo}: Node-only global \`${name}\``);
            }
        });
    return offences;
}

describe("shared/ host purity", () => {
    it("the detector should flag a vscode import, a Node builtin, and a bare package", () => {
        expect(findPurityOffences('import * as vscode from "vscode";')).toEqual([
            '1: non-relative import "vscode"',
        ]);
        expect(findPurityOffences('import * as path from "path";')).toEqual([
            '1: non-relative import "path"',
        ]);
        expect(findPurityOffences('import { readFile } from "node:fs/promises";')).toEqual([
            '1: non-relative import "node:fs/promises"',
        ]);
        expect(findPurityOffences('import type { Node } from "@milkdown/prose/model";')).toEqual([
            '1: non-relative import "@milkdown/prose/model"',
        ]);
    });

    it("the detector should flag every specifier-bearing syntax, not just the static one", () => {
        expect(findPurityOffences('import "vscode";')).toEqual(['1: non-relative import "vscode"']);
        expect(findPurityOffences('export { Uri } from "vscode";')).toEqual([
            '1: non-relative import "vscode"',
        ]);
        expect(findPurityOffences('export * from "vscode";')).toEqual([
            '1: non-relative import "vscode"',
        ]);
        expect(findPurityOffences('const v = await import("vscode");')).toEqual([
            '1: non-relative import "vscode"',
        ]);
        expect(findPurityOffences('type U = import("vscode").Uri;')).toEqual([
            '1: non-relative import "vscode"',
        ]);
        expect(findPurityOffences('const fs = require("fs");')).toEqual([
            '1: non-relative import "fs"',
        ]);
        expect(findPurityOffences("const v = await import(`vscode`);")).toEqual([
            '1: non-relative import "vscode"',
        ]);
        expect(findPurityOffences("const v = await import(`${host}/api`);")).toEqual([
            '1: non-relative import "${host}/api"',
        ]);
    });

    it("the detector should allow relative imports that stay inside shared/, in every form", () => {
        expect(findPurityOffences('import type { X } from "./messages";')).toEqual([]);
        expect(findPurityOffences('export { Z } from "./slug";')).toEqual([]);
        expect(findPurityOffences('import "./sideEffect";')).toEqual([]);
        expect(findPurityOffences('const m = await import("./lazy");')).toEqual([]);
        // Resolved, not read textually: this one climbs out and back in.
        expect(findPurityOffences('import { Y } from "../shared/config";')).toEqual([]);
        // A nested module may use `../` without leaving shared/.
        expect(
            findPurityOffences('import { Y } from "../config";', path.join(SHARED_ROOT, "sub")),
        ).toEqual([]);
    });

    it("the detector should flag a relative import that escapes shared/ into a host-specific tree", () => {
        expect(findPurityOffences('import { readBirtaConfig } from "../src/config";')).toEqual([
            '1: relative import "../src/config" leaves shared/',
        ]);
        expect(findPurityOffences('import { getView } from "../webview/pm";')).toEqual([
            '1: relative import "../webview/pm" leaves shared/',
        ]);
        expect(findPurityOffences('import { x } from "../../elsewhere";')).toEqual([
            '1: relative import "../../elsewhere" leaves shared/',
        ]);
        expect(
            findPurityOffences('import { x } from "../../src/config";', path.join(SHARED_ROOT, "sub")),
        ).toEqual(['1: relative import "../../src/config" leaves shared/']);
    });

    it("the detector should flag Node-only globals used without any import", () => {
        expect(findPurityOffences("export const h = () => process.env.HOME;")).toEqual([
            "1: Node-only global `process`",
        ]);
        expect(findPurityOffences('export const b = Buffer.from("x");')).toEqual([
            "1: Node-only global `Buffer`",
        ]);
        expect(findPurityOffences("export const d = __dirname;")).toEqual([
            "1: Node-only global `__dirname`",
        ]);
        expect(findPurityOffences("export const f = __filename;")).toEqual([
            "1: Node-only global `__filename`",
        ]);
        expect(findPurityOffences("global.crypto = undefined;")).toEqual([
            "1: Node-only global `global`",
        ]);
        expect(findPurityOffences("setImmediate(() => 0);")).toEqual([
            "1: Node-only global `setImmediate`",
        ]);
        expect(findPurityOffences("module.exports = {};")).toEqual([
            "1: Node-only global `module.exports`",
        ]);
    });

    it("the detector should allow globals both hosts provide, and identifiers that merely start with a banned name", () => {
        expect(findPurityOffences("export const u = new URL(href).hostname;")).toEqual([]);
        expect(findPurityOffences("export const e = new TextEncoder().encode(s);")).toEqual([]);
        expect(findPurityOffences("export const g = globalThis.crypto;")).toEqual([]);
        expect(findPurityOffences("export const t = setTimeout(fn, 0);")).toEqual([]);
        expect(findPurityOffences("export const p = processDocument.title;")).toEqual([]);
        expect(findPurityOffences("export const q = BufferedWriter.name;")).toEqual([]);
    });

    it("the detector should not judge commented-out code or prose, but should judge a URL-bearing line", () => {
        expect(findPurityOffences('// import * as vscode from "vscode";')).toEqual([]);
        expect(findPurityOffences('/* import * as path from "path"; */')).toEqual([]);
        expect(findPurityOffences("// The save process. Then the flush.")).toEqual([]);
        expect(findPurityOffences('const docs = "https://example.com/a";')).toEqual([]);
        expect(
            findPurityOffences('const docs = "https://example.com"; export const h = process.env.X;'),
        ).toEqual(["1: Node-only global `process`"]);
    });

    it("the detector should report the line number and every offence on a multi-line source", () => {
        const source = [
            'import * as vscode from "vscode";',
            'import type { X } from "./messages";',
            "export const h = () => process.env.HOME;",
        ].join("\n");
        expect(findPurityOffences(source)).toEqual([
            '1: non-relative import "vscode"',
            "3: Node-only global `process`",
        ]);
    });

    it("shared/ source should import nothing outside shared/ and touch no Node-only global", () => {
        const files = walkFiles(SHARED_ROOT, [".ts"], ["__tests__"]);
        // Guard against a vacuous pass if a future move makes the paths vanish.
        expect(files.length).toBeGreaterThan(10);
        expect(files.map((f) => path.basename(f))).toEqual(
            expect.arrayContaining(["messages.ts", "config.ts", "embedProviders.ts"]),
        );

        const offenders: string[] = [];
        for (const file of files) {
            const rel = path.relative(REPO_ROOT, file);
            const source = fs.readFileSync(file, "utf8");
            for (const offence of findPurityOffences(source, path.dirname(file))) {
                offenders.push(`${rel}:${offence}`);
            }
        }
        expect(
            offenders,
            `shared/ must compile into both the Node and the browser bundle, so it may import only modules inside shared/ and may use only globals both hosts provide:\n${offenders.join("\n")}`,
        ).toEqual([]);
    });

    it("tsconfig.json should keep compiling shared/ without the DOM lib, which is what rejects a DOM type there", () => {
        // Leading `//` lines are legal in a tsconfig and tsconfig.typecheck.json
        // opens with three of them, so strip whole-line comments before parsing.
        const readTsconfig = <T>(name: string): T => {
            const raw = fs.readFileSync(path.join(REPO_ROOT, name), "utf8");
            return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as T;
        };

        const base = readTsconfig<{
            compilerOptions: { lib: string[] };
            include: string[];
        }>("tsconfig.json");
        expect(base.include).toContain("shared/**/*.ts");
        expect(base.compilerOptions.lib).toBeDefined();
        expect(base.compilerOptions.lib.map((l) => l.toLowerCase())).not.toContain("dom");

        // The pin only reaches CI if `pnpm typecheck`'s project inherits it.
        const typecheck = readTsconfig<{ extends: string }>("tsconfig.typecheck.json");
        expect(typecheck.extends).toBe("./tsconfig.json");
    });
});
