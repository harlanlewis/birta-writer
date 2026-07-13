/**
 * Resting block-handle mode: normalization, the mode → body-class map, the
 * legacy `gutterMarkers` migration mapping, and drift guards against the two
 * places the modes are declared outside this module — the
 * `birta.blockHandles` enum in package.json (what the Settings UI
 * offers) and the `body.handles-rest-*` rules in style.css (what the classes
 * actually do).
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
    BLOCK_HANDLES_MODES,
    BLOCK_HANDLES_BODY_CLASSES,
    BLOCK_HANDLES_DISPLAY_ORDER,
    DEFAULT_BLOCK_HANDLES_MODE,
    normalizeBlockHandlesMode,
    blockHandlesBodyClass,
    blockHandlesModeFromLegacy,
} from "../blockHandles";

const root = path.resolve(__dirname, "../..");

describe("normalizeBlockHandlesMode", () => {
    it("a known mode should pass through unchanged", () => {
        expect(normalizeBlockHandlesMode("headings")).toBe("headings");
        expect(normalizeBlockHandlesMode("hover")).toBe("hover");
        expect(normalizeBlockHandlesMode("always")).toBe("always");
    });

    it("an unknown value should fall back to the default mode", () => {
        expect(normalizeBlockHandlesMode("none")).toBe(DEFAULT_BLOCK_HANDLES_MODE);
        expect(normalizeBlockHandlesMode(undefined)).toBe(DEFAULT_BLOCK_HANDLES_MODE);
        expect(normalizeBlockHandlesMode(null)).toBe(DEFAULT_BLOCK_HANDLES_MODE);
        expect(normalizeBlockHandlesMode(3)).toBe(DEFAULT_BLOCK_HANDLES_MODE);
    });
});

describe("blockHandlesBodyClass", () => {
    it("the default mode should map to no class (the stylesheet baseline)", () => {
        expect(blockHandlesBodyClass("headings")).toBeNull();
    });

    it("the override modes should map to their handles-rest-* classes", () => {
        expect(blockHandlesBodyClass("hover")).toBe("handles-rest-hover");
        expect(blockHandlesBodyClass("always")).toBe("handles-rest-always");
    });

    it("an out-of-enum value should behave as the default mode", () => {
        expect(blockHandlesBodyClass("garbage" as never)).toBeNull();
    });
});

describe("blockHandlesModeFromLegacy", () => {
    it("each legacy gutterMarkers value should map to its renamed mode", () => {
        expect(blockHandlesModeFromLegacy("none")).toBe("hover");
        expect(blockHandlesModeFromLegacy("all")).toBe("always");
        expect(blockHandlesModeFromLegacy("headings")).toBe("headings");
    });

    it("a non-legacy value should map to null", () => {
        expect(blockHandlesModeFromLegacy("hover")).toBeNull();
        expect(blockHandlesModeFromLegacy(undefined)).toBeNull();
        expect(blockHandlesModeFromLegacy(3)).toBeNull();
    });
});

describe("BLOCK_HANDLES_DISPLAY_ORDER", () => {
    it("the display order should be a permutation of the modes", () => {
        expect([...BLOCK_HANDLES_DISPLAY_ORDER].sort()).toEqual([...BLOCK_HANDLES_MODES].sort());
    });
});

describe("contributed setting drift guards", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const prop = pkg.contributes.configuration.properties["birta.blockHandles"];

    it("the package.json enum should list exactly the shared modes", () => {
        expect(prop, "birta.blockHandles is not contributed").toBeDefined();
        expect(prop.enum).toEqual([...BLOCK_HANDLES_MODES]);
    });

    it("the package.json default should match the shared default", () => {
        expect(prop.default).toBe(DEFAULT_BLOCK_HANDLES_MODE);
    });

    it("the legacy gutterMarkers setting should no longer be contributed", () => {
        expect(pkg.contributes.configuration.properties["birta.gutterMarkers"]).toBeUndefined();
    });

    it("every override body class should have rules in style.css", () => {
        const css = fs.readFileSync(path.join(root, "webview", "style.css"), "utf8");
        for (const cls of Object.values(BLOCK_HANDLES_BODY_CLASSES)) {
            if (cls) {
                expect(css, `style.css has no rule for body.${cls}`).toContain(`body.${cls}`);
            }
        }
    });
});
