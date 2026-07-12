/**
 * Resting gutter-marker mode: normalization, the mode → body-class map, and
 * drift guards against the two places the modes are declared outside this
 * module — the `markdownWysiwyg.gutterMarkers` enum in package.json (what
 * the Settings UI offers) and the `body.gutter-rest-*` rules in style.css
 * (what the classes actually do).
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
    GUTTER_MARKERS_MODES,
    GUTTER_MARKERS_BODY_CLASSES,
    DEFAULT_GUTTER_MARKERS_MODE,
    normalizeGutterMarkersMode,
    gutterMarkersBodyClass,
} from "../gutterMarkers";

const root = path.resolve(__dirname, "../..");

describe("normalizeGutterMarkersMode", () => {
    it("a known mode should pass through unchanged", () => {
        expect(normalizeGutterMarkersMode("headings")).toBe("headings");
        expect(normalizeGutterMarkersMode("none")).toBe("none");
        expect(normalizeGutterMarkersMode("all")).toBe("all");
    });

    it("an unknown value should fall back to the default mode", () => {
        expect(normalizeGutterMarkersMode("hover")).toBe(DEFAULT_GUTTER_MARKERS_MODE);
        expect(normalizeGutterMarkersMode(undefined)).toBe(DEFAULT_GUTTER_MARKERS_MODE);
        expect(normalizeGutterMarkersMode(null)).toBe(DEFAULT_GUTTER_MARKERS_MODE);
        expect(normalizeGutterMarkersMode(3)).toBe(DEFAULT_GUTTER_MARKERS_MODE);
    });
});

describe("gutterMarkersBodyClass", () => {
    it("the default mode should map to no class (the stylesheet baseline)", () => {
        expect(gutterMarkersBodyClass("headings")).toBeNull();
    });

    it("the override modes should map to their gutter-rest-* classes", () => {
        expect(gutterMarkersBodyClass("none")).toBe("gutter-rest-none");
        expect(gutterMarkersBodyClass("all")).toBe("gutter-rest-all");
    });

    it("an out-of-enum value should behave as the default mode", () => {
        expect(gutterMarkersBodyClass("garbage" as never)).toBeNull();
    });
});

describe("contributed setting drift guards", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const prop = pkg.contributes.configuration.properties["markdownWysiwyg.gutterMarkers"];

    it("the package.json enum should list exactly the shared modes", () => {
        expect(prop, "markdownWysiwyg.gutterMarkers is not contributed").toBeDefined();
        expect(prop.enum).toEqual([...GUTTER_MARKERS_MODES]);
    });

    it("the package.json default should match the shared default", () => {
        expect(prop.default).toBe(DEFAULT_GUTTER_MARKERS_MODE);
    });

    it("every override body class should have rules in style.css", () => {
        const css = fs.readFileSync(path.join(root, "webview", "style.css"), "utf8");
        for (const cls of Object.values(GUTTER_MARKERS_BODY_CLASSES)) {
            if (cls) {
                expect(css, `style.css has no rule for body.${cls}`).toContain(`body.${cls}`);
            }
        }
    });
});
