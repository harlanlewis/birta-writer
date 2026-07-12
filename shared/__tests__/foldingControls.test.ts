/**
 * The fold-affordance derivation (MAR-110): `editor.showFoldingControls` /
 * `editor.folding` map onto body classes, no extension setting of their own.
 */
import { describe, it, expect } from "vitest";
import {
    DEFAULT_FOLDING_CONTROLS_MODE,
    FOLDING_DISABLED_BODY_CLASS,
    foldingBodyClasses,
    normalizeFoldingControlsMode,
} from "../foldingControls";

describe("normalizeFoldingControlsMode", () => {
    it("known modes should pass through unchanged", () => {
        expect(normalizeFoldingControlsMode("mouseover")).toBe("mouseover");
        expect(normalizeFoldingControlsMode("always")).toBe("always");
        expect(normalizeFoldingControlsMode("never")).toBe("never");
    });

    it("unknown or missing values should fall back to the default", () => {
        expect(normalizeFoldingControlsMode("sometimes")).toBe(DEFAULT_FOLDING_CONTROLS_MODE);
        expect(normalizeFoldingControlsMode(undefined)).toBe(DEFAULT_FOLDING_CONTROLS_MODE);
        expect(normalizeFoldingControlsMode(42)).toBe(DEFAULT_FOLDING_CONTROLS_MODE);
    });
});

describe("foldingBodyClasses", () => {
    it("the default mouseover mode should emit no class (the stylesheet baseline)", () => {
        expect(foldingBodyClasses("mouseover", true)).toEqual([]);
    });

    it("always and never should emit their override classes", () => {
        expect(foldingBodyClasses("always", true)).toEqual(["fold-controls-always"]);
        expect(foldingBodyClasses("never", true)).toEqual(["fold-controls-never"]);
    });

    it("folding disabled should emit only the disabled class regardless of mode", () => {
        expect(foldingBodyClasses("always", false)).toEqual([FOLDING_DISABLED_BODY_CLASS]);
        expect(foldingBodyClasses("mouseover", false)).toEqual([FOLDING_DISABLED_BODY_CLASS]);
    });
});
