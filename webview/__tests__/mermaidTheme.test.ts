/**
 * Mermaid palette-selection helpers.
 *
 * Guards the decision that keeps a Mermaid diagram's palette matching the editor
 * at first paint and across live theme switches: which theme is derived from the
 * live `--vscode-editor-background`. This is the behavior that previously relied
 * on the extension pushing a `setTheme` message at boot; that round-trip was
 * removed, so a diagram is now themed purely from the native variable read here.
 */
import { describe, it, expect } from "vitest";
import { parseRgb, isDarkBackground, mermaidThemeForBackground } from "../components/codeBlock/mermaidTheme";

describe("parseRgb", () => {
    it("a 6-digit hex should parse to channels", () => {
        expect(parseRgb("#1e1e1e")).toEqual({ r: 30, g: 30, b: 30 });
    });

    it("a 3-digit hex should expand each nibble", () => {
        expect(parseRgb("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    });

    it("an rgb() string should parse", () => {
        expect(parseRgb("rgb(255, 255, 255)")).toEqual({ r: 255, g: 255, b: 255 });
    });

    it("an rgba() string should parse, ignoring alpha", () => {
        expect(parseRgb("rgba(30, 30, 30, 0.5)")).toEqual({ r: 30, g: 30, b: 30 });
    });

    it("surrounding whitespace should be tolerated", () => {
        expect(parseRgb("  #ffffff  ")).toEqual({ r: 255, g: 255, b: 255 });
    });

    it("an empty or unrecognized string should return null", () => {
        expect(parseRgb("")).toBeNull();
        expect(parseRgb("transparent")).toBeNull();
        expect(parseRgb("var(--x)")).toBeNull();
    });
});

describe("isDarkBackground", () => {
    // Real VS Code editor backgrounds — the values that actually reach this code.
    it("VS Code Dark+ background (#1e1e1e) should be dark", () => {
        expect(isDarkBackground("#1e1e1e")).toBe(true);
    });

    it("VS Code Light+ background (#ffffff) should be light", () => {
        expect(isDarkBackground("#ffffff")).toBe(false);
    });

    it("a near-white light sidebar (#f3f3f3) should be light", () => {
        expect(isDarkBackground("#f3f3f3")).toBe(false);
    });

    it("GitHub-dark background (#0d1117) should be dark", () => {
        expect(isDarkBackground("#0d1117")).toBe(true);
    });

    it("an rgb() white should be light", () => {
        expect(isDarkBackground("rgb(255, 255, 255)")).toBe(false);
    });

    // Cases the old substring heuristic (!bg.includes("255") && !bg.includes("fff"))
    // got wrong — documented here so the improvement can't silently regress.
    it("a dark color whose hex contains '255' should still be dark", () => {
        // #255010 is a very dark green; luminance ~52. The old heuristic saw the
        // "255" substring and wrongly called it light.
        expect(isDarkBackground("#255010")).toBe(true);
    });

    it("a dark color whose hex contains 'fff' — via rgb — stays classified by luminance", () => {
        // rgb(0, 15, 15) is nearly black; the digits alone can't decide it.
        expect(isDarkBackground("rgb(0, 15, 15)")).toBe(true);
    });

    it("an unparseable or empty background should default to dark", () => {
        // The variable being absent is treated as a dark editor surface, matching
        // the historical behavior when getComputedStyle returned "".
        expect(isDarkBackground("")).toBe(true);
        expect(isDarkBackground("nonsense")).toBe(true);
    });

    it("a gray below the midpoint should be dark, one clearly above should be light", () => {
        expect(isDarkBackground("#707070")).toBe(true); // luminance 112
        expect(isDarkBackground("#999999")).toBe(false); // luminance 153
    });
});

describe("mermaidThemeForBackground", () => {
    it("a dark editor background should select the 'dark' Mermaid theme", () => {
        expect(mermaidThemeForBackground("#1e1e1e")).toBe("dark");
    });

    it("a light editor background should select the 'default' Mermaid theme", () => {
        expect(mermaidThemeForBackground("#ffffff")).toBe("default");
    });
});
