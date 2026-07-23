/**
 * Guards the chrome-primitive cascade order.
 *
 * The ui-* primitives (.ui-btn, .ui-menu-row, .ui-notice) and the surface
 * classes composed onto them (.tb-btn, .slash-menu-item, ...) tie on
 * specificity — a single class each — so WHICH rule wins is decided purely by
 * bundle order. chrome.css must therefore be the FIRST stylesheet in the
 * webview entry's import graph: every surface override (a menu's denser
 * padding, the fm chips' em font, .content-guard-notice's fixed anchoring)
 * silently loses the moment something is imported above it. esbuild orders
 * CSS by module evaluation order, so this is one moved line away from
 * breaking with no compile error.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WEBVIEW_DIR = join(__dirname, "..");

describe("chrome.css cascade position", () => {
    it("chrome.css should be the first stylesheet import of the webview entry", () => {
        const src = readFileSync(join(WEBVIEW_DIR, "index.ts"), "utf8");
        const cssImports = [...src.matchAll(/^import\s+"(\.[^"]+\.css)";/gm)].map(
            (m) => m[1],
        );
        expect(cssImports[0]).toBe("./ui/chrome.css");
    });

    it("the built bundle should emit the primitives before the surfaces", () => {
        // Belt-and-braces on the real artifact when a build exists (the unit
        // suite must also pass on a clean checkout with no dist/).
        const bundle = join(WEBVIEW_DIR, "..", "dist", "webview.css");
        if (!existsSync(bundle)) return;
        const css = readFileSync(bundle, "utf8");
        const uiBtn = css.indexOf(".ui-btn");
        const uiRow = css.indexOf(".ui-menu-row");
        const tbBtn = css.indexOf(".tb-btn");
        const slashItem = css.indexOf(".slash-menu-item");
        expect(uiBtn).toBeGreaterThanOrEqual(0);
        expect(uiRow).toBeGreaterThanOrEqual(0);
        expect(uiBtn).toBeLessThan(tbBtn);
        expect(uiRow).toBeLessThan(slashItem);
    });
});
