/**
 * The ```svg fence's sanitize policy (MAR-402).
 *
 * Asserted against the REAL path: the production config plus the hooks the
 * loader installs with the module, never a config assembled here. The defect
 * this shape exists for is a call site whose assumptions differ from the
 * config's behaviour, which a hand-built config in a test cannot catch.
 *
 * Two things jsdom cannot answer, and `e2e/svgRender` and `e2e/htmlExport`
 * answer instead: whether a surviving `<style>` would actually have applied,
 * and whether a surviving `onload=` or remote `href` would actually have run or
 * fetched. Only a real browser with no CSP can say, and the exported file is
 * the only place in production where there is no CSP.
 */
import { describe, it, expect } from "vitest";
import {
    isRemoteReferenceAttribute,
    SVG_SANITIZE_CONFIG,
    sanitizeSvgMarkup,
} from "../utils/sanitizeLoader";

/** The attribute names an SVG can carry a URL on, plus the shapes that hide one. */
const REMOTE_CASES: [tag: string, attr: string, value: string][] = [
    ["image", "href", "https://evil.example/p.png"],
    ["image", "xlink:href", "https://evil.example/p.png"],
    ["image", "HREF", "HTTPS://evil.example/p.png"],
    ["feImage", "href", "http://evil.example/p.png"],
    ["image", "href", "//evil.example/p.png"],
    ["image", "href", "  https://evil.example/p.png  "],
    ["image", "href", "ht\ttps://evil.example/p.png"],
    ["image", "src", "blob:https://evil.example/x"],
    ["rect", "fill", "url(https://evil.example/paint.png)"],
    ["rect", "filter", "url('//evil.example/f.svg#f')"],
    ["rect", "style", "fill: url( \"https://evil.example/p.png\" )"],
    ["rect", "mask", "url(https://evil.example/m.svg#m)"],
];

/** Everything the strip must leave alone, because none of it fetches remotely. */
const LOCAL_CASES: [tag: string, attr: string, value: string][] = [
    ["rect", "fill", "url(#gradient)"],
    ["rect", "fill", "#4a90d9"],
    ["rect", "style", "fill: red; stroke-width: 2"],
    ["image", "href", "data:image/png;base64,iVBORw0KGgo="],
    ["image", "href", "diagram.png"],
    ["use", "href", "#shape"],
    ["path", "d", "M0 0 L10 10"],
    ["svg", "viewBox", "0 0 240 120"],
    ["text", "font-family", "Helvetica, sans-serif"],
    // The one exemption, and it is only on the URL-attribute limb: a link
    // navigates on a click the reader makes.
    ["a", "href", "https://example.com"],
    ["a", "xlink:href", "https://example.com"],
];

describe("isRemoteReferenceAttribute", () => {
    it.each(REMOTE_CASES)(
        "a %s with %s=%s should be dropped as remote",
        (tag, attr, value) => {
            expect(isRemoteReferenceAttribute(tag, attr, value)).toBe(true);
        },
    );

    it.each(LOCAL_CASES)(
        "a %s with %s=%s should be kept",
        (tag, attr, value) => {
            expect(isRemoteReferenceAttribute(tag, attr, value)).toBe(false);
        },
    );

    it("an <a> carrying a remote url() should still be dropped", () => {
        // The exemption is for NAVIGATION, not for paint: a `url()` inside a
        // presentation or style attribute fetches on paint whatever element it
        // sits on. A blanket per-element exemption would have missed this.
        expect(isRemoteReferenceAttribute("a", "style", "fill: url(https://evil.example/p.png)"))
            .toBe(true);
    });

    it("the case table should cover both verdicts (the instrument's own control)", () => {
        // A predicate that answered one way for everything would satisfy half
        // this file and read as passing. Both lists have to be non-empty, and
        // the predicate has to disagree between them.
        expect(REMOTE_CASES.length).toBeGreaterThan(8);
        expect(LOCAL_CASES.length).toBeGreaterThan(8);
    });
});

describe("SVG_SANITIZE_CONFIG", () => {
    it("should ask for the svg profiles and forbid the style element", () => {
        // Pinned because both are load-bearing and neither is visible from a
        // call site: the profiles are the whole allowlist, and `style` is an
        // ALLOWED svg tag whose selectors reach the whole document.
        expect(SVG_SANITIZE_CONFIG?.USE_PROFILES).toEqual({ svg: true, svgFilters: true });
        expect(SVG_SANITIZE_CONFIG?.FORBID_TAGS).toEqual(["style"]);
    });

    it("should not override FORBID_CONTENTS", () => {
        // DOMPurify REPLACES the default set rather than adding to it, so
        // naming one tag here would silently un-forbid every other, and a
        // stripped `<script>`'s body would leak back in as a text node.
        expect(SVG_SANITIZE_CONFIG).not.toHaveProperty("FORBID_CONTENTS");
    });
});

describe("sanitizeSvgMarkup", () => {
    it("an ordinary picture should come through with its geometry intact", () => {
        // The control for every removal below: a policy that dropped
        // everything would satisfy all of them and ship a blank pane.
        return expect(sanitizeSvgMarkup(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120" width="240" height="120">'
            + '<rect width="240" height="120" fill="#4a90d9"/>'
            + '<text x="10" y="60">hi</text></svg>',
        )).resolves.toMatch(
            /^<svg[^>]*viewBox="0 0 240 120"[^>]*><rect width="240" height="120" fill="#4a90d9"><\/rect><text x="10" y="60">hi<\/text><\/svg>$/,
        );
    });

    it("an onload handler should not survive", async () => {
        const clean = await sanitizeSvgMarkup(
            '<svg xmlns="http://www.w3.org/2000/svg" onload="window.x=1"><rect width="1" height="1"/></svg>',
        );
        expect(clean).not.toMatch(/onload/i);
        expect(clean).toContain("<rect");
    });

    it("a script element and its body should not survive", async () => {
        const clean = await sanitizeSvgMarkup(
            '<svg xmlns="http://www.w3.org/2000/svg"><script>window.x=1</script><rect width="1" height="1"/></svg>',
        );
        // The body matters as much as the tag: DOMPurify's KEEP_CONTENT would
        // otherwise hand `window.x=1` back as a text node.
        expect(clean).not.toMatch(/<script/i);
        expect(clean).not.toContain("window.x=1");
    });

    it("a style element and its rules should not survive", async () => {
        const clean = await sanitizeSvgMarkup(
            '<svg xmlns="http://www.w3.org/2000/svg"><style>.ProseMirror{display:none}</style><rect width="1" height="1"/></svg>',
        );
        expect(clean).not.toMatch(/<style/i);
        expect(clean).not.toContain("ProseMirror");
    });

    it("a remote image reference should be stripped while its element stays", async () => {
        const clean = await sanitizeSvgMarkup(
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/p.png" width="1" height="1"/></svg>',
        );
        expect(clean).not.toContain("evil.example");
        expect(clean).toContain("<image");
    });

    it("an embedded data: image should survive", async () => {
        const clean = await sanitizeSvgMarkup(
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/></svg>',
        );
        expect(clean).toContain("data:image/png;base64,iVBORw0KGgo=");
    });

    it("the MAR-366 style-attribute policy should still apply here", async () => {
        // The hook is installed with the module, so the SVG config inherits it
        // without asking. A fence must not be able to leave its pane.
        const clean = await sanitizeSvgMarkup(
            '<svg xmlns="http://www.w3.org/2000/svg"><rect style="position:fixed;top:0;width:100vw;fill:red" width="1" height="1"/></svg>',
        );
        expect(clean).not.toContain("position");
        expect(clean).not.toContain("100vw");
        expect(clean).toContain("fill:red");
    });

    it("source with no svg element should come back with none", async () => {
        // Not an error from DOMPurify: prose comes back as prose. The pane is
        // what turns this into the error card (codeBlock/svgPane.ts).
        const clean = await sanitizeSvgMarkup("not markup, just a sentence");
        expect(clean).not.toContain("<svg");
    });
});

describe("the html profile", () => {
    it("should be untouched by the SVG remote-reference strip", async () => {
        // The remote strip is one module-level hook shared with `htmlView`, so
        // its gate is the thing to pin: inline HTML's images must still resolve.
        const { loadSanitizer } = await import("../utils/sanitizeLoader");
        const purify = await loadSanitizer();
        const clean = purify.sanitize(
            '<p><img src="https://example.com/a.png"><a href="https://example.com">x</a></p>',
            { USE_PROFILES: { html: true } },
        ) as string;
        expect(clean).toContain("https://example.com/a.png");
        expect(clean).toContain('href="https://example.com"');
    });
});
