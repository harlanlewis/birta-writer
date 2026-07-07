import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
    FONT_PRESET_STACKS,
    resolveFontFamily,
    resolveFontStacks,
    DEFAULT_FONT_PRESET,
    DEFAULT_FONT_SIZE_PERCENT,
    MIN_FONT_SIZE_PERCENT,
    MAX_FONT_SIZE_PERCENT,
    FONT_SIZE_STEP_PERCENT,
    clampFontSizePercent,
    stepFontSizePercent,
} from "../fontPresets";

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const props: Record<string, { default?: unknown }> = pkg.contributes.configuration.properties;

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

    it("a custom stacks argument should win over the built-in stack", () => {
        const stacks = { ...FONT_PRESET_STACKS, serif: "My Serif, serif" };
        expect(resolveFontFamily("serif", "", stacks)).toBe("My Serif, serif");
        expect(resolveFontFamily("sans", "", stacks)).toBe(FONT_PRESET_STACKS.sans);
    });
});

describe("resolveFontStacks", () => {
    it("a non-blank override should replace the built-in stack for that preset only", () => {
        const stacks = resolveFontStacks({ serif: "My Serif, serif" });
        expect(stacks.serif).toBe("My Serif, serif");
        expect(stacks.sans).toBe(FONT_PRESET_STACKS.sans);
        expect(stacks.mono).toBe(FONT_PRESET_STACKS.mono);
    });

    it("blank or missing overrides should fall back to the built-in stacks", () => {
        expect(resolveFontStacks({})).toEqual(FONT_PRESET_STACKS);
        expect(resolveFontStacks({ sans: "   ", serif: "", mono: undefined })).toEqual(FONT_PRESET_STACKS);
    });
});

describe("font contributed defaults", () => {
    it("the fontPreset default should match DEFAULT_FONT_PRESET", () => {
        expect(props["markdownWysiwyg.fontPreset"]?.default).toBe(DEFAULT_FONT_PRESET);
    });

    it("the per-preset stack defaults should match the built-in stacks", () => {
        // The settings ship pre-populated with the real stacks (not blank), so
        // users can see and edit them; they must not drift from the code.
        expect(props["markdownWysiwyg.fontFamilySans"]?.default).toBe(FONT_PRESET_STACKS.sans);
        expect(props["markdownWysiwyg.fontFamilySerif"]?.default).toBe(FONT_PRESET_STACKS.serif);
        expect(props["markdownWysiwyg.fontFamilyMono"]?.default).toBe(FONT_PRESET_STACKS.mono);
    });
});

describe("clampFontSizePercent", () => {
    it("a value inside the range should be returned rounded to a whole percent", () => {
        expect(clampFontSizePercent(110)).toBe(110);
        expect(clampFontSizePercent(112.4)).toBe(112);
    });

    it("values outside the range should clamp to the min/max bounds", () => {
        expect(clampFontSizePercent(MIN_FONT_SIZE_PERCENT - 1)).toBe(MIN_FONT_SIZE_PERCENT);
        expect(clampFontSizePercent(MAX_FONT_SIZE_PERCENT + 500)).toBe(MAX_FONT_SIZE_PERCENT);
    });

    it("a non-numeric or non-finite value should fall back to the default", () => {
        expect(clampFontSizePercent(undefined)).toBe(DEFAULT_FONT_SIZE_PERCENT);
        expect(clampFontSizePercent("120")).toBe(DEFAULT_FONT_SIZE_PERCENT);
        expect(clampFontSizePercent(NaN)).toBe(DEFAULT_FONT_SIZE_PERCENT);
        expect(clampFontSizePercent(Infinity)).toBe(DEFAULT_FONT_SIZE_PERCENT);
    });
});

describe("stepFontSizePercent", () => {
    it("a step up/down should move by the step size", () => {
        expect(stepFontSizePercent(100, 1)).toBe(100 + FONT_SIZE_STEP_PERCENT);
        expect(stepFontSizePercent(100, -1)).toBe(100 - FONT_SIZE_STEP_PERCENT);
    });

    it("a step at the bounds should stay clamped", () => {
        expect(stepFontSizePercent(MAX_FONT_SIZE_PERCENT, 1)).toBe(MAX_FONT_SIZE_PERCENT);
        expect(stepFontSizePercent(MIN_FONT_SIZE_PERCENT, -1)).toBe(MIN_FONT_SIZE_PERCENT);
    });

    it("an invalid current value should step from the default", () => {
        expect(stepFontSizePercent(NaN, 1)).toBe(DEFAULT_FONT_SIZE_PERCENT + FONT_SIZE_STEP_PERCENT);
    });
});

describe("fontSize contributed defaults", () => {
    it("code constants should match the markdownWysiwyg.fontSize contribution", () => {
        // Drift guard: the Settings UI shows package.json's default/min/max;
        // the code constants must agree or the toolbar stepper and the
        // Settings UI would disagree about the valid range.
        const root = path.resolve(__dirname, "../..");
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        const prop = pkg.contributes.configuration.properties["markdownWysiwyg.fontSize"];
        expect(prop).toBeDefined();
        expect(prop.default).toBe(DEFAULT_FONT_SIZE_PERCENT);
        expect(prop.minimum).toBe(MIN_FONT_SIZE_PERCENT);
        expect(prop.maximum).toBe(MAX_FONT_SIZE_PERCENT);
    });
});
