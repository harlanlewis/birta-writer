import { describe, it, expect } from "vitest";
import {
    normalizeContentWidthMode,
    clampMaxWidthCh,
    resolveContentWidth,
    DEFAULT_CONTENT_WIDTH_MODE,
    DEFAULT_MAX_WIDTH_CH,
    MIN_MAX_WIDTH_CH,
} from "../contentWidth";

describe("normalizeContentWidthMode", () => {
    it("a known mode should pass through unchanged", () => {
        expect(normalizeContentWidthMode("full")).toBe("full");
        expect(normalizeContentWidthMode("fixed")).toBe("fixed");
    });

    it("an unknown value should fall back to the default mode", () => {
        expect(normalizeContentWidthMode("auto")).toBe(DEFAULT_CONTENT_WIDTH_MODE);
        expect(normalizeContentWidthMode(undefined)).toBe(DEFAULT_CONTENT_WIDTH_MODE);
        expect(normalizeContentWidthMode(120)).toBe(DEFAULT_CONTENT_WIDTH_MODE);
    });
});

describe("clampMaxWidthCh", () => {
    it("an undefined value should fall back to the default", () => {
        expect(clampMaxWidthCh(undefined)).toBe(DEFAULT_MAX_WIDTH_CH);
    });

    it("a value below the floor should clamp up to the minimum", () => {
        expect(clampMaxWidthCh(4)).toBe(MIN_MAX_WIDTH_CH);
    });

    it("a fractional value should round to a whole character", () => {
        expect(clampMaxWidthCh(90.4)).toBe(90);
    });
});

describe("resolveContentWidth", () => {
    it("full should resolve to no cap and the full-width layout", () => {
        const r = resolveContentWidth("full", 120);
        expect(r.cssValue).toBe("none");
        expect(r.isAuto).toBe(true);
        expect(r.mode).toBe("full");
    });

    it("fixed should cap at the configured ch measure", () => {
        const r = resolveContentWidth("fixed", 120);
        expect(r.cssValue).toBe("120ch");
        expect(r.isAuto).toBe(false);
        expect(r.mode).toBe("fixed");
    });

    it("fixed below the floor should clamp up to the minimum", () => {
        const r = resolveContentWidth("fixed", 5);
        expect(r.cssValue).toBe(`${MIN_MAX_WIDTH_CH}ch`);
    });
});
