/**
 * The Mac page reserves the leading end of the titlebar band for the window's
 * own furniture, and more than one page control has to start after it.
 *
 * That number is declared once, as `--mac-titlebar-leading`, and both readers
 * take it from there. Neither half of that arrangement can fail loudly on its
 * own: a `var()` whose custom property was never declared and carries no
 * fallback computes to the initial value, so a deleted declaration silently
 * pulls both the toolbar and a fullscreen surface's title back under the
 * traffic lights, and a rule that restates the literal instead goes on looking
 * correct until the day the two numbers disagree. This asserts both.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const page = readFileSync(
    path.resolve(__dirname, "../../mac/Resources/index.html"), "utf8");

/** The stylesheet, without the comments that explain the number in prose. */
const css = page.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the leading inset, in source order. */
const declarations = [...css.matchAll(/--mac-titlebar-leading:\s*([^;]+);/g)]
    .map((m) => m[1]!.trim());

describe("the Mac page's titlebar leading inset", () => {
    it("exactly one declaration should give the custom property its value", () => {
        expect(declarations).toHaveLength(1);
        // A length, not a value. What this file is for is that the number has
        // one owner, and pinning the number itself would fail the day someone
        // legitimately moved it, for no defect.
        expect(declarations[0]).toMatch(/^\d+px$/);
    });

    it("every reader should take the inset from that property, never a literal", () => {
        // Derived from the stylesheet rather than listed here: a hand-written
        // list of readers is a list the next reader never joins.
        const readers = [...css.matchAll(/var\(--mac-titlebar-leading[^)]*\)/g)];
        expect(readers.length).toBeGreaterThanOrEqual(2);

        // The literal to look for comes FROM the declaration. Spelled here
        // instead, this check would go on passing against a number the page no
        // longer uses, which is the failure it exists to catch wearing a
        // different hat.
        const literal = declarations[0]!;
        const restated = css.split("\n")
            .filter((line) => line.includes(literal) && !line.includes("--mac-titlebar-leading:"));
        expect(restated, `${literal} restated outside the declaration: ${restated.join(" | ")}`).toEqual([]);
    });

    it("the fullscreen title should clear the window's own buttons", () => {
        // The bundle draws `.fs-title` in the top-left corner, which on this
        // host is where the traffic lights are. The page is the only place
        // that knows that, so the rule has to exist here.
        expect(css).toMatch(/\.fs-title\s*\{[^}]*left:\s*var\(--mac-titlebar-leading\)/);
    });
});
