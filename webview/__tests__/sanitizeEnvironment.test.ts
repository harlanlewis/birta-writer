/**
 * WHY six test files pin themselves back to the jsdom environment for the
 * sanitizer, held as a check rather than as six comments that cannot fail.
 *
 * DOMPurify does not work under happy-dom, which is this project's default
 * environment. It reports `isSupported: true` and then does nothing useful:
 * measured against jsdom on the same DOMPurify build, with only the
 * environment varying, `<script>alert(1)</script>` comes back intact, a remote
 * `src` survives the module's own hook, and a `<div>` carrying a `style`
 * attribute is destroyed outright. It fails permissively and destructively at
 * once, which is why "happy-dom sanitizes differently" understates it.
 *
 * WHAT THIS IS AND IS NOT. It is a hazard to the suite's ability to notice a
 * regression, not an exposure in the product: happy-dom exists only under
 * Vitest, and the sanitizer that ships runs in Chromium or WebKit. What earns
 * it a guard is the failure one step out. A sanitize assertion written without
 * the pin goes red, and the tempting way to resolve a red is to rewrite the
 * expectation to match what came back, at which point the product's defence
 * can rot with the suite green.
 *
 * WHEN THIS TEST FAILS, THAT IS GOOD NEWS, as long as it fails on the sanitize
 * assertions rather than the environment one. It means happy-dom or DOMPurify
 * has closed the gap: delete this file and the pins with it. Find them by
 * grepping the environment docblock, and re-measure rather than trusting this
 * sentence, because the pinned files are not all pinned for this reason
 * (`htmlExport` and `caretScrollMargin` are pinned for selector parsing and
 * layout defaults, and are none of this file's business).
 *
 * WHY THERE IS NO GUARD ON THE PINS THEMSELVES, which is the check a reader
 * looks for first and the one this file deliberately does not attempt. A
 * static "any test that touches the sanitizer must be pinned" needs a static
 * signal, and there is not one. The editor composition root imports the
 * sanitize loader, so nearly half the suite reaches it transitively while a
 * handful of files actually call it; narrowing the target from the loader to
 * the two production sinks (`components/htmlView`, `components/codeBlock/
 * svgPane`) moves the count by a single file and changes nothing. The opposite
 * signal is no better: only one pinned suite names the sanitize API at all,
 * because the others drive it through the editor. Import reachability
 * discriminates nothing here, and a guard built on it would pass forever
 * without ever testing its subject.
 *
 * Finding the real callers means running them: instrument `loadSanitizer` to
 * record `__vitest_worker__.filepath` on entry, then run
 * `vitest run --project webview`. Do that after adding a sanitize surface and
 * pin whatever new file appears.
 */
import { describe, it, expect } from "vitest";
import { loadSanitizer } from "../utils/sanitizeLoader";

describe("the sanitizer's environment", () => {
    it("DOMPurify under happy-dom should still be the broken thing the pins exist for", async () => {
        // FIRST, because everything below is meaningless in the wrong
        // environment and the failure would read as an upstream fix. This file
        // must never carry an environment docblock of its own, and must not
        // spell that directive anywhere above either: Vitest parses the
        // docblock, so naming it in prose silently moved this file to jsdom and
        // the sanitize assertions then failed for a reason that had nothing to
        // do with their subject.
        expect("happyDOM" in globalThis, "not running under happy-dom; this file must not set an environment").toBe(true);

        const purify = await loadSanitizer();
        const html = (markup: string): string =>
            purify.sanitize(markup, { USE_PROFILES: { html: true } }) as string;

        // The instrument before the finding: a sanitize returning nothing at
        // all would satisfy every "is not stripped" assertion below by being
        // empty, and a module that failed to load would throw before them.
        expect(typeof purify.version).toBe("string");

        expect(html("<p>a</p><script>alert(1)</script>")).toContain("<script>");

        // The module's own remote-reference hook is equally inert here, so the
        // breakage is not confined to DOMPurify's built-in tag handling.
        expect(html('<p><img src="https://example.com/a.png"></p>')).toContain("example.com");
    });
});
