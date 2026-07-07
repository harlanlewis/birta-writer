/**
 * shared/fontPresets.ts
 * Editor content font presets shared by the extension (startup injection +
 * live config broadcast) and the webview (toolbar font picker).
 */
import type { FontPreset, FontStacks } from "./messages";

/**
 * The default content-font preset. Must stay in sync with the
 * `markdownWysiwyg.fontPreset` default declared in package.json. Import this in
 * every `getConfiguration().get("fontPreset", …)` call so the code fallback
 * can never diverge from the contributed default.
 */
export const DEFAULT_FONT_PRESET: FontPreset = "sans";

/**
 * Content font size, as a percentage of the VS Code editor font size.
 * A relative scale (rather than a fixed px value) keeps the content tracking
 * the user's `editor.fontSize` and window zoom; 100 means "same as the editor".
 * The default must stay in sync with the `markdownWysiwyg.fontSize` default
 * declared in package.json.
 */
export const DEFAULT_FONT_SIZE_PERCENT = 100;
export const MIN_FONT_SIZE_PERCENT = 50;
export const MAX_FONT_SIZE_PERCENT = 200;
/** Step used by the toolbar's A− / A+ buttons. */
export const FONT_SIZE_STEP_PERCENT = 10;

/** Clamp any config/message value to a valid whole font-size percentage. */
export function clampFontSizePercent(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return DEFAULT_FONT_SIZE_PERCENT;
    }
    return Math.min(MAX_FONT_SIZE_PERCENT, Math.max(MIN_FONT_SIZE_PERCENT, Math.round(value)));
}

/** One A− / A+ step from `current`, clamped to the valid range. */
export function stepFontSizePercent(current: number, direction: 1 | -1): number {
    return clampFontSizePercent(clampFontSizePercent(current) + direction * FONT_SIZE_STEP_PERCENT);
}

/**
 * Built-in font-family stacks for the non-default presets. These are also the
 * contributed defaults of the `markdownWysiwyg.fontFamilySans/Serif/Mono`
 * settings (drift-guarded by a test), so users see — and can edit — the real
 * stack in the Settings UI rather than an empty field.
 */
export const FONT_PRESET_STACKS: FontStacks = {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif',
    serif: '"Iowan Old Style", "Palatino", Charter, ui-serif, Georgia, serif',
    mono: 'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace',
};

/**
 * The effective per-preset stacks: the user's `fontFamilySans/Serif/Mono`
 * setting when non-blank, else the built-in stack.
 */
export function resolveFontStacks(overrides: Partial<Record<keyof FontStacks, string>>): FontStacks {
    const pick = (key: keyof FontStacks): string => {
        const custom = overrides[key]?.trim();
        return custom ? custom : FONT_PRESET_STACKS[key];
    };
    return { sans: pick("sans"), serif: pick("serif"), mono: pick("mono") };
}

/**
 * Resolve the effective content font-family for a preset.
 *
 * A non-default preset always wins over the user's custom `fontFamily` string
 * (otherwise the toolbar picker would silently do nothing for users who set a
 * custom font). "default" falls back to the custom family when set, else null
 * — meaning "inherit the VS Code editor font".
 */
export function resolveFontFamily(
    preset: FontPreset,
    customFontFamily: string,
    stacks: FontStacks = FONT_PRESET_STACKS,
): string | null {
    if (preset !== "default") {
        return stacks[preset];
    }
    const trimmed = customFontFamily.trim();
    return trimmed ? trimmed : null;
}
