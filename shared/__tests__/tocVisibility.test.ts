import { describe, it, expect } from "vitest";
import {
    normalizeTocVisibility,
    DEFAULT_TOC_VISIBILITY,
    TOC_VISIBILITY_VALUES,
} from "../tocVisibility";

describe("normalizeTocVisibility", () => {
    it("a valid 'shown' value should pass through", () => {
        expect(normalizeTocVisibility("shown")).toBe("shown");
    });

    it("a valid 'hidden' value should pass through", () => {
        expect(normalizeTocVisibility("hidden")).toBe("hidden");
    });

    it("'auto' should pass through as the default", () => {
        expect(normalizeTocVisibility("auto")).toBe("auto");
    });

    it("an unknown string (settings.json typo) should fall back to auto", () => {
        expect(normalizeTocVisibility("shwon")).toBe("auto");
    });

    it("a non-string value should fall back to auto", () => {
        expect(normalizeTocVisibility(undefined)).toBe("auto");
        expect(normalizeTocVisibility(null)).toBe("auto");
        expect(normalizeTocVisibility(1)).toBe("auto");
    });

    it("the default should be auto and listed first in the Settings-UI order", () => {
        expect(DEFAULT_TOC_VISIBILITY).toBe("auto");
        expect(TOC_VISIBILITY_VALUES).toEqual(["auto", "shown", "hidden"]);
    });
});
