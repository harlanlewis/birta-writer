/**
 * @vitest-environment node
 *
 * Node rather than the webview project's jsdom: esbuild refuses to run where
 * `new TextEncoder().encode("")` is not a real `Uint8Array`, which is what
 * jsdom's own TextEncoder produces. Nothing here touches a DOM.
 */
/**
 * The CSS that lives in `.ts` must parse the way the CSS in `.css` does.
 *
 * `esbuild.mjs` refuses a build whose own source produced a warning, which is
 * what catches a selector that compiles to something matching no element:
 * `&--today` nested inside `.date-picker__day` is a TYPE selector, not a
 * suffix, so the rule is dropped in silence and nothing downstream can tell it
 * was written. That gate reads only what the build parses.
 *
 * Some stylesheets are not in that set. `components/findBar/highlightStyles.ts`
 * and its kind hold their rules in a template literal and reach the page as
 * `<style>` text, for measured launch-cost reasons, so esbuild never parses
 * them and the build gate cannot speak for them. How many there are is not
 * written down here: the sweep below enumerates them, and a count in a comment
 * is a count that rots. This is the same scan-scope gap MAR-260 closed for the
 * token and colour rules, arriving one guard later, and the lesson recorded
 * then was that a bespoke per-file regex is weaker than the rule it stands
 * in for.
 *
 * So the judge here is esbuild itself rather than a pattern written by hand. A
 * pattern would have to know which `&` forms are legal, which is a CSS parser,
 * and putting one in a test file moves the parser somewhere that has no tests
 * of its own.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { cssSourcesInTypeScript } from "./helpers/cssSources";

const WEBVIEW_DIR = join(__dirname, "..");

describe("CSS authored inside .ts", () => {
    // `stylesheet` only. The `inline` kind is a synthesized one-line rule
    // standing in for `el.style.x = "…"`, which the browser's CSSOM parses per
    // property and never as a selector, so a selector rule cannot apply to it.
    const sheets = cssSourcesInTypeScript(WEBVIEW_DIR).filter((s) => s.kind === "stylesheet");

    it("the sweep should reach at least one stylesheet, or every case below is vacuous", () => {
        expect(sheets.length).toBeGreaterThan(0);
    });

    it.each(sheets.map((s) => [s.file, s]))(
        "%s should parse with no warning from the real CSS parser",
        async (_file, sheet) => {
            const { warnings } = await esbuild.transform(sheet.text, { loader: "css" });
            const shown = warnings.map(
                (w) => `${sheet.file}:${(w.location?.line ?? 0) + sheet.startLine - 1}: ${w.text}`,
            );
            expect(shown).toEqual([]);
        },
    );

    it("a nested suffix should be refused, so the case above discriminates", async () => {
        // Without this the arm above passes on a build where `transform` stopped
        // reporting, or where the loader was wrong and it parsed as something
        // that has no opinion about selectors.
        const { warnings } = await esbuild.transform(
            ".block { color: red; &--modifier { color: blue; } }",
            { loader: "css" },
        );
        expect(warnings.length).toBeGreaterThan(0);
    });
});
