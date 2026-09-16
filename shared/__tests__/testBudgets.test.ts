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
 * budgeted, and every budgeted test that loads the corpus is listed or says
 * on its import line why it stays in (`corpus-sweep-kept: <reason>`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { budget } from "../../webview/__tests__/helpers/testBudget";

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
const HAS_NUMBER = /\b[0-9][0-9_]{2,}\b/;
const EXEMPT = /budget-ok:\s*\S/;

interface Site {
    file: string;
    line: number;
    expression: string;
}

/** Every place a budget is written, in the three shapes. */
function budgetSites(): Site[] {
    const sites: Site[] = [];
    for (const root of TEST_ROOTS) {
        for (const file of testFiles(join(repo, root))) {
            const rel = relPath(file);
            if (rel === SELF) continue;
            const lines = readFileSync(file, "utf8").split("\n");
            let inTestCall = false;
            lines.forEach((text, i) => {
                if (EXEMPT.test(text)) return;
                for (const m of text.matchAll(/\b(?:test|hook)?[tT]imeout"?:\s*([^,}\s]+)/g)) {
                    sites.push({ file: rel, line: i + 1, expression: m[1] });
                }
                // The last argument of a test call: on the line that closes a
                // multi-line callback, or on a one-line `it(...)`. Not any
                // call that happens to take an object and then a number.
                const positional = /^\s*\},\s*(\S+?)\);?\s*$/.exec(text)
                    ?? /^\s*(?:it|test|describe)(?:\.\w+)*\(.*\}\s*,\s*(\S+?)\);?\s*$/.exec(text);
                if (positional) sites.push({ file: rel, line: i + 1, expression: positional[1] });
                if (/^\s*(?:it|test|describe)(?:\.\w+)*\(\s*$/.test(text)) inTestCall = true;
                else if (/^\s*\);?\s*$/.test(text)) inTestCall = false;
                else if (inTestCall) {
                    const own = /^\s*([^\s,]+),\s*$/.exec(text);
                    if (own && (NUMERIC.test(own[1]) || own[1].startsWith("budget("))) {
                        sites.push({ file: rel, line: i + 1, expression: own[1] });
                    }
                }
            });
        }
    }
    return sites;
}

/**
 * A site is fixed when its value is a number, directly or through a name
 * this file binds to an expression that carries a number and no `budget(`.
 * A name bound any other way (a type, a settle delay imported from elsewhere)
 * is not a budget and is not judged.
 */
function isFixed(site: Site): boolean {
    if (site.expression.startsWith("budget(")) return false;
    if (NUMERIC.test(site.expression)) return true;
    if (!/^[A-Za-z_$][\w$]*$/.test(site.expression)) return false;
    const text = readFileSync(join(repo, site.file), "utf8");
    const definition = new RegExp(`(?:const|let|var) ${site.expression.replace(/\$/g, "\\$")}\\s*=\\s*([^;]+);`).exec(text);
    if (!definition) return false;
    return HAS_NUMBER.test(definition[1]) && !definition[1].includes("budget(");
}

describe("test budgets follow the instrument", () => {
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

describe("the config and the helper agree on the coverage variable", () => {
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

describe("the corpus sweeps the coverage run leaves out", () => {
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

    it("every budgeted test that loads the corpus should be listed, or say on its import why it stays in", () => {
        // The other direction of the same absence: a corpus walk the list
        // never learned about runs under instrumentation with nobody having
        // decided it should.
        const walks = testFiles(join(repo, "webview/__tests__"))
            .map(relPath)
            .filter((rel) => {
                const text = readFileSync(join(repo, rel), "utf8");
                return /import[^;]*\bloadCorpusFixtures\b[^;]*from/s.test(text) && text.includes("budget(");
            });
        expect(walks.length).toBeGreaterThan(8);
        const undecided = walks.filter((rel) => {
            if (listed.includes(rel)) return false;
            const importLine = readFileSync(join(repo, rel), "utf8").split("\n")
                .find((line) => /\bloadCorpusFixtures\b/.test(line) && /import|from "/.test(line));
            return !(importLine && /corpus-sweep-kept:\s*\S/.test(importLine));
        });
        expect(undecided, "list it in CORPUS_SWEEPS, or annotate its import: corpus-sweep-kept: <reason>").toEqual([]);
    });
});
