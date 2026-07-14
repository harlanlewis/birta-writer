/**
 * Mermaid theme mode: normalization and a drift guard against the
 * `birta.mermaid.theme` enum contributed in package.json (what the Settings UI
 * offers).
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
    MERMAID_THEME_MODES,
    DEFAULT_MERMAID_THEME_MODE,
    normalizeMermaidThemeMode,
} from "../mermaid";

const root = path.resolve(__dirname, "../..");

describe("normalizeMermaidThemeMode", () => {
    it("a known mode should pass through unchanged", () => {
        expect(normalizeMermaidThemeMode("light")).toBe("light");
        expect(normalizeMermaidThemeMode("dark")).toBe("dark");
        expect(normalizeMermaidThemeMode("auto")).toBe("auto");
    });

    it("an unknown or missing value should fall back to the default mode", () => {
        expect(normalizeMermaidThemeMode("neutral")).toBe(DEFAULT_MERMAID_THEME_MODE);
        expect(normalizeMermaidThemeMode(undefined)).toBe(DEFAULT_MERMAID_THEME_MODE);
    });

    it("the default mode should be light (white canvas everywhere)", () => {
        expect(DEFAULT_MERMAID_THEME_MODE).toBe("light");
    });
});

describe("contributed setting drift guards", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const prop = pkg.contributes.configuration.properties["birta.mermaid.theme"];

    it("the package.json enum should list exactly the shared modes", () => {
        expect(prop, "birta.mermaid.theme is not contributed").toBeDefined();
        expect(prop.enum).toEqual([...MERMAID_THEME_MODES]);
    });

    it("the package.json default should match the shared default", () => {
        expect(prop.default).toBe(DEFAULT_MERMAID_THEME_MODE);
    });
});
