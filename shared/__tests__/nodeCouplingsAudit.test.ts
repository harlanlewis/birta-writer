/**
 * Guards on the Node-coupling audit: `scripts/audit-node-couplings.mjs` and the
 * document it feeds, `docs/NODE_COUPLINGS.md`.
 *
 * The audit's whole value is that it can be re-run, so what needs holding is
 * not the verdicts (they are judgement, argued next to each rule) but the four
 * ways the instrument can go quietly wrong. Each has its own describe below.
 *
 * It can stop reaching its subject. A scanner whose patterns have rotted
 * matches nothing and reports a clean audit, which is the shape of pass that no
 * failing run ever prompts anyone to look at. The floors are therefore on what
 * the scan REACHED, not on what it found.
 *
 * It can stop discriminating. "Residue is empty" is satisfied by a classifier
 * that hands a verdict to anything at all. The probe arm asks it for shapes it
 * must refuse and one it must accept, so the residue assertion is worth
 * something.
 *
 * Its one hand-pinned finding can rot. The headline of the write-up is a gate
 * inside `resolveCustomTextEditor`, and a guard over it is worthless unless it
 * can fail, so the arm below feeds it a source that has lost the gate and
 * demands a complaint.
 *
 * And its dependency half can never run. The cross-check against the built
 * bundle is the only thing in the audit that can see a coupling inside a
 * package, and it needs a metafile that `pnpm test` does not build. Rather than
 * skip (which passes, silently, forever), the comparison is driven here with
 * metafiles written in memory, and the missing-file case is asserted to report
 * itself rather than to come back clean.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    collect,
    check,
    classify,
    probeClassifier,
    checkProviderGate,
    crossCheckBundle,
    crossCheckMeta,
    DEPENDENCY_COUPLINGS,
    VERDICTS,
    CAPABILITIES,
    // @ts-expect-error — plain-JS audit script, intentionally untyped.
} from "../../scripts/audit-node-couplings.mjs";

const repoRoot = path.resolve(__dirname, "..", "..");
const DOC = path.join(repoRoot, "docs", "NODE_COUPLINGS.md");

interface Occurrence {
    file: string;
    line: number;
    kind: string;
    refinement: string;
    verdict: string;
    capability: string;
    why: string;
}
interface Audit {
    files: number;
    occurrences: Occurrence[];
}

const audit: Audit = collect();

/** Every family the scan is known to find. One that stops appearing means a pattern has rotted. */
const KNOWN_FAMILIES = [
    "builtin-import",
    "file-scheme",
    "file-uri",
    "forbidden-header",
    "manual-redirect",
    "node-global",
    "os-path",
];

/** A metafile shaped the way esbuild writes one, carrying exactly the given externals. */
function metafileWith(modules: string[]): unknown {
    return {
        outputs: {
            "dist/extension.js": {
                imports: [
                    { path: "vscode", kind: "require-call", external: true },
                    ...modules.map((m) => ({ path: m, kind: "require-call", external: true })),
                ],
            },
        },
    };
}

/** The builtins the source scan accounts for, which is what the cross-check is held against. */
const sourceModules = new Set<string>(
    audit.occurrences.filter((o) => o.kind === "builtin-import").map((o) => o.refinement),
);

describe("node-couplings audit", () => {
    describe("the scan's reach", () => {
        it("a run over the tree should read the product half of the extension and its shared code", () => {
            expect(audit.files).toBeGreaterThan(60);
        });

        it("a run over the tree should find every family the audit was written against", () => {
            const found = new Set(audit.occurrences.map((o) => o.kind));
            expect([...found].sort()).toEqual(expect.arrayContaining(KNOWN_FAMILIES));
        });

        it("a run over the tree should reach no test file, since the subject is what would ship", () => {
            const inTests = audit.occurrences.filter(
                (o) => o.file.includes("__tests__") || o.file.startsWith("src/test/"),
            );
            expect(inTests).toEqual([]);
        });

        it("the webview's own code should be outside the scan, since it has no Node to lose", () => {
            const inWebview = audit.occurrences.filter((o) => o.file.startsWith("webview/"));
            expect(inWebview).toEqual([]);
        });
    });

    describe("the classifier", () => {
        it("shapes it must refuse and one it must accept should come back as written", () => {
            expect(probeClassifier()).toEqual([]);
        });

        it("an unknown kind should be refused, so a new shape is raised rather than sorted", () => {
            expect(classify({ kind: "not-a-kind", refinement: "x", file: "src/x.ts" })).toBeNull();
        });

        it("a builtin with no rule should be refused, so a new import is raised rather than sorted", () => {
            expect(classify({ kind: "builtin-import", refinement: "worker_threads", file: "src/x.ts" })).toBeNull();
        });

        it("a file-narrowed rule should beat the general one for the same shape", () => {
            const general = classify({ kind: "builtin-import", refinement: "path", file: "src/htmlExport.ts" });
            const narrowed = classify({ kind: "builtin-import", refinement: "path", file: "src/keybindings.ts" });
            expect(general.verdict).not.toEqual(narrowed.verdict);
        });
    });

    describe("the gate the write-up's headline rests on", () => {
        it("the tree as it stands should satisfy the pin", () => {
            expect(checkProviderGate()).toEqual([]);
        });

        it("a source that has lost the gate should be complained about, or the pin holds nothing", () => {
            const withoutGate = `
                async resolveCustomTextEditor(document, webviewPanel, _token) {
                    const uriKey = document.uri.toString();
                }
            `;
            expect(checkProviderGate(withoutGate).length).toBeGreaterThan(0);
        });

        it("a source that has lost the entry point should say so rather than pass", () => {
            expect(checkProviderGate("export class Nothing {}").length).toBeGreaterThan(0);
        });
    });

    describe("the cross-check against the built bundle", () => {
        it("a bundle requiring only what the source scan found should be clean", () => {
            const meta = metafileWith([...sourceModules, ...DEPENDENCY_COUPLINGS.map((d: { module: string }) => d.module)]);
            expect(crossCheckMeta(meta, sourceModules)).toEqual({ checked: true, problems: [], note: "" });
        });

        it("a builtin no source site accounts for should be raised as a dependency's new coupling", () => {
            const meta = metafileWith([
                ...sourceModules,
                ...DEPENDENCY_COUPLINGS.map((d: { module: string }) => d.module),
                "worker_threads",
            ]);
            const { problems } = crossCheckMeta(meta, sourceModules) as { problems: string[] };
            expect(problems.join("\n")).toContain("worker_threads");
        });

        it("a recorded dependency coupling that has left the bundle should be raised, not left claiming", () => {
            const invented = [{ module: "worker_threads", package: "some-package", verdict: "drops", capability: "cross-cutting", why: "x" }];
            const meta = metafileWith([...sourceModules]);
            const { problems } = crossCheckMeta(meta, sourceModules, invented) as { problems: string[] };
            expect(problems.join("\n")).toContain("worker_threads");
        });

        it("a dependency coupling the source also imports should be exempt from that, since the bundle cannot tell them apart", () => {
            // `fs` is harper.js's coupling AND keybindings.ts's import, so a
            // bundle requiring `fs` says nothing about harper.js. Asserted
            // rather than left implicit, because the arm above would otherwise
            // read as covering every entry in the list.
            const shadowed = [{ module: "fs", package: "harper.js", verdict: "degrades", capability: "proofreading", why: "x" }];
            expect(sourceModules.has("fs")).toBe(true);
            const meta = metafileWith([...sourceModules].filter((m) => m !== "fs"));
            const { problems } = crossCheckMeta(meta, sourceModules, shadowed) as { problems: string[] };
            expect(problems).toEqual([]);
        });

        it("a metafile that is not a build of the extension bundle should be refused rather than read", () => {
            const { checked, problems } = crossCheckMeta({ outputs: { "dist/webview.js": { imports: [] } } }, sourceModules) as {
                checked: boolean;
                problems: string[];
            };
            expect(checked).toBe(false);
            expect(problems.length).toBeGreaterThan(0);
        });

        it("no metafile at all should report itself, since a silent skip reads exactly like a clean bill", () => {
            const absent = path.join(repoRoot, "dist", "no-such-metafile.json");
            const { checked, problems, note } = crossCheckBundle(absent, sourceModules) as {
                checked: boolean;
                problems: string[];
                note: string;
            };
            expect(checked).toBe(false);
            expect(problems).toEqual([]);
            expect(note).toContain("NOT checked");
        });
    });

    describe("the audit's own verdict", () => {
        it("a run over the tree should leave nothing unclassified and clear every floor", () => {
            // The metafile is a build artifact `pnpm test` does not produce, so
            // the dependency half is pointed at nothing here on purpose: this
            // arm is about the source half, and the arms above are what hold
            // the comparison.
            const { problems } = check(audit, { metafile: path.join(repoRoot, "dist", "no-such-metafile.json") }) as {
                problems: string[];
            };
            expect(problems).toEqual([]);
        });

        it("every coupling should carry a verdict, a capability, and an argument for both", () => {
            const bad = audit.occurrences.filter(
                (o) =>
                    !VERDICTS.includes(o.verdict) ||
                    !CAPABILITIES.includes(o.capability) ||
                    typeof o.why !== "string" ||
                    o.why.length < 80,
            );
            expect(bad.map((o) => `${o.file}:${o.line} ${o.kind}/${o.refinement}`)).toEqual([]);
        });

        it("every recorded dependency coupling should carry the same argument a source rule does", () => {
            const bad = (DEPENDENCY_COUPLINGS as { module: string; package: string; verdict: string; capability: string; why: string }[]).filter(
                (d) => !VERDICTS.includes(d.verdict) || !CAPABILITIES.includes(d.capability) || d.why.length < 80,
            );
            expect(bad.map((d) => d.module)).toEqual([]);
        });
    });

    describe("the document", () => {
        const text = readFileSync(DOC, "utf8");

        it("the write-up should cite the script, so a reader can regenerate the list", () => {
            expect(text).toContain("scripts/audit-node-couplings.mjs");
        });

        it("the write-up should print none of the counts this run produced", () => {
            // Issue ids carry digits that are not measurements, and a code span
            // is an identifier rather than prose. Both come out before the
            // numerals are looked for.
            const prose = text
                .replace(/MAR-\d+/g, "")
                .replace(/```[\s\S]*?```/g, "")
                .replace(/`[^`]*`/g, "");
            const counts = new Set<number>([audit.occurrences.length, audit.files]);
            for (const v of VERDICTS) counts.add(audit.occurrences.filter((o) => o.verdict === v).length);
            for (const c of CAPABILITIES) counts.add(audit.occurrences.filter((o) => o.capability === c).length);
            // Below twenty a count collides with an ordinary number in prose,
            // and the numbers worth keeping out of a document are the large ones.
            const printed = [...counts].filter((n) => n >= 20 && new RegExp(`\\b${n}\\b`).test(prose));
            expect(printed).toEqual([]);
        });
    });
});
