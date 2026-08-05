/**
 * Calc engine purity guard: the two claims in the header of
 * `webview/utils/calc.ts` are enforced here rather than left to review.
 *
 *   "Pure functions, no ProseMirror, no DOM."
 *   "SAFETY IS THE WHOLE POINT. This never touches `eval`, `new Function`, or
 *    any other dynamic-code path, and it never reaches the network or an LLM."
 *
 * Both hold today. Neither was checked by anything, in a 1,500-line module with
 * four editor-bound consumers (plugins/calc.ts, calcRefresh.ts, calcStale.ts,
 * components/codeBlock/calcLedger.ts). The realistic erosion is small and
 * local: reaching for `t()` to phrase a refusal, or pulling
 * CARET_CONTEXT_WINDOW straight from plugins/caretSuggest.ts instead of taking
 * it as a parameter. Either reads as a one-line convenience in review and is
 * invisible afterwards. The engine's value is that a reader can see it is pure
 * arithmetic over a fixed token set, so the wall is the feature.
 *
 * The wall is `webview/utils/calc*.ts`, by glob rather than by list, so a
 * future core module is walled by default instead of by remembering. Its one
 * limit is the naming convention: core logic parked in a file not named
 * `calc*` sits outside. Tests live in webview/__tests__, so they are outside
 * the glob and unconstrained.
 *
 * Two checks:
 *  1. Imports must come from a three-entry allowlist. This is what catches
 *     ProseMirror, i18n, messaging, and every other editor coupling, since all
 *     of them need an import. It is specifier-based, not static-only, so the
 *     lazy `import("./calcUnitsEngine")` seam that keeps mathjs off the launch
 *     path stays legal while a dynamic `import("@/i18n")` does not.
 *  2. Banned call and member shapes, which need no import and so escape (1).
 *
 * Comments are stripped before both scans, and that is load-bearing rather
 * than tidy: these files describe the very guarantee being enforced. calc.ts
 * says "never touches `eval`, `new Function`" and calls itself "eval-free,
 * network-free" twice; calcUnits.ts mentions `math.evaluate()` and "at fetch
 * time". A raw-text scan fails the module for documenting its own contract.
 *
 * What this does NOT do, so nobody reads more assurance into a green run than
 * is there: it is a text scan, not a proof. Aliasing (`const g = eval; g(x)`)
 * and computed access (`window["fetch"]`) go straight past it, as does any
 * name built at runtime. That is an accepted ceiling rather than a gap to
 * close — the failure this guards against is a one-line convenience added in
 * good faith, not someone routing around the wall, and a reviewer who sees
 * `window["fetch"]` in an arithmetic parser needs no test to tell them.
 * Likewise the strip is regex-based, not a parser, so a `//` or block-comment
 * sequence inside a string or regex literal could blank the rest of a line —
 * a false NEGATIVE, never a false positive. The one regex literal at issue
 * (CALC_COMMENT in calc.ts, /^\s*(#|\/\/)/) writes its slashes
 * backslash-separated, so it does not match the strip pattern.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const UTILS_DIR = path.resolve(__dirname, "..", "utils");

/** The walled module set: every `calc*.ts` directly in webview/utils. */
function coreFiles(): string[] {
    return fs
        .readdirSync(UTILS_DIR)
        .filter((name) => /^calc.*\.ts$/.test(name))
        .sort()
        .map((name) => path.join(UTILS_DIR, name));
}

/**
 * Everything the engine may depend on. `mathjs` is reached only through
 * calcUnitsEngine.ts, which the core may name in a type-only static import or
 * a dynamic `import()` but never a static VALUE import — see the launch-path
 * test below for why that distinction is the whole point.
 */
const ALLOWED_SPECIFIERS = new Set(["./calcUnits", "./calcUnitsEngine", "mathjs"]);

/** The module that statically imports mathjs, as a specifier. */
const UNITS_ENGINE = "./calcUnitsEngine";
/**
 * A static import of the units engine, capturing the `type` modifier when it is
 * present. Matched against whole (stripped) file text rather than per line, so a
 * multi-line import list is still one match. The dynamic `import("...")` form
 * has no `from` and so is deliberately not matched here.
 */
const STATIC_UNITS_ENGINE_IMPORT = /\bimport\s+(type\s+)?[^;]*?from\s*["']\.\/calcUnitsEngine["']/g;

/**
 * Every module-specifier form in one pattern: `from "x"` (which also covers
 * the re-export at calc.ts:810), the dynamic `import("x")`, and the bare
 * side-effect `import "x"`. `import type { T } from` is caught by its `from`.
 */
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/** Dynamic-code, network, and storage paths, plus DOM globals an import can't catch. */
const BANNED_SHAPES: ReadonlyArray<{ label: string; re: RegExp }> = [
    // Bare word, not `eval\s*\(`: the call-shape form misses indirect eval
    // (`(0, eval)("...")`), and it costs nothing to widen because no identifier
    // in the engine is a standalone `eval` — the `evaluate*` family keeps going
    // past the word boundary, which the probes below pin.
    { label: "eval", re: /\beval\b/ },
    // Without `new` too: `Function("return " + expr)()` is eval by another name
    // and is the more natural way to write it by accident.
    { label: "Function()", re: /\bFunction\s*\(/ },
    { label: "fetch()", re: /\bfetch\s*\(/ },
    { label: "XMLHttpRequest", re: /\bXMLHttpRequest\b/ },
    { label: "WebSocket", re: /\bWebSocket\b/ },
    { label: "EventSource", re: /\bEventSource\b/ },
    { label: "sendBeacon", re: /\bsendBeacon\b/ },
    { label: "importScripts()", re: /\bimportScripts\s*\(/ },
    // Persistence is not purity: a cached answer that outlives the call is a
    // second source of truth for a number the document already states.
    { label: "localStorage", re: /\blocalStorage\b/ },
    { label: "sessionStorage", re: /\bsessionStorage\b/ },
    { label: "indexedDB", re: /\bindexedDB\b/ },
    // The member name must follow the dot IMMEDIATELY. `\s*` there would match
    // an ordinary sentence ending "...the document. The next one", and this
    // module's prose is full of both words ("the document", "the caret-suggest
    // window"). Comment stripping already removes that text; requiring the
    // identifier means these two patterns are prose-safe on their own as well.
    { label: "document.*", re: /\bdocument\.[A-Za-z_$]/ },
    { label: "window.*", re: /\bwindow\.[A-Za-z_$]/ },
];

/**
 * Blanks comments while preserving line and column positions, so reported
 * offender lines still point at the real source line.
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/\/\/[^\n]*/g, "");
}

function specifiersIn(text: string): string[] {
    return [...text.matchAll(IMPORT_SPECIFIER)].map((m) => m[1]);
}

describe("calc engine purity (webview/utils/calc*.ts)", () => {
    it("the wall should cover every known core module", () => {
        const names = coreFiles().map((f) => path.basename(f));

        // Guards against a vacuous pass: a rename or move that empties the
        // glob must fail loudly rather than scan nothing and go green.
        expect(names).toEqual(expect.arrayContaining(["calc.ts", "calcUnits.ts", "calcUnitsEngine.ts"]));
    });

    it("splitting the engine into a directory should fail rather than escape the wall", () => {
        // The glob is flat, so a `webview/utils/calc/` package would sit
        // entirely outside it — the one way to grow the engine and silently
        // lose every check here. Fail loudly and say what to do instead.
        const dirs = fs
            .readdirSync(UTILS_DIR, { withFileTypes: true })
            .filter((e) => e.isDirectory() && /^calc/.test(e.name))
            .map((e) => e.name);

        expect(
            dirs,
            "The purity wall globs webview/utils/calc*.ts and does not recurse, so a calc* DIRECTORY would "
                + "escape it entirely. Teach coreFiles() to walk it before moving engine code there.",
        ).toEqual([]);
    });

    it("the units engine should never be reached by a static value import", () => {
        // calcUnitsEngine.ts imports mathjs statically. That is only safe
        // because the sole runtime path to it is the dynamic import() in
        // ensureCalcUnits(), which keeps the unit system off the launch
        // path — a first-class concern here (AGENTS.md, "Launch performance").
        // The existing `import type { UnitMath }` is fine: types erase. Turning
        // that one word into a value import would pull mathjs into the eager
        // bundle, and the allowlist above cannot see the difference.
        const offenders: string[] = [];
        for (const file of coreFiles()) {
            if (path.basename(file) === "calcUnitsEngine.ts") { continue; }
            const text = stripComments(fs.readFileSync(file, "utf8"));
            for (const m of text.matchAll(STATIC_UNITS_ENGINE_IMPORT)) {
                if (!m[1]) { offenders.push(`${path.basename(file)}: ${m[0].replace(/\s+/g, " ")}`); }
            }
        }
        expect(
            offenders,
            `A static value import of ${UNITS_ENGINE} pulls mathjs into the launch bundle. Use `
                + "`import type` for types, or `await import()` behind ensureCalcUnits():\n"
                + offenders.join("\n"),
        ).toEqual([]);
    });

    it("the comment strip should blank documentation without moving line numbers", () => {
        const source = 'const a = 1; // eval( here\n/* fetch(\n   document.body */\nconst b = 2;';
        const stripped = stripComments(source);

        expect(stripped).not.toMatch(/\beval\s*\(/);
        expect(stripped).not.toMatch(/\bfetch\s*\(/);
        expect(stripped).not.toMatch(/\bdocument\s*\./);
        expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
        expect(stripped).toContain("const a = 1;");
        expect(stripped).toContain("const b = 2;");
    });

    it("the import matcher should extract every specifier form", () => {
        expect(specifiersIn('import { convertUnit } from "./calcUnits";')).toEqual(["./calcUnits"]);
        expect(specifiersIn('import type { UnitMath } from "./calcUnitsEngine";')).toEqual(["./calcUnitsEngine"]);
        expect(specifiersIn('export { convertUnit } from "./calcUnits";')).toEqual(["./calcUnits"]);
        expect(specifiersIn('const m = await import("./calcUnitsEngine");')).toEqual(["./calcUnitsEngine"]);
        expect(specifiersIn('import "./sideEffect";')).toEqual(["./sideEffect"]);
        // The couplings this wall exists to stop.
        expect(specifiersIn('import { t } from "@/i18n";')).toEqual(["@/i18n"]);
        expect(specifiersIn('import { Plugin } from "../pm";')).toEqual(["../pm"]);
        expect(specifiersIn('const { t } = await import("@/i18n");')).toEqual(["@/i18n"]);
    });

    it("the banned-shape matchers should spare the engine's own vocabulary", () => {
        // The single most important probe here: the module is built out of
        // `evaluate*` names, and an unanchored /eval/ would fail the file on
        // every one of them. The trailing word boundary is what keeps them
        // apart — `evaluate` continues past it, `eval` does not.
        const engineVocabulary = [
            "const value = evaluateExpression(shed.expr);",
            "export function evaluateCalc(input: string): number | null {",
            "export function evaluateCalcBlock(source: string): CalcBlockLine[] {",
            "const unit = evaluateUnitForm(input, resolve);",
        ];
        for (const line of engineVocabulary) {
            expect(BANNED_SHAPES.some(({ re }) => re.test(line)), line).toBe(false);
        }

        // Real sentences from the modules under guard, in a real block comment
        // — the delimiters matter, since they are what the strip keys on.
        const documentation = stripComments([
            "/**",
            " * SAFETY IS THE WHOLE POINT. This never touches `eval`, `new Function`, or any",
            " * deterministic, eval-free, network-free discipline as the `=` path above",
            " * given to `math.unit()` — never to `math.evaluate()`, which",
            " * real scope is only known later, at fetch time).",
            " * the caret-suggest window is the last ≤500 chars, so position 0 is a cut point.",
            " */",
        ].join("\n"));
        for (const { label, re } of BANNED_SHAPES) {
            expect(re.test(documentation), label).toBe(false);
        }

        // The dot-shape patterns are prose-safe on their own, so a future
        // change to stripping can only cost a missed violation there, never a
        // spurious failure on the engine documenting itself.
        const unstrippedProse = [
            "the file round-trips exactly as typed into the document. Nothing persists.",
            "the caret-suggest window. The refresh scanner re-validates every candidate.",
        ].join("\n");
        for (const label of ["document.*", "window.*"]) {
            const { re } = BANNED_SHAPES.find((s) => s.label === label)!;
            expect(re.test(unstrippedProse), label).toBe(false);
        }
    });

    it("the eval matcher should depend on comment stripping, by design", () => {
        // Widening `eval` to a bare word buys indirect eval — `(0, eval)(x)`,
        // which no call-shape pattern sees — and pays for it by matching the
        // engine's own prose: calc.ts calls itself "eval-free" twice, and the
        // hyphen is a word boundary. Pinned rather than left implicit, so
        // anyone weakening the strip learns which pattern goes false-positive
        // first, and why the trade was taken.
        const evalMatcher = BANNED_SHAPES.find((s) => s.label === "eval")!.re;

        expect(evalMatcher.test("deterministic, eval-free, network-free discipline")).toBe(true);
        expect(evalMatcher.test(stripComments("// deterministic, eval-free, network-free"))).toBe(false);
        expect(evalMatcher.test("const f = (0, eval)('1+1');")).toBe(true);
    });

    it("the banned-shape matchers should flag real dynamic-code and network paths", () => {
        const violations = [
            "const f = eval(expr);",
            "const f = new Function('return ' + expr);",
            "const r = await fetch(url);",
            "const x = new XMLHttpRequest();",
            "const s = new WebSocket(url);",
            "const e = new EventSource(url);",
            "navigator.sendBeacon(url, data);",
            "importScripts('helper.js');",
            "const el = document.createElement('div');",
            "window.addEventListener('resize', onResize);",
            // The forms an earlier, narrower version of this list missed.
            "const f = Function('return ' + expr)();",
            "const f = (0, eval)('1+1');",
            "localStorage.setItem('lastAnswer', String(value));",
        ];
        for (const line of violations) {
            expect(BANNED_SHAPES.some(({ re }) => re.test(line)), line).toBe(true);
        }
    });

    it("the calc engine should import nothing outside its allowlist", () => {
        const offenders: string[] = [];
        for (const file of coreFiles()) {
            const lines = stripComments(fs.readFileSync(file, "utf8")).split("\n");
            lines.forEach((line, idx) => {
                for (const spec of specifiersIn(line)) {
                    if (!ALLOWED_SPECIFIERS.has(spec)) {
                        offenders.push(`${path.basename(file)}:${idx + 1} imports "${spec}"`);
                    }
                }
            });
        }
        expect(
            offenders,
            "The calc engine is pure by contract (see the header of webview/utils/calc.ts): text in, data out, "
                + "no ProseMirror, no DOM, no i18n, no network. Pass what you need in as a parameter, or put the "
                + "editor-facing code in webview/plugins/calc*.ts, which is where the coupling belongs:\n"
                + offenders.join("\n"),
        ).toEqual([]);
    });

    it("the calc engine should contain no dynamic-code or network path", () => {
        const offenders: string[] = [];
        for (const file of coreFiles()) {
            const lines = stripComments(fs.readFileSync(file, "utf8")).split("\n");
            lines.forEach((line, idx) => {
                for (const { label, re } of BANNED_SHAPES) {
                    if (re.test(line)) {
                        offenders.push(`${path.basename(file)}:${idx + 1} uses ${label}`);
                    }
                }
            });
        }
        expect(
            offenders,
            "The calc engine's safety claim is that a reader can see it is pure arithmetic over a fixed token "
                + "set — no dynamic code, no network, no DOM. Anything here breaks that guarantee:\n"
                + offenders.join("\n"),
        ).toEqual([]);
    });
});
