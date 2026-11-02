/**
 * Every package the integration suite's Extension Host half loads must be
 * loadable by `require()`, by any import style.
 *
 * `src/test/suite/**` compiles to CommonJS (tsconfig.integration.json) and is
 * loaded INSIDE the Extension Host, which runs the Node that VS Code ships. The
 * `engines.vscode` floor (1.101) ships Node 22.15, which `require()`s an ES
 * module graph unflagged, so an ESM-only package is no longer refused for being
 * ESM. Two shapes still are: a package whose `exports` map offers no `require`
 * condition and no CommonJS-loadable default, and an ES module graph that uses
 * top-level `await` (ERR_REQUIRE_ASYNC_MODULE). Nothing on a contributor's
 * machine or in the unit job launches the Extension Host, so either shape is
 * green everywhere except the floor's own launch.
 *
 * THE IMPORT STYLE IS NOT THE FIX. Rewriting a static import as `await import()`
 * moves the error into the dependency without removing it, because a package's
 * own CommonJS shim can itself `require()` what the host cannot load. So this
 * guard judges the DEPENDENCY, and counts a dynamic import as reaching it just as
 * a static one does.
 *
 * The verdict is the real loader's, not a reading of the manifest: each package
 * is `require()`d in a child Node, outside Vitest's module system. That child is
 * the runner's Node (`.nvmrc`), not the floor's, so it stands in for the floor
 * only on the property asserted first, that it loads ES modules through
 * `require()` at all. The floor's own launch is CI's `integration-floor` job.
 *
 * `src/test/runTest.ts` is deliberately out of scope. It runs on the runner's
 * own Node rather than in the Extension Host, so the floor's limit does not
 * reach it.
 *
 * A type-only import IS spared: it is erased before emit and reaches no runtime.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { spawnSync } from "child_process";
import ts from "typescript";

const repoRoot = path.resolve(__dirname, "..", "..");
const suiteDir = path.join(repoRoot, "src", "test", "suite");

/** Every `.ts` under the Extension Host half of the integration suite. */
function suiteSources(): string[] {
    return fs
        .readdirSync(suiteDir)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => path.join(suiteDir, f));
}

interface PackageReference {
    file: string;
    specifier: string;
    /** How the source reaches it, reported so a failure says where to look. */
    via: "static" | "dynamic";
}

/**
 * Every bare package this source reaches at runtime, by either import form.
 *
 * A relative specifier is our own compiled CommonJS and never an ESM graph. A
 * type-only import is erased before emit. Everything else is a real load.
 */
function packageReferencesIn(text: string, file: string): PackageReference[] {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true);
    const found: PackageReference[] = [];
    const rel = path.relative(repoRoot, file);

    const isBare = (s: string) => !s.startsWith(".") && !s.startsWith("/");

    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node)) {
            if (
                !node.importClause?.isTypeOnly &&
                ts.isStringLiteral(node.moduleSpecifier) &&
                isBare(node.moduleSpecifier.text)
            ) {
                found.push({
                    file: rel,
                    specifier: node.moduleSpecifier.text,
                    via: "static",
                });
            }
        }
        if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
            const arg = node.arguments[0];
            if (arg && ts.isStringLiteral(arg) && isBare(arg.text)) {
                found.push({ file: rel, specifier: arg.text, via: "dynamic" });
            }
        }
        ts.forEachChild(node, visit);
    };

    visit(sf);
    return found;
}

/** The same, read off disk. */
function packageReferences(file: string): PackageReference[] {
    return packageReferencesIn(fs.readFileSync(file, "utf8"), file);
}

type Verdict = "builtin" | "loads" | "refused" | "unresolved";

/** The child's answer, kept whole so a failure can say why. */
interface LoadResult {
    verdict: Verdict;
    detail: string;
}

/**
 * What `require()` does with a bare specifier, asked of a child Node.
 *
 * `builtin` covers Node's own modules and `vscode`: the first live inside the
 * runtime, the second is injected by the Extension Host and is not installed.
 *
 * `unresolved` is deliberately NOT a pass. A package that is not installed
 * cannot be judged, and a guard that cannot answer must say so rather than read
 * as a clean sweep. Every package the suite imports is a direct dependency, so
 * it has a `node_modules/<name>` entry; its absence is a broken tree.
 */
function load(specifier: string): LoadResult {
    if (specifier === "vscode") return { verdict: "builtin", detail: "" };
    const require_ = createRequire(path.join(repoRoot, "package.json"));
    if (require_("module").isBuiltin(specifier)) return { verdict: "builtin", detail: "" };
    if (!fs.existsSync(path.join(repoRoot, "node_modules", specifier, "package.json"))) {
        return { verdict: "unresolved", detail: "no node_modules entry" };
    }
    const child = spawnSync(
        process.execPath,
        ["-e", `require(${JSON.stringify(specifier)})`],
        { cwd: repoRoot, encoding: "utf8" },
    );
    if (child.status === 0) return { verdict: "loads", detail: "" };
    const code = /code: '([A-Z_]+)'/.exec(child.stderr)?.[1] ?? `exit ${child.status}`;
    return { verdict: "refused", detail: code };
}

describe("the integration suite's Extension Host half", () => {
    it("the child Node should load ES modules through require(), or no verdict below stands in for the floor", () => {
        // Asserted first because every other verdict is read off this child.
        // A runner Node without require(esm) would refuse every ESM package and
        // fail the sweep for a reason that is not the floor's.
        const child = spawnSync(
            process.execPath,
            ["-p", "process.features.require_module === true"],
            { encoding: "utf8" },
        );
        expect(child.stdout.trim(), `runner Node ${process.version}`).toBe("true");
    });

    it("every package it loads should be require()-able, because the Extension Host loads the suite as CommonJS", () => {
        const seen = suiteSources().flatMap(packageReferences);

        // The instrument has to have reached the source. Every integration test
        // imports `vscode`, so its absence means the AST walk found nothing and
        // the check below is vacuous rather than satisfied.
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.map((s) => s.specifier)).toContain("vscode");

        // An unresolved package fails alongside a refused one: the guard could
        // not answer, and must say so rather than report a clean sweep.
        const offenders = seen
            .map((s) => ({ ...s, result: load(s.specifier) }))
            .filter((s) => s.result.verdict === "refused" || s.result.verdict === "unresolved");
        expect(
            offenders.map(
                (o) => `${o.file} ${o.via}-imports "${o.specifier}" (${o.result.verdict}: ${o.result.detail})`,
            ),
        ).toEqual([]);

        // A floor on the judged set: mocha is the one third-party package the
        // bootstrap loads, so at least one verdict above was the loader's own.
        expect(seen.filter((s) => load(s.specifier).verdict === "loads").length).toBeGreaterThan(0);
    });

    it("the walk should reach every file in the suite directory, so a new test file cannot escape it", () => {
        const files = suiteSources();
        expect(files.length).toBeGreaterThanOrEqual(5);
        expect(files.map((f) => path.basename(f))).toContain("index.ts");
    });

    it("the loader should discriminate all four verdicts, so the check above cannot pass by always answering the same thing", () => {
        // mocha 12 is an ES module graph that require() loads. harper.js is
        // ESM whose `exports` map offers `import` alone, so require() refuses
        // it; it is the real-world shape of a package the floor cannot load.
        // `typescript` is plain CommonJS.
        expect(load("mocha").verdict).toBe("loads");
        expect(load("typescript").verdict).toBe("loads");
        expect(load("harper.js")).toEqual({ verdict: "refused", detail: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
        expect(load("path").verdict).toBe("builtin");
        expect(load("vscode").verdict).toBe("builtin");
        expect(load("a-package-that-is-not-installed").verdict).toBe("unresolved");
    });

    it("the import walk should catch both forms that load a package and spare the one that does not", () => {
        // Both directions matter. Missing a form lets the floor break through;
        // flagging a type-only import would refuse something that reaches no
        // runtime, which is how a guard gets deleted by the next person it trips.
        const caught = (src: string) =>
            packageReferencesIn(src, "probe.ts").map(
                (i) => `${i.via}:${i.specifier}`,
            );

        expect(caught(`import Mocha from "mocha";`)).toEqual(["static:mocha"]);
        expect(caught(`import { a } from "mocha";`)).toEqual(["static:mocha"]);
        expect(caught(`const m = await import("mocha");`)).toEqual([
            "dynamic:mocha",
        ]);
        expect(caught(`async function f() { await import("mocha"); }`)).toEqual(
            ["dynamic:mocha"],
        );
        expect(caught(`import type Mocha from "mocha";`)).toEqual([]);
        expect(caught(`import { x } from "./local";`)).toEqual([]);
        expect(caught(`const p = await import("./local");`)).toEqual([]);
    });
});
