/**
 * Every test budget in the tree follows the instrument, and the two halves
 * that make that true agree on their one variable.
 *
 * A test that is slow by nature (a corpus walk, a whole-tree scan, a sweep
 * through a real editor) gets a budget, and a budget written as a fixed
 * number is a claim about one machine on one day: under coverage
 * instrumentation on a shared runner the same work reads several times
 * slower, and the nightly coverage job went red three times in one week on
 * exactly that, with nothing wrong in the tree. So a budget goes through
 * `budget()` in `webview/__tests__/helpers/testBudget.ts`, which scales it
 * under coverage, and this file refuses a raw number wherever Vitest reads a
 * budget, so the next slow test cannot bring one back.
 *
 * Vitest reads a budget in three shapes, and all three are swept: a
 * `timeout:` option (`describe`/`it` options, `vi.waitFor`, and the
 * `testTimeout`/`hookTimeout` of `vi.setConfig`); a positional last argument
 * on the closing line of a test (`}, 60_000);`); and the same argument on a
 * line of its own inside a multi-line `it(` call. A number that is not a
 * budget (a fake `requestIdleCallback`'s own deadline) says so with a
 * same-line `budget-exempt: <reason>` comment, the idiom the other sweeps use.
 *
 * The helper reads `BIRTA_TEST_COVERAGE`; `vitest.config.ts` sets it for every
 * worker from the `--coverage` flag and raises the default timeout by the same
 * factor. The pairing is held two ways: as source text over both files,
 * because a config that stopped handing the variable down would leave every
 * budget at its bare size with the suite green; and at runtime, because this
 * worker must have been handed a value at all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { budget } from "../../webview/__tests__/helpers/testBudget";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SELF = "shared/__tests__/testBudgets.test.ts";

const TEST_ROOTS = ["webview/__tests__", "shared/__tests__", "src/__tests__", "packages/minimal-diff/src/__tests__"];

function testFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) testFiles(full, out);
        else if (name.endsWith(".test.ts")) out.push(full);
    }
    return out;
}

const NUMERIC = /^[0-9][0-9_]*$/;
const EXEMPT = /budget-exempt:\s*\S/;

interface Site {
    file: string;
    line: number;
    expression: string;
}

/** Every place a budget is written, in the three shapes Vitest reads. */
function budgetSites(): Site[] {
    const sites: Site[] = [];
    for (const root of TEST_ROOTS) {
        for (const file of testFiles(join(repo, root))) {
            const rel = relative(repo, file).split(/[\\/]/).join("/");
            if (rel === SELF) continue;
            const lines = readFileSync(file, "utf8").split("\n");
            let inTestCall = false;
            lines.forEach((text, i) => {
                if (EXEMPT.test(text)) return;
                for (const m of text.matchAll(/\b(?:test|hook)?[tT]imeout:\s*([^,}\s]+)/g)) {
                    sites.push({ file: rel, line: i + 1, expression: m[1] });
                }
                const positional = /^\s*\},\s*(\S+?)\);?\s*$/.exec(text);
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
 * A site is fixed when its value is a number, directly or through a constant
 * this file defines as one. A name defined any other way (a type, a shared
 * settle delay) is not a budget and is not judged.
 */
function isFixed(site: Site): boolean {
    if (site.expression.startsWith("budget(")) return false;
    if (NUMERIC.test(site.expression)) return true;
    if (!/^[A-Za-z_$][\w$]*$/.test(site.expression)) return false;
    const text = readFileSync(join(repo, site.file), "utf8");
    const definition = new RegExp(`const ${site.expression.replace(/\$/g, "\\$")}\\s*=\\s*([^;]+);`).exec(text);
    return definition !== null && NUMERIC.test(definition[1].trim());
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

    it("the config should decide the instrument from the coverage flag and hand it to every worker", () => {
        expect(config).toContain('process.argv.includes("--coverage")');
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
});
