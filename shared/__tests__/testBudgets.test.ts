/**
 * Every test budget in the tree follows the instrument, the two halves that
 * make that true agree on their one variable, and the suites the coverage
 * run leaves out are the ones the config says.
 *
 * A test that is slow by nature (a corpus walk, a whole-tree scan, a sweep
 * through a real editor) gets a budget, and a budget written as a fixed
 * number is a claim about one machine on one day: under coverage
 * instrumentation on a shared runner the same work reads several times
 * slower, and a fixed number goes red with nothing wrong in the tree. So a
 * budget goes through `budget()` in `webview/__tests__/helpers/testBudget.ts`,
 * which scales it under coverage, and this file refuses a raw number wherever
 * a budget is written, so the next slow test cannot bring one back.
 *
 * A budget is written in three shapes, and all three are swept: a `timeout:`
 * option (`describe`/`it` options, `vi.waitFor`, and the `testTimeout` and
 * `hookTimeout` of `vi.setConfig`); a positional last argument on the closing
 * line of a test (`}, 60_000);`); and the same argument on a line of its own
 * inside a multi-line `it(` call. A number that is not a budget (a fake
 * `requestIdleCallback`'s own deadline) says so with a same-line
 * `budget-ok: <reason>` comment, the shape `color-literal-ok` and
 * `menu-ground-ok` take in the other sweeps.
 *
 * The helper reads `BIRTA_TEST_COVERAGE`; `vitest.config.ts` sets it for every
 * worker from the `--coverage` flag and raises the default timeout by the same
 * factor. The pairing is held two ways: as source text over both files,
 * because a config that stopped handing the variable down would leave every
 * budget at its bare size with the suite green; and at runtime, because this
 * worker must have been handed a value at all.
 *
 * The coverage run leaves out the corpus sweeps (`CORPUS_SWEEPS` in
 * vitest.config.ts). A file named there that does not exist is a silent
 * no-op, and a corpus walk that is missing from the list is the same absence
 * the other way, so both directions are held: each listed file exists and is
 * budgeted, and every budgeted test that loads the corpus fixtures or the
 * perf fixtures is listed or says on its import statement why it stays in
 * (`corpus-sweep-kept: <reason>`).
 *
 * This file is itself the tree's widest scan, so its suites carry a budget.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { budget } from "../../webview/__tests__/helpers/testBudget";

const SCAN_BUDGET_MS = budget(30_000);

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SELF = "shared/__tests__/testBudgets.test.ts";

/** Where the two Vitest projects collect their files (vitest.config.ts). */
const TEST_ROOTS = ["webview/__tests__", "shared/__tests__", "src/__tests__", "packages/minimal-diff/src/__tests__", "e2e"];

function testFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            if (name !== "node_modules") testFiles(full, out);
        } else if (/\.test\.(?:ts|mjs)$/.test(name)) out.push(full);
    }
    return out;
}

const relPath = (file: string): string => relative(repo, file).split(/[\\/]/).join("/");
const NUMERIC = /^[0-9][0-9_]*$/;
const HAS_NUMBER = /\b[0-9][0-9_]*\b/;
const EXEMPT = /budget-ok:\s*\S/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

interface Site {
    file: string;
    line: number;
    expression: string;
}

/** Every place a budget is written in `text`, in the three shapes. */
function sitesIn(text: string, file: string): Site[] {
    const sites: Site[] = [];
    let inTestCall = false;
    text.split("\n").forEach((line, i) => {
        if (EXEMPT.test(line)) return;
        for (const m of line.matchAll(/\b(?:test|hook)?[tT]imeout"?:\s*([^,}\s]+)/g)) {
            sites.push({ file, line: i + 1, expression: m[1] });
        }
        // The last argument of a test call: on the line that closes a
        // multi-line callback, or on a one-line `it(...)`. Not any call that
        // happens to take an object and then a number.
        const positional = /^\s*\},\s*(\S+?)\);?\s*$/.exec(line)
            ?? /^\s*(?:it|test|describe)(?:\.\w+)*\(.*\}\s*,\s*(\S+?)\);?\s*$/.exec(line);
        if (positional) sites.push({ file, line: i + 1, expression: positional[1] });
        if (/^\s*(?:it|test|describe)(?:\.\w+)*\(\s*$/.test(line)) inTestCall = true;
        else if (/^\s*\);?\s*$/.test(line)) inTestCall = false;
        else if (inTestCall) {
            // A number or a budget alone on its line inside the call. Not a
            // name: the call's body has its own multi-line calls, and a name
            // alone on a line there is an ordinary argument.
            const own = /^\s*([^\s,]+),\s*$/.exec(line);
            if (own && (NUMERIC.test(own[1]) || own[1].startsWith("budget("))) {
                sites.push({ file, line: i + 1, expression: own[1] });
            }
        }
    });
    return sites;
}

function budgetSites(): Site[] {
    const sites: Site[] = [];
    for (const root of TEST_ROOTS) {
        for (const file of testFiles(join(repo, root))) {
            const rel = relPath(file);
            if (rel === SELF) continue;
            sites.push(...sitesIn(readFileSync(file, "utf8"), rel));
        }
    }
    return sites;
}

/**
 * A site is fixed when its value is a number, directly or through a name
 * `text` binds to an expression that carries a number and no `budget(`. A
 * name bound any other way (a type, a settle delay imported from elsewhere)
 * is not a budget and is not judged; a computed one that carries a number is
 * judged fixed, and says `budget-ok:` if it is not a budget.
 */
function isFixedIn(text: string, expression: string): boolean {
    if (expression.startsWith("budget(")) return false;
    if (NUMERIC.test(expression)) return true;
    if (!IDENTIFIER.test(expression)) return false;
    const definition = new RegExp(`(?:const|let|var) ${expression.replace(/\$/g, "\\$")}\\s*=\\s*([^;]+);`).exec(text);
    if (!definition) return false;
    return HAS_NUMBER.test(definition[1]) && !definition[1].includes("budget(");
}

const isFixed = (site: Site): boolean => isFixedIn(readFileSync(join(repo, site.file), "utf8"), site.expression);

/**
 * The import statement whose module specifier contains `module`, with any
 * comment on its last line. Keyed on the module rather than an export name,
 * so every spelling of a loader (`FIXTURES`, `HEAVY_FIXTURES`, a renamed
 * import) is one import.
 */
function importStatement(text: string, module: string): string | undefined {
    return new RegExp(`import[^;]*from\\s*"[^"]*${module.replace(/[.]/g, "\\.")}[^"]*";[^\\n]*`, "s").exec(text)?.[0];
}

/**
 * Where the fixtures come from. The corpus helper also exports the editor
 * factory, so an import from it counts only when it names the loader; every
 * export of the perf fixtures module is a fixture.
 */
const FIXTURE_LOADERS: { module: string; exportName?: string }[] = [
    { module: "helpers/moveFuzz", exportName: "loadCorpusFixtures" },
    { module: "e2e/perf/fixtures" },
];

/** The import statement through which `text` loads fixtures, if it does. */
function fixtureImport(text: string): string | undefined {
    for (const loader of FIXTURE_LOADERS) {
        const statement = importStatement(text, loader.module);
        if (!statement) continue;
        if (!loader.exportName || new RegExp(`\\b${loader.exportName}\\b`).test(statement)) return statement;
    }
    return undefined;
}

describe("the sweep's three shapes, witnessed on text of known shape", { timeout: SCAN_BUDGET_MS }, () => {
    // The tree may stop carrying a spelling; these hold that the regexes
    // still see it, and that the shapes they must not see stay unseen.
    const witness = [
        'describe("a", { timeout: budget(1) }, () => {});',
        'vi.setConfig({ testTimeout: 30_000, hookTimeout: budget(2) });',
        'const opts = { "timeout": 5000 };',
        'it("one line", () => { run(); }, 30_000);',
        'it("call with an object and a number", () => { paint({ a: 1 }, 5); });',
        "readTokenResponse({ access_token: 'at' }, 10_000);",
        "}, budget(3));",
        "it(",
        '    "own line",',
        "    async () => { await sweep(); },",
        "    60_000,",
        ");",
        "expect(idleCallbacks[0].opts).toEqual({ timeout: IDLE_MS }); // budget-ok: the callback's own deadline",
        "const OWN_LINE_BUDGET = 60 * 1000;",
        "const IDLE_MS = 1000;",
    ].join("\n");

    it("should see the option, positional and own-line shapes, quoted keys and one-line tests included", () => {
        const found = sitesIn(witness, "witness").map((s) => s.expression);
        expect(found).toEqual(["budget(1)", "30_000", "budget(2)", "5000", "30_000", "budget(3)", "60_000"]);
    });

    it("should judge a number, and a name bound to a computation carrying one, as fixed, and a budget as not", () => {
        expect(isFixedIn(witness, "30_000")).toBe(true);
        expect(isFixedIn(witness, "OWN_LINE_BUDGET")).toBe(true);
        expect(isFixedIn(witness, "budget(2)")).toBe(false);
        expect(isFixedIn(witness, "IDLE_MS")).toBe(true);
    });

    it("should find an annotation on the last line of a multi-line import, by the module it imports from", () => {
        const text = 'import {\n    a,\n    loadCorpusFixtures,\n} from "./helpers/moveFuzz"; // corpus-sweep-kept: why\n';
        expect(fixtureImport(text)).toContain("corpus-sweep-kept: why");
        expect(fixtureImport('import { HEAVY_FIXTURES } from "../../e2e/perf/fixtures.mjs";\n')).toBeDefined();
        expect(fixtureImport('import { makeCorpusEditor } from "./helpers/moveFuzz";\n'), "the editor factory alone").toBeUndefined();
        expect(fixtureImport(" * prose naming helpers/moveFuzz in a comment\n")).toBeUndefined();
    });
});

describe("test budgets follow the instrument", { timeout: SCAN_BUDGET_MS }, () => {
    it("no budget should be a fixed number, in any of the three shapes", () => {
        const sites = budgetSites();
        // The instrument's own arm: a sweep that found no site would pass with
        // nothing checked. The tree holds dozens.
        expect(sites.length).toBeGreaterThan(30);
        const fixed = sites.filter(isFixed).map((s) => `${s.file}:${s.line} ${s.expression}`);
        expect(fixed, "a fixed budget; write it as budget(<ms>) from webview/__tests__/helpers/testBudget.ts").toEqual([]);
    });

    it("the sweep should see all three shapes, on files known to carry each", () => {
        const by = (file: string) => budgetSites().filter((s) => s.file === file);
        expect(by("webview/__tests__/menuGrounds.test.ts").length, "option form").toBeGreaterThan(0);
        expect(by("webview/__tests__/blockSegmenter.test.ts").length, "positional form").toBeGreaterThan(0);
        expect(by("webview/__tests__/perfFixtureConstructs.test.ts").length, "own-line form").toBeGreaterThan(0);
    });

    it("an exempt line should be left out of the sweep, and a plain number to another call should never enter it", () => {
        const sites = budgetSites();
        expect(sites.some((s) => s.file === "webview/__tests__/wordCountReporter.test.ts" && s.expression === "IDLE_TIMEOUT_MS")).toBe(false);
        expect(sites.some((s) => s.file === "src/__tests__/pkce.test.ts")).toBe(false);
    });
});

describe("the config and the helper agree on the coverage variable", { timeout: SCAN_BUDGET_MS }, () => {
    const config = readFileSync(join(repo, "vitest.config.ts"), "utf8");
    const helper = readFileSync(join(repo, "webview/__tests__/helpers/testBudget.ts"), "utf8");

    it("the config should decide the instrument from the coverage flag, dotted spellings included, and hand it to every worker", () => {
        expect(config).toContain('arg === "--coverage" || arg.startsWith("--coverage.")');
        expect(config).toMatch(/env:\s*\{\s*BIRTA_TEST_COVERAGE:/);
        expect(config).toMatch(/testTimeout:\s*coverageRun\s*\?/);
    });

    it("the helper should read the variable the config sets, by the same factor", () => {
        expect(helper).toContain('process.env["BIRTA_TEST_COVERAGE"] === "1"');
        const factor = Number(/COVERAGE_FACTOR = (\d+)/.exec(helper)?.[1]);
        expect(factor).toBeGreaterThan(1);
        expect(Number(/COVERAGE_FACTOR = (\d+)/.exec(config)?.[1])).toBe(factor);
    });

    it("this worker should have been handed the variable, whichever way it reads", () => {
        // The runtime half: a config that stopped setting `env` leaves it
        // undefined here, whatever the source text says.
        expect(["0", "1"]).toContain(process.env["BIRTA_TEST_COVERAGE"]);
        expect(budget(1000)).toBe(process.env["BIRTA_TEST_COVERAGE"] === "1" ? 4000 : 1000);
    });

    it("the coverage script should be the plain runner with the flag, so the config's detection reaches it", () => {
        const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { scripts: Record<string, string> };
        expect(pkg.scripts["test:coverage"]).toMatch(/vitest run .*--coverage/);
    });
});

describe("the corpus sweeps the coverage run leaves out", { timeout: SCAN_BUDGET_MS }, () => {
    const config = readFileSync(join(repo, "vitest.config.ts"), "utf8");
    const listed = [...(/const CORPUS_SWEEPS = \[([\s\S]*?)\];/.exec(config)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);

    it("should each be a file that exists, or the exclusion is a silent no-op", () => {
        expect(listed.length).toBeGreaterThan(5);
        const missing = listed.filter((f) => !statSync(join(repo, f), { throwIfNoEntry: false }));
        expect(missing).toEqual([]);
    });

    it("should each be a budgeted suite: a corpus walk that needs a budget is what earns the exclusion", () => {
        const unbudgeted = listed.filter((f) => !readFileSync(join(repo, f), "utf8").includes("budget("));
        expect(unbudgeted).toEqual([]);
    });

    it("should be excluded only on a coverage run, so the bare suite and every push still run them", () => {
        expect(config).toMatch(/\.\.\.\(coverageRun \? CORPUS_SWEEPS : \[\]\)/);
    });

    it("every budgeted test that loads the corpus or the perf fixtures should be listed, or say on its import why it stays in", () => {
        // The other direction of the same absence: a fixture walk the list
        // never learned about runs under instrumentation with nobody having
        // decided it should.
        const walks = testFiles(join(repo, "webview/__tests__"))
            .map(relPath)
            .filter((rel) => {
                const text = readFileSync(join(repo, rel), "utf8");
                return text.includes("budget(") && fixtureImport(text) !== undefined;
            });
        expect(walks.length).toBeGreaterThan(8);
        expect(walks).toContain("webview/__tests__/perfFixtureConstructs.test.ts");
        expect(walks, "imports the editor factory, not the fixtures").not.toContain("webview/__tests__/embedProviderRoster.test.ts");
        const undecided = walks.filter((rel) => {
            if (listed.includes(rel)) return false;
            return !/corpus-sweep-kept:\s*\S/.test(fixtureImport(readFileSync(join(repo, rel), "utf8")) ?? "");
        });
        expect(undecided, "list it in CORPUS_SWEEPS, or annotate its import: corpus-sweep-kept: <reason>").toEqual([]);
    });
});
