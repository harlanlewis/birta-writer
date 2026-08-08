/**
 * Ordered-list numbering vocabulary (utils/orderedMarkers.ts): the marker
 * spellings the gutter measures its width from, and which typed markers start a
 * styled list. Nothing here renders — the browser draws the markers from
 * `list-style-type` — so these are checked against CSS's own counter styles.
 */
import { describe, expect, it } from "vitest";
import {
    ORDERED_NUMBERINGS,
    isOrderedNumbering,
    orderedMarkerStart,
    orderedMarkerText,
} from "../utils/orderedMarkers";

describe("isOrderedNumbering", () => {
    it("every offered style should validate, and nothing else should", () => {
        for (const style of ORDERED_NUMBERINGS) {
            expect(isOrderedNumbering(style)).toBe(true);
        }
        for (const junk of ["", "alpha", "lower_alpha", "LOWER-ALPHA", 1, null, undefined, {}]) {
            expect(isOrderedNumbering(junk)).toBe(false);
        }
    });
});

describe("orderedMarkerText", () => {
    it("decimal should spell the number itself", () => {
        expect(orderedMarkerText(1, "decimal")).toBe("1");
        expect(orderedMarkerText(42, "decimal")).toBe("42");
    });

    it("lower-alpha should use CSS's bijective base-26, so 26 is z and 27 is aa", () => {
        expect(orderedMarkerText(1, "lower-alpha")).toBe("a");
        expect(orderedMarkerText(26, "lower-alpha")).toBe("z");
        expect(orderedMarkerText(27, "lower-alpha")).toBe("aa");
        // 52 is `az` and 53 is `ba` — the sequence counts within each place,
        // so `zz` is 702 (26 × 26 + 26) and the three-letter run opens at 703.
        expect(orderedMarkerText(52, "lower-alpha")).toBe("az");
        expect(orderedMarkerText(53, "lower-alpha")).toBe("ba");
        expect(orderedMarkerText(702, "lower-alpha")).toBe("zz");
        expect(orderedMarkerText(703, "lower-alpha")).toBe("aaa");
    });

    it("upper-alpha should be the lower spelling, uppercased", () => {
        expect(orderedMarkerText(1, "upper-alpha")).toBe("A");
        expect(orderedMarkerText(27, "upper-alpha")).toBe("AA");
    });

    it("lower-roman should spell subtractive numerals", () => {
        expect(orderedMarkerText(1, "lower-roman")).toBe("i");
        expect(orderedMarkerText(4, "lower-roman")).toBe("iv");
        expect(orderedMarkerText(8, "lower-roman")).toBe("viii");
        expect(orderedMarkerText(9, "lower-roman")).toBe("ix");
        expect(orderedMarkerText(14, "lower-roman")).toBe("xiv");
        expect(orderedMarkerText(1987, "lower-roman")).toBe("mcmlxxxvii");
    });

    it("upper-roman should be the lower spelling, uppercased", () => {
        expect(orderedMarkerText(4, "upper-roman")).toBe("IV");
        expect(orderedMarkerText(2026, "upper-roman")).toBe("MMXXVI");
    });

    /**
     * Width is what the gutter offsets by, so the boundary that matters is a
     * styled marker wider than the number it replaces. A digit count cannot see
     * it.
     */
    it("a roman marker should be wider than its decimal equivalent where it is", () => {
        expect(orderedMarkerText(8, "lower-roman").length).toBe(4);
        expect(String(8).length).toBe(1);
        expect(orderedMarkerText(3, "lower-roman").length).toBe(3);
    });

    it("outside CSS's roman range it should fall back to decimal, as CSS does", () => {
        expect(orderedMarkerText(0, "lower-roman")).toBe("0");
        expect(orderedMarkerText(4000, "lower-roman")).toBe("4000");
        expect(orderedMarkerText(-3, "lower-roman")).toBe("-3");
    });

    it("a non-positive alpha ordinal should fall back to decimal rather than loop", () => {
        expect(orderedMarkerText(0, "lower-alpha")).toBe("0");
        expect(orderedMarkerText(-1, "upper-alpha")).toBe("-1");
    });
});

describe("orderedMarkerStart", () => {
    it("the four sequence-starting markers should each name their style", () => {
        expect(orderedMarkerStart("a")).toBe("lower-alpha");
        expect(orderedMarkerStart("A")).toBe("upper-alpha");
        expect(orderedMarkerStart("i")).toBe("lower-roman");
        expect(orderedMarkerStart("I")).toBe("upper-roman");
    });

    it("`i` should read as ROMAN one, not the ninth letter", () => {
        // The ambiguity is real and this is the resolution Pandoc also makes.
        // Nobody opens a lettered list at its ninth item.
        expect(orderedMarkerStart("i")).toBe("lower-roman");
    });

    it("a marker that does not START a sequence should be declined", () => {
        // In prose only "begin a list" is a safe reading; a later marker is the
        // retype path's business, and it knows the list it is already in.
        for (const text of ["b", "c", "z", "B", "ii", "iv", "IV", "1", "", "aa"]) {
            expect(orderedMarkerStart(text)).toBeNull();
        }
    });
});
