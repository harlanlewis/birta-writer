/**
 * The heading gutter shows the literal Markdown hashes (`#`..`######`) as a
 * level cue, replacing the older `#H1`..`#H6` badge.
 */
import { describe, it, expect } from "vitest";
import { headingMarker } from "../plugins/headingFold";

describe("headingMarker", () => {
    it("each level should render that many hashes", () => {
        expect(headingMarker(1)).toBe("#");
        expect(headingMarker(2)).toBe("##");
        expect(headingMarker(3)).toBe("###");
        expect(headingMarker(6)).toBe("######");
    });

    it("should never render the old H-prefixed badge", () => {
        for (let level = 1; level <= 6; level++) {
            expect(headingMarker(level)).not.toContain("H");
            expect(headingMarker(level)).toBe("#".repeat(level));
        }
    });

    it("out-of-range levels should clamp to the 1..6 heading range", () => {
        expect(headingMarker(0)).toBe("#");
        expect(headingMarker(9)).toBe("######");
    });
});
