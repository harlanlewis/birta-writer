/**
 * Guards for the find bar's lazily-injected `::highlight()` rules.
 *
 * These rules are kept OUT of the eagerly-loaded `findBar.css` on purpose:
 * Blink resolves a style for every registered custom highlight name while
 * resolving every element's style, so an unused `::highlight()` rule is a
 * per-element cost on the mount path — one such rule was enough to fail the
 * blocking `launch-perf` gate (measurements in the source header). Nothing
 * about that is visible in a behavior test, so it needs a structural one —
 * otherwise the rules drift back into the stylesheet and the cost returns
 * silently.
 *
 * The rest of the find bar's highlight *behavior* lives in `findBar.test.ts`
 * (registry writes) and `e2e/findScope` (the real Custom Highlight API, which
 * jsdom does not implement at all).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIND_HIGHLIGHT_CSS, ensureFindHighlightStyles } from "../components/findBar/highlightStyles";

const FIND_BAR_DIR = join(__dirname, "..", "components", "findBar");
const read = (name: string) => readFileSync(join(FIND_BAR_DIR, name), "utf8");

/** Every `::highlight(name)` a chunk of CSS paints. */
const ruleNames = (css: string) =>
    [...css.matchAll(/::highlight\(\s*([\w-]+)\s*\)/g)].map((m) => m[1]).sort();

/**
 * Every highlight name the find bar registers at runtime. `setHighlight` is
 * the single funnel — it is what installs the rules — so a name that reaches
 * `CSS.highlights` any other way is itself a bug this catches.
 */
const registeredNames = (ts: string) =>
    [...ts.matchAll(/setHighlight\(\s*"([\w-]+)"/g)].map((m) => m[1]).sort();

describe("find highlight styles: injection", () => {
    beforeEach(() => {
        document.head.innerHTML = "";
    });

    it("importing the module should inject nothing on its own", () => {
        // The whole point: a launch that never searches never pays. Only the
        // explicit call below installs anything.
        expect(document.getElementById("find-highlight-styles")).toBeNull();
    });

    it("the first call should inject the rules into the document head", () => {
        ensureFindHighlightStyles();

        const style = document.getElementById("find-highlight-styles");
        expect(style).not.toBeNull();
        expect(style?.tagName).toBe("STYLE");
        expect(style?.textContent).toBe(FIND_HIGHLIGHT_CSS);
    });

    it("repeated calls should leave exactly one style element", () => {
        ensureFindHighlightStyles();
        ensureFindHighlightStyles();
        ensureFindHighlightStyles();

        expect(document.querySelectorAll("#find-highlight-styles")).toHaveLength(1);
    });
});

describe("find highlight styles: launch-cost guards", () => {
    it("findBar.css should declare no ::highlight rule", () => {
        // A rule here is paid by every launch, including the launches of every
        // user who never opens Find. Put it in highlightStyles.ts instead.
        expect(ruleNames(read("findBar.css"))).toEqual([]);
    });

    it("registering a highlight should go through the single funnel", () => {
        // `setHighlight` is what injects the rules, so a direct
        // `CSS.highlights.set` would paint nothing. Exactly one call site: the
        // one inside `setHighlight` itself. (Deletes are unaffected.)
        const calls = read("index.ts").match(/CSS\.highlights\.set\(/g) ?? [];

        expect(calls).toHaveLength(1);
    });

    it("every highlight name the bar registers should have exactly one rule", () => {
        const painted = ruleNames(FIND_HIGHLIGHT_CSS);
        const registered = registeredNames(read("index.ts"));

        expect(registered.length).toBeGreaterThan(0);
        expect(painted).toEqual([...new Set(painted)]);
        expect(painted).toEqual(registered);
    });

    it("the injected CSS should name colors only through --vscode-* tokens", () => {
        // noColorLiterals.test.ts reaches this string since MAR-260 and covers
        // the literal half centrally. What is local is the stronger claim: a
        // highlight's paint must be a bare theme token, not merely not a literal.
        expect(FIND_HIGHLIGHT_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
        for (const [, value] of FIND_HIGHLIGHT_CSS.matchAll(/background-color:\s*([^;]+);/g)) {
            expect(value.trim()).toMatch(/^var\(--vscode-[\w-]+\)$/);
        }
    });
});
