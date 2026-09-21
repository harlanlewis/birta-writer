/**
 * Guards on the page-ownership audit: `scripts/audit-page-ownership.mjs` and the
 * document it feeds, `docs/PAGE_OWNERSHIP.md`.
 *
 * The audit's whole value is that it can be re-run, so what needs holding is not
 * the verdicts (they are judgement, argued next to each rule) but the two ways
 * the instrument can go quietly wrong.
 *
 * It can stop reaching its subject. A scanner whose patterns have rotted matches
 * nothing and reports a clean audit, which is the shape of pass that no failing
 * run ever prompts anyone to look at. So the floors below are on what the scan
 * REACHED, not on what it found.
 *
 * It can stop discriminating. "Residue is empty" is satisfied by a classifier
 * that hands a verdict to anything at all, and that is a tautology rather than a
 * check. The probe arm asks the classifier for shapes it must refuse and one it
 * must accept, so the residue assertion is worth something.
 *
 * The last test is the one that enforces a rule of the repository rather than a
 * property of the script: AGENTS.md keeps measured numbers out of documents, and
 * the audit is where that rule is most tempting to break, since the document's
 * subject IS a set of counts. Rather than judging every numeral in the prose, it
 * takes the counts this run actually produced and refuses to find any of them
 * written down.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    collect,
    check,
    classify,
    probeClassifier,
    VERDICTS,
    // @ts-expect-error — plain-JS audit script, intentionally untyped.
} from "../../scripts/audit-page-ownership.mjs";

const repoRoot = path.resolve(__dirname, "..", "..");
const DOC = path.join(repoRoot, "docs", "PAGE_OWNERSHIP.md");

interface Occurrence {
    file: string;
    line: number;
    kind: string;
    refinement: string;
    verdict: string;
    why: string;
}
interface Audit {
    tsFiles: number;
    cssFiles: number;
    occurrences: Occurrence[];
}

const audit: Audit = collect();

/**
 * Every family the scan is known to find. A family that stops appearing means a
 * pattern has stopped matching, which no count-based assertion would reveal.
 */
const KNOWN_FAMILIES = [
    "body-child",
    "body-class",
    "body-style",
    "css-fixed",
    "css-selector",
    "css-viewport-unit",
    "doc-focus",
    "doc-listener",
    "doc-misc",
    "doc-query",
    "fixed-position-js",
    "global-scope",
    "head-inject",
    "highlight-registry",
    "root-custom-prop",
    "root-style",
    "viewport-metric",
    "win-global",
    "win-listener",
];

describe("page-ownership audit", () => {
    describe("the scan's reach", () => {
        it("a run over the tree should read the product half of webview/", () => {
            expect(audit.tsFiles).toBeGreaterThan(200);
            expect(audit.cssFiles).toBeGreaterThan(20);
        });

        it("a run over the tree should find every family the audit was written against", () => {
            const found = new Set(audit.occurrences.map((o) => o.kind));
            expect([...found].sort()).toEqual(expect.arrayContaining(KNOWN_FAMILIES));
        });

        it("a run over the tree should reach no test file, since the counts are of the editor", () => {
            const inTests = audit.occurrences.filter((o) => o.file.includes("__tests__"));
            expect(inTests).toEqual([]);
        });
    });

    describe("the classifier", () => {
        it("shapes it must refuse and one it must accept should come back as written", () => {
            expect(probeClassifier()).toEqual([]);
        });

        it("an unknown kind should be refused, so a new shape is raised rather than sorted", () => {
            expect(classify({ kind: "not-a-kind", refinement: "x", file: "webview/x.ts" })).toBeNull();
        });

        it("an unknown document event should be refused, since the family has no catch-all", () => {
            expect(classify({ kind: "doc-listener", refinement: "not-an-event", file: "webview/x.ts" })).toBeNull();
        });
    });

    describe("the audit's own verdict", () => {
        it("a run over the tree should leave nothing unclassified and clear every floor", () => {
            expect(check(audit)).toEqual([]);
        });

        it("every occurrence should carry a verdict from the vocabulary and an argument for it", () => {
            const bad = audit.occurrences.filter(
                (o) => !VERDICTS.includes(o.verdict) || typeof o.why !== "string" || o.why.length < 40,
            );
            expect(bad.map((o) => `${o.file}:${o.line} ${o.kind}/${o.refinement}`)).toEqual([]);
        });
    });

    describe("the document", () => {
        const text = readFileSync(DOC, "utf8");

        it("the write-up should cite the script, so a reader can regenerate the list", () => {
            expect(text).toContain("scripts/audit-page-ownership.mjs");
        });

        it("the write-up should print none of the counts this run produced", () => {
            // Issue ids carry digits that are not measurements, and a code span
            // is an identifier rather than prose. Both come out before the
            // numerals are looked for.
            const prose = text
                .replace(/MAR-\d+/g, "")
                .replace(/```[\s\S]*?```/g, "")
                .replace(/`[^`]*`/g, "");
            const counts = new Set<number>([audit.occurrences.length]);
            for (const v of VERDICTS) counts.add(audit.occurrences.filter((o) => o.verdict === v).length);
            for (const k of KNOWN_FAMILIES) counts.add(audit.occurrences.filter((o) => o.kind === k).length);
            // Below twenty a count collides with an ordinary number in prose, and
            // the numbers worth keeping out of a document are the large ones.
            const printed = [...counts].filter((n) => n >= 20 && new RegExp(`\\b${n}\\b`).test(prose));
            expect(printed).toEqual([]);
        });
    });
});
