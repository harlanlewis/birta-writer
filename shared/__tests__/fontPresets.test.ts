import { describe, it, expect } from "vitest";
import { FONT_PRESET_STACKS, resolveFontFamily } from "../fontPresets";

describe("resolveFontFamily", () => {
    it("a non-default preset should win over a custom font family", () => {
        // Act
        const result = resolveFontFamily("serif", "Comic Sans MS");

        // Assert
        expect(result).toBe(FONT_PRESET_STACKS.serif);
    });

    it("each non-default preset should return its own stack", () => {
        expect(resolveFontFamily("sans", "")).toBe(FONT_PRESET_STACKS.sans);
        expect(resolveFontFamily("serif", "")).toBe(FONT_PRESET_STACKS.serif);
        expect(resolveFontFamily("mono", "")).toBe(FONT_PRESET_STACKS.mono);
    });

    it("the default preset with a custom family should return that family", () => {
        // Act
        const result = resolveFontFamily("default", "Georgia, serif");

        // Assert
        expect(result).toBe("Georgia, serif");
    });

    it("the default preset with a whitespace-only family should return null", () => {
        expect(resolveFontFamily("default", "   ")).toBeNull();
    });

    it("the default preset with an empty family should return null (inherit editor font)", () => {
        expect(resolveFontFamily("default", "")).toBeNull();
    });
});
